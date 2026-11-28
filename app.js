'use strict';

/* =====================================================================
   锐评 · 前端逻辑
   数据在 Supabase：
     boards（库）/ profiles（用户，每人属于一个库）/ restaurants（餐厅，属于某个库和地区）
     图片在 Storage 的 photos 桶里（库 id/随机名.jpg，外加一张 .thumb.jpg 缩略图）
   绑定的两个人共用一个库：一个人加的餐厅，另一个人的待评区里也有。
   每家餐厅只有一个等级（1–10，null = 待评），网页上可以切换「夯拉 / 字母 / 数字」三种显示样式。
   ===================================================================== */

const cfg = window.FOODRANK_CONFIG || {};

/* ---------- 评级：10 个等级，三种样式 ---------- */
// 字母样式：下标 = 等级（10 最好，1 最差）
const LETTERS = [null, 'F', 'E', 'D-', 'D', 'C-', 'C', 'B-', 'B', 'A-', 'A'];
// 夯拉样式：左边只有「从夯到拉」原本的 5 档，每档占右边两行 ——
// 上面一行是这一档本身，下面一行是它和下一档之间（比如 9 就是夯和顶级之间）
const TIER_BLOCKS = [
  { name: '夯', top: 10 }, // 10、9
  { name: '顶级', top: 8 }, // 8、7
  { name: '人上人', top: 6 }, // 6、5
  { name: 'NPC', top: 4 }, // 4、3
  { name: '拉完了', top: 2 }, // 2、1
];
const blockTop = (level) => level + (level % 2); // 某个等级在哪一档：9 → 10（夯），8 → 8（顶级）
const tierName = (level) => TIER_BLOCKS.find((b) => b.top === blockTop(level)).name;
const LEVELS_BEST_FIRST = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const STYLES = ['tier', 'letter', 'number'];

const REGIONS = { ottawa: 'Ottawa', toronto: 'Toronto' };
const STYLE_KEY = 'ruiping.ratingStyle';
const REGION_KEY = 'ruiping.region';

const USERNAME_RE = /^[a-z0-9]{3,20}$/;
// Supabase 登录必须用邮箱，所以把「用户名」转成一个内部邮箱（不会真的发邮件）
const EMAIL_DOMAIN = cfg.accountEmailDomain || 'fromhang2la.app';
const BUCKET = 'photos';
const MAX_PHOTOS = 3;
const MAX_DETAIL = 120;
const MAX_FILE_MB = 20;
const THUMB_PX = 360;

/* ---------- 状态 ---------- */
let sb = null;
const state = { user: null, me: null, profiles: [], boardId: null, restaurants: [], loaded: false, loadedAt: 0, loadError: null };
let ratingStyle = STYLES.includes(lsGet(STYLE_KEY)) ? lsGet(STYLE_KEY) : 'tier';
let region = REGIONS[lsGet(REGION_KEY)] ? lsGet(REGION_KEY) : 'ottawa';
let editing = null; // 编辑模式：{ ids: [...], pending: Map(id → 等级或 null) }
let detailId = null;
let authMode = 'login';
let form = null; // 添加 / 编辑弹窗：{ id, photos: [...], removed: [...] }
let drag = null;

/* ---------- 工具 ---------- */
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cssUrl = (u) => `url("${String(u).replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
const today = () => new Date().toLocaleDateString('en-CA');
const emailOf = (username) => `${username}@${EMAIL_DOMAIN}`;
const byCreated = (a, b) => (a.created_at || '').localeCompare(b.created_at || '');

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { /* 无痕模式等 */ } }

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// 某个等级在当前样式下的文字
function levelLabel(level, style = ratingStyle) {
  if (style === 'number') return String(level);
  if (style === 'letter') return LETTERS[level];
  return tierName(level);
}
// 细节弹窗左上角的小方格：字母样式显示字母，其他样式显示数字（「拉完了」这种放不进方格）
const boxLabel = (level) => (ratingStyle === 'letter' ? LETTERS[level] : String(level));

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2400);
}

function errMsg(e) {
  const m = (e && (e.message || e.error_description || e.error)) || String(e);
  if (/Invalid login credentials/i.test(m)) return '用户名或密码不对';
  if (/already registered|already exists|profiles_username_key|Database error saving new user/i.test(m)) return '这个用户名已经被注册了，换一个吧';
  if (/Email not confirmed/i.test(m)) return '这个网站还开着「邮箱确认」，请在 Supabase 里关掉 Confirm email';
  if (/email.*invalid|invalid.*email/i.test(m)) return '注册失败：Supabase 不接受内部邮箱格式，请看 README 的「常见问题」';
  if (/Password should be at least/i.test(m)) return '密码至少 6 位';
  if (/rate limit/i.test(m)) return '操作太频繁了，请过一会儿再试';
  if (/exceeded the maximum allowed size|Payload too large/i.test(m)) return `图片太大了，每张最多 ${MAX_FILE_MB} MB`;
  if (/mime type/i.test(m)) return '这种图片格式不支持，请换成 JPG 或 PNG';
  if (/Bucket not found/i.test(m)) return '还没有建图片存储，请按 README 运行 schema.sql';
  if (/row-level security|permission denied/i.test(m)) return '没有权限做这个操作';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return '网络连接失败，请检查网络';
  return m;
}

async function must(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// 按钮防重复提交
async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } catch (e) { console.error(e); toast(errMsg(e), true); } finally { btn.disabled = false; }
}

/* ---------- 派生数据 ---------- */
const byId = (id) => state.restaurants.find((r) => r.id === id);
const nameOf = (id) => state.profiles.find((p) => p.id === id)?.username || '某人';
const isMember = () => !!state.me && state.me.board_id === state.boardId;
const boardMembers = () => state.profiles.filter((p) => p.board_id === state.boardId).sort(byCreated);
const partners = () => (state.me ? state.profiles.filter((p) => p.board_id === state.me.board_id && p.id !== state.me.id) : []);
const inRegion = () => state.restaurants.filter((r) => r.region === region);
// 排好的：同一批（同一次「完成」）的按添加时间从左往右，新的一批放在旧的前面
const rankedAt = (level) => inRegion()
  .filter((r) => r.level === level)
  .sort((a, b) => (b.ranked_at || '').localeCompare(a.ranked_at || '') || byCreated(a, b));
const poolItems = () => inRegion().filter((r) => r.level == null).sort(byCreated);
// 编辑模式里某一档（null = 待评区）放着的餐厅：只有这次从待评区拖出来的
const editItems = (level) => editing.ids
  .filter((id) => editing.pending.get(id) === level)
  .map(byId).filter(Boolean).sort(byCreated);

const photoUrl = (path) => (path ? sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : '');
const coverOf = (r) => (r.photos && r.photos[0] ? photoUrl(r.photos[0].thumb || r.photos[0].src) : '');

/* ---------- 启动 ---------- */
function configProblem() {
  const url = cfg.supabaseUrl || '';
  const key = cfg.supabaseAnonKey || '';
  if (!url || !key || url.includes('YOUR_') || key.includes('YOUR_')) return null; // 走「还没配置」提示
  if (key.startsWith('sb_secret_')) return 'config.js 里填的是 secret key，这个绝对不能放进网页！请换成 publishable key，并去 Supabase 重新生成 secret key。';
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.role === 'service_role') return 'config.js 里填的是 service_role key，这个绝对不能放进网页！请换成 anon public key。';
  } catch { /* 不是 JWT 格式（例如 publishable key），没问题 */ }
  return '';
}

function init() {
  bindEvents();
  const problem = configProblem();
  if (problem === null) return showSetup();
  if (problem) return showSetup(problem);
  if (!window.supabase?.createClient) return showSetup('加载 Supabase 失败，请检查网络后刷新页面。');
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  $('#appView').hidden = false;
  renderAll();
  // 回调里不要直接 await supabase 调用（官方建议），所以用 setTimeout 放到下一轮
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));
}

function showSetup(msg) {
  if (msg) $('#setupMsg').textContent = msg;
  $('#setupView').hidden = false;
  $('#appView').hidden = true;
}

async function onSession(session) {
  const user = session?.user || null;
  // 登录状态没变（比如只是 token 刷新）就不用重新加载
  if (state.loaded && (state.user?.id ?? null) === (user?.id ?? null)) return;
  if (editing) exitEdit();
  state.user = user; // null = 访客，只能看
  await loadAll();
}

async function loadAll() {
  try {
    state.profiles = await must(sb.from('profiles').select('id, username, board_id, created_at'));
    state.me = state.user ? state.profiles.find((p) => p.id === state.user.id) || null : null;
    if (state.user && !state.me) toast('没找到你的用户资料，请确认已经运行了最新的 schema.sql', true);
    state.boardId = state.me ? state.me.board_id : await homeBoard();
    state.restaurants = state.boardId
      ? await must(sb.from('restaurants').select('*').eq('board_id', state.boardId))
      : [];
    state.loadError = null;
  } catch (e) {
    console.error(e);
    state.loadError = errMsg(e);
  }
  state.loaded = true;
  state.loadedAt = Date.now();
  renderAll();
}

// 访客看谁的榜：config.js 里的 homeUser；没填就看餐厅最多的那个库
async function homeBoard() {
  const home = cfg.homeUser && state.profiles.find((p) => p.username === String(cfg.homeUser).toLowerCase());
  if (home) return home.board_id;
  const rows = await must(sb.from('restaurants').select('board_id'));
  const count = {};
  rows.forEach((r) => { count[r.board_id] = (count[r.board_id] || 0) + 1; });
  const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  return best || [...state.profiles].sort(byCreated)[0]?.board_id || null;
}

/* ---------- 渲染 ---------- */
function renderAll() {
  renderChrome();
  renderBoard();
  if (detailId && $('#detailDialog').open) {
    if (byId(detailId)) renderDetail(); else closeSheet($('#detailDialog'));
  }
  if ($('#accountDialog').open) state.me ? renderAccount() : closeSheet($('#accountDialog'));
}

function renderChrome() {
  $('#regionName').textContent = REGIONS[region];
  $$('#regionMenu [data-region]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.region === region)));
  $$('#styleSeg [data-style]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === ratingStyle)));
  $('#authBtn').textContent = state.me ? state.me.username : '登录 / 注册';
  $('#editBtn').hidden = !isMember();
}

function chip(r, hit = false) {
  const cover = coverOf(r);
  return `<button type="button" class="chip${cover ? '' : ' nophoto'}${hit ? ' hit' : ''}" data-id="${esc(r.id)}"`
    + `${cover ? ` style="background-image:${esc(cssUrl(cover))}"` : ''} aria-label="${esc(r.name)}">`
    + `<span class="nm">${esc(r.name)}</span></button>`;
}

function matches(r, q) {
  if (!q) return true;
  return [r.name, ...(r.details || [])].some((s) => String(s).toLowerCase().includes(q));
}

// 搜索词（编辑模式里不搜索）
const searchQuery = () => (editing ? '' : $('#search').value.trim().toLowerCase());

function renderBoard() {
  const board = $('#board');
  const pool = $('#pool');
  if (!state.loaded) {
    board.innerHTML = '<p class="empty-note board-note">加载中…</p>';
    pool.innerHTML = '';
    $('#stats').textContent = '';
    return;
  }
  if (state.loadError) {
    board.innerHTML = `<p class="empty-note board-note">加载失败：${esc(state.loadError)}</p>`;
    pool.innerHTML = '';
    return;
  }
  const isEdit = !!editing;
  const q = searchQuery();
  // 搜索时只留下相关的餐厅（高亮，顺序不变），不相关的先藏起来
  const shown = (list) => (q ? list.filter((r) => matches(r, q)) : list);
  const tierStyle = ratingStyle === 'tier';
  const rowOf = (level) => 11 - level; // 在第几行：10 在第 1 行，1 在第 10 行
  const top = (level) => (level === 10 ? ' top' : '');

  // 左边的等级：夯拉样式 5 块，每块跨两行；字母 / 数字样式每行一个
  const labels = tierStyle
    ? TIER_BLOCKS.map((b) => `<div class="tier-label lv-${b.top}${top(b.top)}" style="grid-row:${rowOf(b.top)} / span 2">${esc(b.name)}</div>`)
    : LEVELS_BEST_FIRST.map((level) => `<div class="tier-label lv-${level}${top(level)}" style="grid-row:${rowOf(level)}">${esc(levelLabel(level))}</div>`);
  // 右边始终是 10 行。夯拉样式里，一块里的两行用同一个颜色（拖动高亮时和左边对得上），中间用虚线隔开
  const rows = LEVELS_BEST_FIRST.map((level) => {
    const items = isEdit ? editItems(level) : shown(rankedAt(level));
    const color = tierStyle ? blockTop(level) : level;
    const sub = tierStyle && level % 2 === 1 ? ' sub' : '';
    return `<div class="tier lv-${color}${items.length ? ' has' : ' empty'}${sub}${top(level)}" style="grid-row:${rowOf(level)}"${isEdit ? ` data-drop="${level}"` : ''}>`
      + `<div class="track">${items.map((r) => chip(r, !!q)).join('')}</div></div>`;
  });
  board.classList.toggle('tier-style', tierStyle);
  board.innerHTML = labels.join('') + rows.join('');

  const waiting = isEdit ? editItems(null) : shown(poolItems());
  let emptyNote;
  if (isEdit) emptyNote = editing.ids.length ? '都排好了，点左上角「完成」保存' : '待评区是空的，先添加餐厅吧';
  else if (q) emptyNote = '待评区里没有相关的餐厅';
  else emptyNote = isMember() ? '新添加的餐厅会先放在这里，点「编辑」把它们排进上面的档' : '这里是还没排的餐厅';
  pool.innerHTML = `<div class="pool-head"><span>待评 · ${waiting.length}</span>`
    + `<span>${isEdit ? '按住拖到上面' : '按添加时间'}</span></div>`
    + `<div class="track">${waiting.length ? waiting.map((r) => chip(r, !!q)).join('') : `<span class="empty-note">${emptyNote}</span>`}</div>`;
  if (isEdit) pool.dataset.drop = 'pool'; else delete pool.dataset.drop;
  pool.classList.remove('drop-hover');

  const hits = q ? inRegion().filter((r) => matches(r, q)).length : 0;
  $('#searchInfo').textContent = q ? (hits ? `找到 ${hits} 家` : '没找到相关的餐厅') : '';
  const ranked = inRegion().filter((r) => r.level != null).length;
  const owners = boardMembers().map((p) => p.username).join(' & ');
  $('#stats').textContent = `${owners ? `${owners} 的排行 · ` : ''}${REGIONS[region]} · 已排 ${ranked} 家 · 待评 ${poolItems().length} 家`;
}

function onSearchInput() {
  $('.search').classList.toggle('has-q', !!$('#search').value);
  renderBoard();
}

/* ---------- 弹窗 ---------- */
function openSheet(dlg) {
  if (!dlg.open) dlg.showModal();
}
function closeSheet(dlg) {
  if (dlg.open) dlg.close();
}
function closeAllSheets() {
  $$('dialog[open]').forEach(closeSheet);
}

/* ---------- 细节弹窗 ---------- */
function openDetail(id) {
  if (!byId(id)) return;
  detailId = id;
  renderDetail();
  openSheet($('#detailDialog'));
  requestAnimationFrame(checkNameOverflow);
}

function renderDetail() {
  const r = byId(detailId);
  if (!r) return;
  const photos = r.photos || [];
  const box = r.level
    ? `<span class="lvbox lv-${r.level}${ratingStyle === 'letter' && LETTERS[r.level].length > 1 ? ' wide' : ''}" title="${esc(levelLabel(r.level, 'tier'))}">${esc(boxLabel(r.level))}</span>`
    : '<span class="lvbox lv-none" title="还没排">待</span>';
  const n = photos.length;
  const slide = (p, i, copy) => `<div class="slide"${copy ? ' aria-hidden="true"' : ''}>`
    + `<img src="${esc(photoUrl(p.src))}" alt="${copy ? '' : esc(`${r.name} 第 ${i + 1} 张图`)}" draggable="false"></div>`;
  // 多张图时首尾相连：最前面放一张「最后一张」的副本，最后面放一张「第一张」的副本（见 setupCarousel）
  const track = n > 1
    ? slide(photos[n - 1], n - 1, true) + photos.map((p, i) => slide(p, i, false)).join('') + slide(photos[0], 0, true)
    : photos.map((p, i) => slide(p, i, false)).join('');
  const pics = n
    ? `<div class="carousel" id="carousel"><div class="slides"${n > 1 ? ' style="transform:translateX(-100%)"' : ''}>${track}</div></div>`
      + (n > 1 ? `<p class="counter" id="carouselCounter">1 / ${n}</p>` : '')
    : '<div class="no-photo">没有图片</div>';
  const details = (r.details || []).length
    ? `<div class="d-details">${r.details.map((d) => `<p>${esc(d)}</p>`).join('')}</div>`
    : '<p class="d-details muted small">还没有写细节</p>';
  const meta = `由 ${esc(nameOf(r.created_by))} 添加 · ${r.level ? `由 ${esc(nameOf(r.ranked_by))} 排序（${esc(levelLabel(r.level, 'tier'))} / ${LETTERS[r.level]} / ${r.level}）` : '还没排序'}`;
  const actions = isMember()
    ? `<div class="d-actions">
        <button type="button" class="ghost small-btn" data-act="edit">编辑</button>
        ${r.level ? '<button type="button" class="ghost small-btn" data-act="unrank">放回待评</button>' : ''}
        <button type="button" class="danger small-btn" data-act="delete">删除</button>
      </div>`
    : '';
  $('#detailBody').innerHTML = `
    <div class="d-head">
      ${box}
      <div class="d-name" id="dName">
        <h2 id="detailName">${esc(r.name)}</h2>
        <button type="button" class="name-toggle" id="nameToggle" hidden aria-label="展开完整名称" aria-expanded="false">
          <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 1.5 9 6l-5.5 4.5z" fill="currentColor"/></svg>
        </button>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    ${pics}
    ${details}
    <p class="d-meta">${meta}</p>
    ${actions}`;
  if (photos.length > 1) setupCarousel($('#carousel'), photos.length);
  requestAnimationFrame(checkNameOverflow);
}

// 名字太长：折叠成一行，后面加一个小三角，点三角展开
function checkNameOverflow() {
  const box = $('#dName');
  if (!box || box.classList.contains('open')) return;
  const h = $('h2', box);
  $('#nameToggle').hidden = h.scrollWidth <= h.clientWidth + 1;
}

// 多张图左右滑，首尾相连：在最后一张往左滑，第一张从右边接着滑进来；在第一张往右滑，最后一张从左边滑进来。
// 做法：轨道是 [最后一张的副本, 第 1 张, …, 第 n 张, 第一张的副本]，
// 滑到副本上、动画一结束，就不带动画地跳回真的那一张（两张长得一样，看不出来）。
function setupCarousel(root, n) {
  const slides = $('.slides', root);
  const counter = $('#carouselCounter');
  let p = 1; // 轨道上的位置：0 = 最后一张的副本，1..n = 真的，n + 1 = 第一张的副本
  let start = null;
  let settleTimer = 0;
  const real = () => (p === 0 ? n : p === n + 1 ? 1 : p);
  const place = (dx = 0) => { slides.style.transform = `translateX(calc(${-p * 100}% + ${dx}px))`; };
  // 不带动画直接放到位置 k（正在播的动画也会立刻结束）
  const jump = (k) => {
    slides.classList.add('dragging');
    p = k;
    place();
    void slides.offsetWidth; // 先让浏览器按这个位置画好，再把动画打开
    slides.classList.remove('dragging');
  };
  const settle = () => { // 如果停在副本上，换成真的那张
    clearTimeout(settleTimer);
    jump(real());
  };
  const moveTo = (k) => { // 带动画滑到位置 k
    p = k;
    place();
    if (counter) counter.textContent = `${real()} / ${n}`;
    // 正常是动画结束（transitionend）时换回真的那张；万一浏览器没发这个事件，过一会儿也会换
    clearTimeout(settleTimer);
    if (p === 0 || p === n + 1) settleTimer = setTimeout(settle, 450);
  };
  slides.addEventListener('transitionend', (e) => { if (e.target === slides) settle(); });
  root.addEventListener('pointerdown', (e) => {
    settle();
    start = { x: e.clientX, y: e.clientY, dx: 0, on: false, id: e.pointerId };
  });
  root.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!start.on && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
      start.on = true;
      slides.classList.add('dragging');
      try { root.setPointerCapture(e.pointerId); } catch { /* 手指已经抬起等情况，不影响滑动 */ }
    }
    if (start.on) {
      start.dx = dx;
      place(dx);
    }
  });
  const end = () => {
    if (!start) return;
    const { on, dx } = start;
    start = null;
    slides.classList.remove('dragging');
    if (on && dx < -40) moveTo(p + 1); // 往左滑：下一张（最后一张之后接第一张）
    else if (on && dx > 40) moveTo(p - 1); // 往右滑：上一张（第一张之前接最后一张）
    else place(); // 滑得不够远，弹回去
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
  root.tabIndex = 0;
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    settle();
    moveTo(p + (e.key === 'ArrowRight' ? 1 : -1));
  });
}

/* ---------- 添加 / 编辑餐厅 ---------- */
function openEditor(r = null) {
  if (!state.me) return openAuth('login', '登录后才能添加餐厅');
  if (!isMember()) return toast('只能改自己库里的餐厅', true);
  form = {
    id: r?.id || null,
    photos: (r?.photos || []).map((p) => ({ kind: 'old', src: p.src, thumb: p.thumb, preview: photoUrl(p.thumb || p.src) })),
    removed: [],
  };
  $('#editTitle').textContent = r ? '编辑餐厅' : `添加到 ${REGIONS[region]}`;
  $('#editSubmit').textContent = '完成';
  const f = $('#editForm');
  f.reset();
  f.elements.name.value = r?.name || '';
  $('#detailFields').innerHTML = '';
  (r?.details || []).forEach((d) => addDetailField(d, false));
  updateDetailEmpty();
  renderPhotoSlots();
  openSheet($('#editDialog'));
  $('#editDialog').scrollTop = 0;
}

function renderPhotoSlots() {
  const slots = form.photos.map((p, i) => `
    <div class="photo-slot">
      <img src="${esc(p.preview)}" alt="第 ${i + 1} 张图">
      ${i === 0 ? '<span class="cover-tag">封面</span>' : ''}
      <button type="button" class="icon-btn" data-rm-photo="${i}" aria-label="删掉这张图">×</button>
    </div>`).join('');
  const add = form.photos.length < MAX_PHOTOS
    ? '<button type="button" class="photo-add" id="photoAddBtn" aria-label="添加图片">+</button>'
    : '';
  $('#photoSlots').innerHTML = slots + add;
}

async function addPhotos(files) {
  for (const file of files) {
    if (form.photos.length >= MAX_PHOTOS) { toast(`最多 ${MAX_PHOTOS} 张图`); break; }
    if (!/^image\//.test(file.type || 'image/')) { toast(`「${file.name}」不是图片`, true); continue; }
    if (file.size > MAX_FILE_MB * 1024 * 1024) { toast(`「${file.name}」太大了，每张最多 ${MAX_FILE_MB} MB`, true); continue; }
    let thumb;
    try {
      thumb = await makeThumb(file);
    } catch {
      toast('这张图片浏览器打不开（可能是 HEIC 格式），请换成 JPG 或 PNG', true);
      continue;
    }
    form.photos.push({ kind: 'new', file, thumbBlob: thumb, preview: URL.createObjectURL(thumb) });
    renderPhotoSlots();
  }
}

// 缩略图：长边 360px 的 JPG，只用在标签封面和添加页预览；细节弹窗里看的是原图
async function makeThumb(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, THUMB_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s));
    c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('thumb'))), 'image/jpeg', 0.82));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function extOf(file) {
  const fromType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif' }[file.type];
  return fromType || (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
}

// 上传原图（原始尺寸，不压缩）+ 缩略图
async function uploadPhoto(p) {
  const key = `${state.boardId}/${uid()}`;
  const src = `${key}.${extOf(p.file)}`;
  const thumb = `${key}.thumb.jpg`;
  const bucket = sb.storage.from(BUCKET);
  await must(bucket.upload(src, p.file, { contentType: p.file.type || 'image/jpeg', cacheControl: '31536000', upsert: false }));
  try {
    await must(bucket.upload(thumb, p.thumbBlob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false }));
  } catch (e) {
    await bucket.remove([src]);
    throw e;
  }
  return { src, thumb };
}

// 删图片文件：如果还有别的餐厅在用（比如解绑后对方那份复制品），就留着
async function removePhotoFiles(photos) {
  for (const p of photos) {
    try {
      const users = await must(sb.from('restaurants').select('id').contains('photos', JSON.stringify([{ src: p.src }])));
      if (users.length) continue;
      await sb.storage.from(BUCKET).remove([p.src, p.thumb].filter(Boolean));
    } catch (e) {
      console.warn('删除图片文件失败', e);
    }
  }
}

function addDetailField(text = '', focus = true) {
  const wrap = document.createElement('div');
  wrap.className = 'detail-field';
  wrap.innerHTML = `<textarea rows="3" maxlength="${MAX_DETAIL}" placeholder="写点什么：推荐菜、环境、那天发生的小事…"></textarea>`
    + '<button type="button" class="icon-btn" data-rm-detail aria-label="删掉这条细节">×</button>'
    + `<span class="count">0/${MAX_DETAIL}</span>`;
  const ta = $('textarea', wrap);
  ta.value = text;
  $('.count', wrap).textContent = `${ta.value.length}/${MAX_DETAIL}`;
  $('#detailFields').append(wrap);
  updateDetailEmpty();
  if (focus) ta.focus();
}

function updateDetailEmpty() {
  $('#detailEmpty').hidden = $$('#detailFields .detail-field').length > 0;
}

async function submitEditor(e) {
  e.preventDefault();
  const f = $('#editForm');
  const name = f.elements.name.value.trim();
  if (!name) {
    toast('先写个名称', true);
    f.elements.name.focus();
    return;
  }
  const details = $$('#detailFields textarea').map((t) => t.value.trim().slice(0, MAX_DETAIL)).filter(Boolean);
  const btn = $('#editSubmit');
  await busy(btn, async () => {
    const fresh = form.photos.filter((p) => p.kind === 'new');
    const uploaded = [];
    try {
      for (const [i, p] of fresh.entries()) {
        btn.textContent = `上传图片 ${i + 1}/${fresh.length}…`;
        uploaded.push(Object.assign(p, await uploadPhoto(p)));
      }
      btn.textContent = '保存中…';
      const photos = form.photos.map((p) => ({ src: p.src, thumb: p.thumb }));
      if (form.id) {
        await must(sb.from('restaurants').update({ name, details, photos }).eq('id', form.id));
      } else {
        await must(sb.from('restaurants').insert({ board_id: state.boardId, region, name, details, photos }));
      }
    } catch (err) {
      // 存失败了：刚传上去的图删掉，不留垃圾
      if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded.flatMap((p) => [p.src, p.thumb]));
      uploaded.forEach((p) => { p.kind = 'new'; delete p.src; delete p.thumb; });
      btn.textContent = '完成';
      throw err;
    }
    const wasNew = !form.id;
    const removed = form.removed;
    form.photos.forEach((p) => p.kind === 'new' && URL.revokeObjectURL(p.preview));
    closeSheet($('#editDialog'));
    btn.textContent = '完成';
    toast(wasNew ? `「${name}」放进待评区了` : '已保存');
    await loadAll();
    if (removed.length) removePhotoFiles(removed);
    if (wasNew) $('#pool').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

/* ---------- 编辑模式（拖动排序） ---------- */
async function enterEdit() {
  if (!isMember() || editing) return;
  closeAllSheets();
  $('#regionMenu').hidden = true;
  await loadAll(); // 先拿最新的待评区（另一个人可能刚加了餐厅）
  if (!isMember()) return;
  const ids = poolItems().map((r) => r.id);
  editing = { ids, pending: new Map(ids.map((id) => [id, null])) };
  document.body.classList.add('editing');
  renderBoard();
  window.scrollTo({ top: 0 });
}

function exitEdit() {
  editing = null;
  document.body.classList.remove('editing');
  renderBoard();
}

const placedCount = () => (editing ? [...editing.pending.values()].filter((v) => v != null).length : 0);

async function finishEdit() {
  if (!editing) return;
  const items = [...editing.pending].filter(([, level]) => level != null).map(([id, level]) => ({ id, level }));
  if (!items.length) { exitEdit(); return; }
  await busy($('#doneBtn'), async () => {
    const n = await must(sb.rpc('save_ranking', { items }));
    exitEdit();
    toast(n < items.length ? `保存了 ${n} 家（有 ${items.length - n} 家刚被删掉了）` : `排好了 ${n} 家`);
    await loadAll();
  });
}

function cancelEdit() {
  if (placedCount() && !confirm('刚才排的都不保存了？')) return;
  exitEdit();
}

// 按住（手机约 0.25 秒；电脑直接拖）待评区或刚放进去的标签，拖到某一档
function onDragDown(e) {
  if (!editing || drag) return;
  const el = e.target.closest('.chip[data-id]');
  if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
  drag = {
    id: el.dataset.id, el, pid: e.pointerId, touch: e.pointerType !== 'mouse',
    x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
    active: false, target: null, slot: null, ghost: null, timer: 0, raf: 0,
  };
  if (drag.touch) drag.timer = setTimeout(startDrag, 250);
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
}

function onDragMove(e) {
  if (!drag || e.pointerId !== drag.pid) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    const d = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
    if (!drag.touch && d > 4) startDrag();
    else if (drag.touch && d > 10) endDrag(false); // 手指一按就动：是在滑动页面，不是拖
    return;
  }
  e.preventDefault();
  placeGhost();
  updateTarget();
}

function startDrag() {
  if (!drag || drag.active) return;
  drag.active = true;
  const r = drag.el.getBoundingClientRect();
  drag.offX = Math.min(Math.max(drag.x - r.left, 0), r.width);
  drag.offY = Math.min(Math.max(drag.y - r.top, 0), r.height);
  const g = drag.el.cloneNode(true);
  g.classList.add('drag-ghost');
  g.classList.remove('hit');
  g.removeAttribute('data-id');
  g.style.width = `${r.width}px`;
  g.style.height = `${r.height}px`;
  document.body.append(g);
  drag.ghost = g;
  drag.el.classList.add('lifted');
  navigator.vibrate?.(10);
  placeGhost();
  updateTarget();
  drag.raf = requestAnimationFrame(autoScroll);
}

function placeGhost() {
  drag.ghost.style.transform = `translate(${drag.x - drag.offX}px, ${drag.y - drag.offY}px) scale(1.08)`;
}

const dropLevel = (t) => (t.dataset.drop === 'pool' ? null : Number(t.dataset.drop));

// 手指所在的高度对应哪一行（手指在左边的等级列上也算；夯拉样式里一个等级跨两行，靠高度区分）。
// 待评区在最上层（编辑时贴在屏幕底部），先看它；顶上的「完成」栏挡住的地方不算。
function dropTargetAt(y) {
  const inside = (el) => { const r = el.getBoundingClientRect(); return y >= r.top && y < r.bottom; };
  const pool = $('#pool');
  if (inside(pool)) return pool;
  if (y < $('#listHead').getBoundingClientRect().bottom) return null;
  return $$('#board .tier[data-drop]').find(inside) || null;
}

// 手指对着的那一行高亮，并且在它最终会落下的位置（按添加时间）留一个虚线空位 —— 吸附
function updateTarget() {
  const t = dropTargetAt(drag.y);
  if (t === drag.target) return;
  clearTarget();
  drag.target = t;
  if (!t) return;
  t.classList.add('drop-hover');
  if (drag.el.closest('[data-drop]') === t) { drag.slot = drag.el; return; } // 还在原来那一档
  const track = $('.track', t);
  const me = byId(drag.id);
  const others = editItems(dropLevel(t)).filter((r) => r.id !== drag.id);
  const next = others.find((r) => byCreated(r, me) > 0);
  const slot = document.createElement('div');
  slot.className = 'chip slot';
  $('.empty-note', track)?.setAttribute('hidden', '');
  track.insertBefore(slot, next ? $(`.chip[data-id="${CSS.escape(next.id)}"]`, track) : null);
  drag.slot = slot;
  const tr = track.getBoundingClientRect();
  const sr = slot.getBoundingClientRect();
  if (sr.left < tr.left || sr.right > tr.right) track.scrollLeft += sr.left - tr.left - (tr.width - sr.width) / 2;
}

function clearTarget() {
  if (drag.target) {
    drag.target.classList.remove('drop-hover');
    $('.empty-note', drag.target)?.removeAttribute('hidden');
  }
  if (drag.slot && drag.slot !== drag.el) drag.slot.remove();
  drag.target = null;
  drag.slot = null;
}

// 拖到屏幕上下边缘时自动滚动
function autoScroll() {
  if (!drag || !drag.active) return;
  const top = $('#listHead').getBoundingClientRect().bottom;
  const bottom = $('#pool').getBoundingClientRect().top;
  let v = 0;
  if (drag.y < top + 36) v = -Math.min(14, Math.ceil((top + 36 - drag.y) / 3));
  else if (drag.y > bottom - 36 && drag.y < bottom) v = Math.min(14, Math.ceil((drag.y - bottom + 36) / 3));
  if (v) {
    const before = window.scrollY;
    window.scrollBy(0, v);
    if (window.scrollY !== before) { drag.target && clearTarget(); updateTarget(); }
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function onDragUp(e) { if (drag && e.pointerId === drag.pid) endDrag(true); }
function onDragCancel(e) { if (drag && e.pointerId === drag.pid) endDrag(false); }

function endDrag(commit) {
  const d = drag;
  drag = null;
  clearTimeout(d.timer);
  cancelAnimationFrame(d.raf);
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragUp);
  window.removeEventListener('pointercancel', onDragCancel);
  if (!d.active) return;
  const t = commit ? d.target : null;
  const dest = (t && d.slot) || d.el;
  const r = dest.getBoundingClientRect();
  d.ghost.classList.add('settle');
  d.ghost.style.transform = `translate(${r.left}px, ${r.top}px) scale(1)`;
  if (t && editing) editing.pending.set(d.id, dropLevel(t));
  setTimeout(() => {
    d.ghost.remove();
    d.target?.classList.remove('drop-hover');
    d.el.classList.remove('lifted');
    renderBoard();
  }, 180);
}

/* ---------- 登录 / 注册 ---------- */
function openAuth(mode = 'login', lead = '') {
  closeAllSheets();
  setAuthMode(mode);
  $('#authLead').textContent = lead;
  $('#authLead').hidden = !lead;
  openSheet($('#authDialog'));
}

function setAuthMode(mode) {
  authMode = mode;
  const f = $('#authForm');
  $$('#authDialog .tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $$('#authForm .signup-only').forEach((el) => { el.hidden = mode !== 'signup'; });
  $('#authTitle').textContent = mode === 'signup' ? '注册' : '登录';
  $('#authSubmit').textContent = mode === 'signup' ? '注册' : '登录';
  f.elements.password.autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  f.elements.password2.value = '';
  $('#authMsg').textContent = '';
  setFieldMsg('username', '');
  setFieldMsg('password2', '');
  if (mode === 'signup') checkUsername();
}

function setFieldMsg(name, text, kind = '') {
  const el = $(`#authForm .field-msg[data-for="${name}"]`);
  el.textContent = text;
  el.classList.toggle('err', kind === 'err');
  el.classList.toggle('ok', kind === 'ok');
}

let nameTimer;
let nameSeq = 0;
function checkUsername() {
  clearTimeout(nameTimer);
  if (authMode !== 'signup') return;
  const u = $('#authForm').elements.username.value.trim().toLowerCase();
  if (!u) return setFieldMsg('username', '');
  if (!USERNAME_RE.test(u)) return setFieldMsg('username', '只能用英文字母和数字，3–20 位', 'err');
  setFieldMsg('username', '检查中…');
  const seq = ++nameSeq;
  nameTimer = setTimeout(async () => {
    try {
      const taken = await usernameTaken(u);
      if (seq !== nameSeq) return;
      setFieldMsg('username', taken ? '这个用户名已经有人用了，换一个吧' : '可以用', taken ? 'err' : 'ok');
    } catch {
      if (seq === nameSeq) setFieldMsg('username', '');
    }
  }, 400);
}

async function usernameTaken(u) {
  const rows = await must(sb.from('profiles').select('id').eq('username', u).limit(1));
  return rows.length > 0;
}

function checkPasswordMatch() {
  const f = $('#authForm');
  if (authMode !== 'signup' || !f.elements.password2.value) return setFieldMsg('password2', '');
  const same = f.elements.password.value === f.elements.password2.value;
  setFieldMsg('password2', same ? '两次输入一致' : '两次输入的密码不一样', same ? 'ok' : 'err');
}

async function submitAuth(e) {
  e.preventDefault();
  const f = $('#authForm');
  const username = f.elements.username.value.trim().toLowerCase();
  const password = f.elements.password.value;
  const msg = $('#authMsg');
  msg.textContent = '';
  msg.classList.add('err');
  if (!USERNAME_RE.test(username)) { msg.textContent = '用户名只能用英文字母和数字，3–20 位'; return; }
  if (password.length < 6) { msg.textContent = '密码至少 6 位'; return; }
  if (authMode === 'signup' && password !== f.elements.password2.value) { msg.textContent = '两次输入的密码不一样'; return; }
  await busy($('#authSubmit'), async () => {
    try {
      if (authMode === 'signup') {
        if (await usernameTaken(username)) { msg.textContent = '这个用户名已经有人用了，换一个吧'; return; }
        const data = await must(sb.auth.signUp({ email: emailOf(username), password, options: { data: { username } } }));
        if (!data.session) { msg.textContent = '注册成功，但还登不进去：请在 Supabase 里关掉 Confirm email'; return; }
        toast(`注册成功，欢迎 ${username}`);
      } else {
        await must(sb.auth.signInWithPassword({ email: emailOf(username), password }));
        toast(`欢迎回来，${username}`);
      }
      f.reset();
      closeSheet($('#authDialog'));
    } catch (err) {
      msg.textContent = errMsg(err);
    }
  });
}

/* ---------- 账户 ---------- */
function openAccount() {
  if (!state.me) return openAuth('login');
  closeAllSheets();
  renderAccount();
  openSheet($('#accountDialog'));
}

function renderAccount() {
  const me = state.me;
  const mine = state.restaurants.filter((r) => r.created_by === me.id);
  const perRegion = Object.keys(REGIONS).map((k) => `<span>${REGIONS[k]}</span><b>${mine.filter((r) => r.region === k).length}</b>`).join('');
  const rankedByMe = state.restaurants.filter((r) => r.ranked_by === me.id).length;
  const others = partners();
  $('#accountBody').innerHTML = `
    <div class="sheet-head">
      <div class="acct-head">
        <div class="avatar">${esc(me.username.slice(0, 1).toUpperCase())}</div>
        <div><h2 id="accountName">${esc(me.username)}</h2><p class="muted small">用户</p></div>
      </div>
      <button type="button" class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="acct-stats">
      <div class="big">${mine.length}</div>
      <div class="muted small">一共添加过的评价</div>
      <div class="rows">${perRegion}<span>我排过的</span><b>${rankedByMe}</b></div>
    </div>
    <div class="acct-actions">
      <button type="button" class="ghost" data-act="export">导出备份</button>
      <button type="button" data-act="logout">退出登录</button>
    </div>
    <p class="acct-foot">${others.length
      ? `<button type="button" class="link" data-act="unbind">已绑定 ${esc(others.map((p) => p.username).join('、'))}，取消绑定</button>`
      : '没有和其他人绑定'}</p>`;
}

async function unbind(btn) {
  const names = partners().map((p) => p.username).join('、');
  if (!confirm(`取消和 ${names} 的绑定？\n\n解绑后你们各自保留一份现在的排行，之后各记各的，互相看不到对方新加的餐厅。`)) return;
  await busy(btn, async () => {
    await must(sb.rpc('unbind'));
    toast('已取消绑定');
    await loadAll();
  });
}

function exportBackup() {
  const data = {
    app: 'ruiping',
    version: 4,
    exported_at: new Date().toISOString(),
    board_id: state.boardId,
    members: boardMembers().map((p) => p.username),
    restaurants: state.restaurants.map((r) => ({
      ...r,
      created_by: nameOf(r.created_by),
      ranked_by: r.ranked_by ? nameOf(r.ranked_by) : null,
      photo_urls: (r.photos || []).map((p) => photoUrl(p.src)),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ruiping-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- 删除 / 放回待评 ---------- */
async function deleteRestaurant(btn) {
  const r = byId(detailId);
  if (!r || !confirm(`删除「${r.name}」？图片也会一起删掉，不能恢复。`)) return;
  await busy(btn, async () => {
    await must(sb.from('restaurants').delete().eq('id', r.id));
    closeSheet($('#detailDialog'));
    toast('已删除');
    await loadAll();
    removePhotoFiles(r.photos || []);
  });
}

async function unrank(btn) {
  const r = byId(detailId);
  if (!r) return;
  await busy(btn, async () => {
    await must(sb.rpc('save_ranking', { items: [{ id: r.id, level: null }] }));
    closeSheet($('#detailDialog'));
    toast(`「${r.name}」放回待评区了`);
    await loadAll();
  });
}

/* ---------- 事件 ---------- */
function bindEvents() {
  // 地区下拉
  $('#regionBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#regionMenu');
    menu.hidden = !menu.hidden;
    $('#regionBtn').setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#regionMenu').addEventListener('click', (e) => {
    const b = e.target.closest('[data-region]');
    if (!b) return;
    region = b.dataset.region;
    lsSet(REGION_KEY, region);
    $('#regionMenu').hidden = true;
    $('#regionBtn').setAttribute('aria-expanded', 'false');
    renderChrome();
    renderBoard();
    window.scrollTo({ top: 0 });
  });
  document.addEventListener('click', (e) => {
    if (!$('#regionMenu').hidden && !e.target.closest('.brand')) {
      $('#regionMenu').hidden = true;
      $('#regionBtn').setAttribute('aria-expanded', 'false');
    }
  });

  $('#authBtn').addEventListener('click', () => (state.me ? openAccount() : openAuth('login')));
  $('#search').addEventListener('input', onSearchInput);
  $('#searchClear').addEventListener('click', (e) => {
    e.preventDefault();
    $('#search').value = '';
    onSearchInput();
  });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('#styleSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-style]');
    if (!b) return;
    ratingStyle = b.dataset.style;
    lsSet(STYLE_KEY, ratingStyle);
    renderChrome();
    renderBoard();
  });

  $('#editBtn').addEventListener('click', enterEdit);
  $('#doneBtn').addEventListener('click', finishEdit);
  $('#cancelEditBtn').addEventListener('click', cancelEdit);

  // 标签：阅览模式点开细节；编辑模式按住拖动
  const main = $('main');
  main.addEventListener('click', (e) => {
    const el = e.target.closest('.chip[data-id]');
    if (el && !editing) openDetail(el.dataset.id);
  });
  main.addEventListener('pointerdown', onDragDown);
  main.addEventListener('contextmenu', (e) => { if (editing && e.target.closest('.chip')) e.preventDefault(); });
  document.addEventListener('touchmove', (e) => { if (drag?.active) e.preventDefault(); }, { passive: false });

  // 各种按钮（data-act）
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'home') { closeAllSheets(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else if (act === 'add') openEditor();
    else if (act === 'account') openAccount();
    else if (act === 'edit') { const r = byId(detailId); closeSheet($('#detailDialog')); openEditor(r); }
    else if (act === 'unrank') unrank(b);
    else if (act === 'delete') deleteRestaurant(b);
    else if (act === 'logout') { closeAllSheets(); sb.auth.signOut().then(() => toast('已退出')); }
    else if (act === 'unbind') unbind(b);
    else if (act === 'export') exportBackup();
  });

  // 弹窗：× 关闭、点背景关闭
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return closeSheet(dlg);
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) closeSheet(dlg);
    });
  });
  $('#detailDialog').addEventListener('click', (e) => {
    if (e.target.closest('#nameToggle')) {
      const box = $('#dName');
      box.classList.toggle('open');
      $('#nameToggle').setAttribute('aria-expanded', String(box.classList.contains('open')));
    }
  });
  $('#detailDialog').addEventListener('close', () => { detailId = null; });

  // 添加 / 编辑
  $('#editForm').addEventListener('submit', submitEditor);
  $('#photoSlots').addEventListener('click', (e) => {
    if (e.target.closest('#photoAddBtn')) return $('#photoInput').click();
    const rm = e.target.closest('[data-rm-photo]');
    if (rm) {
      const [p] = form.photos.splice(Number(rm.dataset.rmPhoto), 1);
      if (p.kind === 'old') form.removed.push({ src: p.src, thumb: p.thumb });
      else URL.revokeObjectURL(p.preview);
      renderPhotoSlots();
    }
  });
  $('#photoInput').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    await addPhotos(files);
  });
  $('#addDetailBtn').addEventListener('click', () => addDetailField());
  $('#detailFields').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-detail]');
    if (rm) { rm.closest('.detail-field').remove(); updateDetailEmpty(); }
  });
  $('#detailFields').addEventListener('input', (e) => {
    if (e.target.tagName !== 'TEXTAREA') return;
    $('.count', e.target.parentElement).textContent = `${e.target.value.length}/${MAX_DETAIL}`;
  });

  // 登录 / 注册
  $$('#authDialog .tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
  $('#authForm').elements.username.addEventListener('input', checkUsername);
  $('#authForm').elements.password.addEventListener('input', checkPasswordMatch);
  $('#authForm').elements.password2.addEventListener('input', checkPasswordMatch);
  $('#authForm').addEventListener('submit', submitAuth);

  // 回到页面时，如果超过 30 秒没刷新，就拿一次最新数据（另一个人可能刚改过）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !sb || editing || drag) return;
    if ($$('dialog[open]').length) return;
    if (Date.now() - state.loadedAt > 30000) loadAll();
  });
}

init();
