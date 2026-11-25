'use strict';

/* =====================================================================
   从夯到拉 · 前端逻辑
   数据在 Supabase：profiles（用户）/ restaurants（餐厅）/ reviews（每人的评级和见解）
   评级在数据库里存 1–10，网页上可以切换成「夯拉 / 字母 / 数字」三种样式显示。
   首页是一张 tier list：每个等级一行，还没评完的放在下面的「待评」区。
   ===================================================================== */

const cfg = window.FOODRANK_CONFIG || {};

/* ---------- 评级：10 个等级，三种样式 ---------- */
// 下标 = 等级（10 最好，1 最差）
const LEVELS = [
  null,
  { letter: 'F', tier: '拉夯了' }, // 1
  { letter: 'E', tier: '拉完了' }, // 2
  { letter: 'D-', tier: '路边摊' }, // 3
  { letter: 'D', tier: 'NPC' }, // 4
  { letter: 'C-', tier: '还行' }, // 5
  { letter: 'C', tier: '人上人' }, // 6
  { letter: 'B-', tier: '无暇' }, // 7
  { letter: 'B', tier: '顶级' }, // 8
  { letter: 'A-', tier: '极品' }, // 9
  { letter: 'A', tier: '夯' }, // 10
];
const LEVELS_BEST_FIRST = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
const STYLES = ['tier', 'letter', 'number'];
const STYLE_KEY = 'foodrank.ratingStyle';
const VIEW_KEY = 'foodrank.boardView';

/* ---------- 其他常量 ---------- */
const OTTAWA_AREAS = [
  'ByWard Market', 'Centretown', 'Chinatown', 'Little Italy', 'The Glebe', 'Westboro',
  'Hintonburg', 'Wellington West', 'Sandy Hill', 'New Edinburgh', 'Vanier', 'Old Ottawa South',
  'Alta Vista', 'Nepean', 'Barrhaven', 'Kanata', 'Orléans', 'Gloucester', 'Gatineau',
];
const CUISINES = [
  '中餐', '川菜', '粤菜 / 早茶', '火锅', '烧烤', '日料', '韩餐', '越南菜', '泰餐', '印度菜',
  '中东 / Shawarma', '意大利菜', '法餐', '美式 / 汉堡', '墨西哥菜', '海鲜', '早午餐', '甜品 / 咖啡',
];
const AGAIN = { yes: '必须再去', maybe: '有机会再去', no: '不会再去了' };
const LEGACY_KEY = 'foodrank.v1';
const MIGRATED_KEY = 'foodrank.migrated';
const ACCOUNT_RE = /^[a-z0-9]{3,20}$/;
// Supabase 登录必须用邮箱，所以把「账号」转成一个内部邮箱（不会真的发邮件）
const ACCOUNT_EMAIL_DOMAIN = cfg.accountEmailDomain || 'fromhang2la.app';
const TAGLINE = '吃过的渥太华餐厅';

/* ---------- 状态 ---------- */
let sb = null;
const state = { user: null, me: null, profiles: [], restaurants: [], reviews: [], loaded: false, loadedAt: 0 };
let editingId = null;
let reviewingId = null;
let detailId = null;
let authMode = 'login';

/* ---------- 工具 ---------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
const today = () => new Date().toLocaleDateString('en-CA');
const unique = (arr) => [...new Set(arr.filter(Boolean))].sort((x, y) => x.localeCompare(y, 'zh'));
const clip = (s, n) => (s == null ? null : String(s).trim().slice(0, n) || null);
const toLevel = (n) => Math.min(10, Math.max(1, Math.round(Number(n))));
const accountEmail = (account) => `${account}@${ACCOUNT_EMAIL_DOMAIN}`;
const shownName = (p) => (p ? p.username || p.account : '某人');

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { /* 无痕模式等 */ } }

let ratingStyle = STYLES.includes(lsGet(STYLE_KEY)) ? lsGet(STYLE_KEY) : 'tier';
let boardView = lsGet(VIEW_KEY) || 'couple'; // 'couple' | 'friends' | 某个 owner 的 id

// 某个等级在当前样式下的文字
function levelLabel(level, style = ratingStyle) {
  if (style === 'number') return String(level);
  return LEVELS[level][style === 'letter' ? 'letter' : 'tier'];
}
// 平均值（可能有小数）在当前样式下的文字：数字样式显示小数，其他样式四舍五入到最近的等级
function scoreLabel(avg) {
  return ratingStyle === 'number' ? fmt(avg) : levelLabel(toLevel(avg));
}
const pill = (score, cls = 'pill') => score == null
  ? `<span class="${cls} lv-none">还没评</span>`
  : `<span class="${cls} lv-${toLevel(score)}">${esc(scoreLabel(score))}</span>`;

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
}

function errMsg(e) {
  const m = (e && (e.message || e.error_description)) || String(e);
  if (/Invalid login credentials/i.test(m)) return '账号或密码不对';
  if (/already registered|already exists/i.test(m)) return '这个账号已经被注册了，换一个吧';
  if (/Database error saving new user/i.test(m)) return '账号或用户名已经被别人用了，换一个吧';
  if (/profiles_shown_name_key|duplicate key/i.test(m)) return '这个名字已经有人用了，换一个吧';
  if (/Email not confirmed/i.test(m)) return '这个网站还开着「邮箱确认」，请让站长在 Supabase 里关掉 Confirm email';
  if (/email.*invalid|invalid.*email/i.test(m)) return '注册失败：Supabase 不接受内部邮箱格式，请站长看 README 的「常见问题」';
  if (/Password should be at least/i.test(m)) return '密码至少 6 位';
  if (/rate limit/i.test(m)) return '操作太频繁了，请过一会儿再试';
  if (/row-level security|permission denied/i.test(m)) return '没有权限做这个操作';
  if (/Failed to fetch|NetworkError/i.test(m)) return '网络连接失败，请检查网络';
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
  try { await fn(); } catch (e) { toast(errMsg(e), true); } finally { btn.disabled = false; }
}

/* ---------- 派生数据 ---------- */
const owners = () => state.profiles
  .filter((p) => p.role === 'owner')
  .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
const isOwner = () => state.me?.role === 'owner';
const nameOf = (uid) => shownName(state.profiles.find((p) => p.id === uid));

function summarize(r) {
  const revs = state.reviews.filter((v) => v.restaurant_id === r.id);
  const os = owners();
  const ownerIds = new Set(os.map((o) => o.id));
  const ownerScores = os.map((o) => {
    const v = revs.find((x) => x.user_id === o.id);
    return v ? Number(v.score) : null;
  });
  const rated = ownerScores.filter((s) => s != null);
  const friends = revs.filter((v) => !ownerIds.has(v.user_id));
  return {
    revs,
    ownerIds,
    ownerScores,
    couple: rated.length ? mean(rated) : null,
    gap: rated.length === 2 ? Math.abs(rated[0] - rated[1]) : null,
    friends,
    friendAvg: friends.length ? mean(friends.map((v) => Number(v.score))) : null,
  };
}

// 在当前「看谁的榜」下，这家餐厅的分数；null = 放进待评区（note 说明还差谁）
function placeOf(s) {
  const os = owners();
  if (boardView === 'friends') return { score: s.friendAvg, note: '' };
  if (boardView !== 'couple') {
    const i = os.findIndex((o) => o.id === boardView);
    return { score: i >= 0 ? s.ownerScores[i] : null, note: '' };
  }
  if (!os.length) return { score: null, note: '' };
  const missing = os.filter((_, i) => s.ownerScores[i] == null);
  if (!missing.length) return { score: s.couple, note: '' };
  const note = missing.length < os.length ? '还差 ' + missing.map(shownName).join('、') : '';
  return { score: null, note };
}

function viewOptions() {
  const os = owners();
  const opts = [];
  if (os.length) opts.push({ id: 'couple', label: os.length > 1 ? '我们俩' : shownName(os[0]) });
  if (os.length > 1) os.forEach((o) => opts.push({ id: o.id, label: shownName(o) }));
  opts.push({ id: 'friends', label: '朋友们' });
  return opts;
}

/* ---------- 名字是否被占用（注册 / 改名时提前检查，数据库里也有唯一约束兜底） ---------- */
async function fetchNames() {
  return must(sb.from('profiles').select('id, account, username'));
}
function accountTaken(rows, account) {
  return rows.some((p) => p.account === account);
}
function shownNameTaken(rows, name, exceptId = null) {
  const key = name.trim().toLowerCase();
  return rows.some((p) => p.id !== exceptId && shownName(p).toLowerCase() === key);
}

/* ---------- 视图切换 ---------- */
function show(view) {
  for (const id of ['setupView', 'authView', 'appView']) $('#' + id).hidden = id !== view;
}

/* ---------- 启动 & 登录 ---------- */
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
  renderStyleControls();
  const problem = configProblem();
  if (problem === null) return show('setupView');
  if (problem) { $('#setupMsg').textContent = problem; return show('setupView'); }
  if (!window.supabase?.createClient) {
    $('#setupMsg').textContent = '加载 Supabase 失败，请检查网络后刷新页面。';
    return show('setupView');
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  // 回调里不要直接 await supabase 调用（官方建议），所以用 setTimeout 放到下一轮
  sb.auth.onAuthStateChange((_event, session) => setTimeout(() => onSession(session), 0));
}

async function onSession(session) {
  const user = session?.user || null;
  // 登录状态没变（比如只是 token 刷新）就不用重新加载
  if (state.loaded && (state.user?.id ?? null) === (user?.id ?? null)) return;
  state.user = user; // null = 游客，只能看
  state.me = null;
  show('appView');
  await loadAll();
}

function openAuth(mode, msg = '') {
  closeDetail();
  setAuthMode(mode);
  $('#authMsg').textContent = msg;
  show('authView');
  $('#authForm').elements.account.focus();
}

const authForm = $('#authForm');

function setFieldMsg(form, name, text, ok = false) {
  const el = form.querySelector(`.field-msg[data-for="${name}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('ok', ok && !!text);
}

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  const signup = mode === 'signup';
  authForm.querySelectorAll('.signup-only').forEach((el) => (el.hidden = !signup));
  authForm.elements.password.autocomplete = signup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = signup ? '注册' : '登录';
  $('#authMsg').textContent = '';
  setFieldMsg(authForm, 'account', '');
  setFieldMsg(authForm, 'username', '');
  setFieldMsg(authForm, 'password2', '');
  authForm.elements.password2.value = '';
}

// 注册时检查两次密码是否一致（第二个框有内容后才提示）
function checkPasswordMatch() {
  if (authMode !== 'signup') return true;
  const { password, password2 } = authForm.elements;
  if (!password2.value) { setFieldMsg(authForm, 'password2', ''); return false; }
  const same = password.value === password2.value;
  setFieldMsg(authForm, 'password2', same ? '✓ 两次一致' : '两次输入的密码不一样', same);
  return same;
}
authForm.elements.password.addEventListener('input', checkPasswordMatch);
authForm.elements.password2.addEventListener('input', checkPasswordMatch);

// 注册时边输入边检查账号 / 用户名
let checkTimer;
let checkSeq = 0;
function scheduleNameCheck() {
  clearTimeout(checkTimer);
  if (authMode !== 'signup') return;
  const account = authForm.elements.account.value.trim().toLowerCase();
  const username = authForm.elements.username.value.trim();
  setFieldMsg(authForm, 'account', '');
  setFieldMsg(authForm, 'username', '');
  if (account && !/^[A-Za-z0-9]*$/.test(authForm.elements.account.value.trim())) {
    setFieldMsg(authForm, 'account', '只能用英文字母和数字');
    return;
  }
  if (!account && !username) return;
  checkTimer = setTimeout(async () => {
    const seq = ++checkSeq;
    let rows;
    try { rows = await fetchNames(); } catch { return; }
    if (seq !== checkSeq || authMode !== 'signup') return; // 已经有更新的输入
    if (account) {
      if (account.length < 3) setFieldMsg(authForm, 'account', '至少 3 位');
      else if (accountTaken(rows, account)) setFieldMsg(authForm, 'account', '这个账号已经被注册了，换一个吧');
      else if (!username && shownNameTaken(rows, account)) setFieldMsg(authForm, 'account', '和别人的用户名重名了，换一个账号或填个用户名');
      else setFieldMsg(authForm, 'account', '✓ 可以用', true);
    }
    if (username) {
      if (shownNameTaken(rows, username)) setFieldMsg(authForm, 'username', '这个用户名已经有人用了，换一个吧');
      else setFieldMsg(authForm, 'username', '✓ 可以用', true);
    }
  }, 400);
}
authForm.elements.account.addEventListener('input', scheduleNameCheck);
authForm.elements.username.addEventListener('input', scheduleNameCheck);

authForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = authForm.elements;
  const rawAccount = f.account.value.trim();
  const account = rawAccount.toLowerCase();
  const password = f.password.value;
  busy($('#authSubmit'), async () => {
    $('#authMsg').textContent = '';
    if (authMode === 'login') {
      if (!ACCOUNT_RE.test(account) || !password) throw new Error('账号或密码不对');
      const { error } = await sb.auth.signInWithPassword({ email: accountEmail(account), password });
      if (error) throw error;
      f.password.value = '';
      return;
    }

    // 注册
    const username = clip(f.username.value, 20);
    if (!/^[A-Za-z0-9]{3,20}$/.test(rawAccount)) throw new Error('账号只能用英文字母和数字，3–20 位');
    if (password.length < 6) throw new Error('密码至少 6 位');
    if (!f.password2.value) throw new Error('请再输一遍密码确认');
    if (!checkPasswordMatch()) throw new Error('两次输入的密码不一样');
    const rows = await fetchNames();
    if (accountTaken(rows, account)) {
      setFieldMsg(authForm, 'account', '这个账号已经被注册了，换一个吧');
      throw new Error('这个账号已经被注册了，换一个吧');
    }
    if (username && shownNameTaken(rows, username)) {
      setFieldMsg(authForm, 'username', '这个用户名已经有人用了，换一个吧');
      throw new Error('这个用户名已经有人用了，换一个吧');
    }
    if (!username && shownNameTaken(rows, account)) {
      throw new Error('这个账号和别人的用户名重名了，换一个账号，或者填一个用户名');
    }
    const { data, error } = await sb.auth.signUp({
      email: accountEmail(account),
      password,
      options: { data: { account, username } },
    });
    if (error) throw error;
    if (!data.session) {
      throw new Error('账号建好了，但网站还开着「邮箱确认」，暂时登录不了。请站长在 Supabase 里关掉 Confirm email。');
    }
    f.password.value = '';
    f.password2.value = '';
    setFieldMsg(authForm, 'password2', '');
    toast(`注册成功，欢迎 ${username || account}`);
  });
});

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));
$('#loginBtn').addEventListener('click', () => openAuth('login'));
$('#browseBtn').addEventListener('click', () => show('appView'));

/* ---------- 读数据 ---------- */
async function loadAll({ quiet = false } = {}) {
  if (!quiet && !state.loaded) $('#board').innerHTML = '<p class="muted small" style="padding:16px">加载中…</p>';
  try {
    const [profiles, restaurants, reviews] = await Promise.all([
      must(sb.from('profiles').select('id, account, username, role, created_at')),
      must(sb.from('restaurants').select('*')),
      must(sb.from('reviews').select('*')),
    ]);
    Object.assign(state, { profiles, restaurants, reviews, loaded: true, loadedAt: Date.now() });
    state.me = state.user
      ? profiles.find((p) => p.id === state.user.id) ||
        { id: state.user.id, account: state.user.email?.split('@')[0] || '我', username: null, role: 'friend' }
      : null;
    render();
    checkMigration();
  } catch (e) {
    toast('加载失败：' + errMsg(e), true);
  }
}

/* ---------- 评级样式切换 ---------- */
function renderStyleControls() {
  document.querySelectorAll('#styleSeg button').forEach((b) => {
    const on = b.dataset.style === ratingStyle;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on);
  });
  $('#legend').innerHTML = `<table>
    <thead><tr><th></th><th>夯拉</th><th>字母</th><th>数字</th></tr></thead>
    <tbody>${LEVELS_BEST_FIRST.map((l) => `
      <tr><td><span class="dot lv-${l}"></span></td>
        <td>${levelLabel(l, 'tier')}</td><td>${levelLabel(l, 'letter')}</td><td>${l}</td></tr>`).join('')}
    </tbody></table>`;
}

document.querySelectorAll('#styleSeg button').forEach((b) => b.addEventListener('click', () => {
  ratingStyle = b.dataset.style;
  lsSet(STYLE_KEY, ratingStyle);
  renderStyleControls();
  render();
}));

// 10 个等级的选择器：竖排，跟榜单一样，等于「把它放进哪一档」
function levelPicker(name, value, disabled = false) {
  const other = (l) => [levelLabel(l, 'tier'), levelLabel(l, 'letter'), String(l)]
    .filter((x) => x !== levelLabel(l)).join(' · ');
  return `<div class="picker" role="radiogroup">${LEVELS_BEST_FIRST.map((l) => `
    <label class="pick lv-${l}">
      <input type="radio" name="${name}" value="${l}" ${l === value ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span><b>${esc(levelLabel(l))}</b><em>${esc(other(l))}</em></span>
    </label>`).join('')}</div>`;
}
const pickedLevel = (form, name) => {
  const v = form.querySelector(`input[type=radio][name="${name}"]:checked`)?.value;
  return v ? Number(v) : null;
};

/* ---------- 渲染 ---------- */
function renderChrome() {
  const signedIn = !!state.me;
  const owner = isOwner();
  document.querySelectorAll('.signed-in-only').forEach((el) => (el.hidden = !signedIn));
  document.querySelectorAll('.visitor-only').forEach((el) => (el.hidden = signedIn));
  document.querySelectorAll('.owner-only').forEach((el) => (el.hidden = !owner));
  if (signedIn) {
    $('#meName').textContent = shownName(state.me);
    $('#meName').title = `账号：${state.me.account}（点一下改用户名）`;
    $('#meRole').textContent = owner ? '用户' : '朋友';
    $('#meRole').classList.toggle('owner', owner);
  }
  $('#friendHint').hidden = !signedIn || owner;
  $('#visitorHint').hidden = signedIn;

  const os = owners();
  $('#subtitle').textContent = os.length ? `${os.map(shownName).join(' 和 ')} ${TAGLINE}` : TAGLINE;

  $('#areaList').innerHTML = unique([...OTTAWA_AREAS, ...state.restaurants.map((r) => r.area)]).map((v) => `<option value="${esc(v)}">`).join('');
  $('#cuisineList').innerHTML = unique([...CUISINES, ...state.restaurants.map((r) => r.cuisine)]).map((v) => `<option value="${esc(v)}">`).join('');
}

function renderStats(sums) {
  const all = [...sums.values()];
  const both = all.filter((s) => s.ownerScores.length && s.ownerScores.every((x) => x != null));
  const gaps = all.filter((s) => s.gap != null).map((s) => s.gap);
  const visits = state.restaurants.reduce((n, r) => n + (Number(r.visits) || 1), 0);
  const friendCount = all.reduce((n, s) => n + s.friends.length, 0);
  const parts = [
    `去过 <b>${state.restaurants.length}</b> 家`,
    `一起吃了 <b>${visits}</b> 次`,
    both.length ? `平均 <b>${esc(scoreLabel(mean(both.map((s) => s.couple))))}</b>` : null,
    gaps.length ? `口味契合度 <b>${Math.round(Math.max(0, 100 - mean(gaps) * 10))}%</b>` : null,
    friendCount ? `朋友的见解 <b>${friendCount}</b> 条` : null,
  ];
  $('#stats').innerHTML = parts.filter(Boolean).join(' · ');
}

function renderViewSeg() {
  const opts = viewOptions();
  if (!opts.some((o) => o.id === boardView)) boardView = opts[0].id;
  $('#viewSeg').innerHTML = opts.map((o) => `
    <button type="button" role="radio" data-view="${esc(o.id)}" class="${o.id === boardView ? 'active' : ''}"
      aria-checked="${o.id === boardView}">${esc(o.label)}</button>`).join('');
}

function searchText(r, s) {
  return [r.name, r.area, r.cuisine, r.notes, r.address, ...(r.dishes || []), ...s.revs.map((v) => v.comment)]
    .join(' ').toLowerCase();
}

function chip(r, place, matched) {
  const extra = ratingStyle === 'number' && place.score != null ? `<i>${fmt(place.score)}</i>` : '';
  const note = place.note ? `<i>${esc(place.note)}</i>` : '';
  const cls = ['chip', matched === false ? 'dim' : '', matched === true ? 'hit' : ''].join(' ').trim();
  return `<button type="button" class="${cls}" data-act="open" data-id="${r.id}"><span class="nm">${esc(r.name)}</span>${extra}${note}</button>`;
}

function renderBoard(sums) {
  const q = $('#search').value.trim().toLowerCase();
  const rows = new Map(LEVELS_BEST_FIRST.map((l) => [l, []]));
  const pool = [];
  let hits = 0;
  for (const r of state.restaurants) {
    const s = sums.get(r.id);
    const place = placeOf(s);
    const matched = q ? searchText(r, s).includes(q) : null;
    if (matched) hits++;
    const entry = { r, place, matched };
    if (place.score == null) pool.push(entry);
    else rows.get(toLevel(place.score)).push(entry);
  }
  const byScore = (a, b) => (b.place.score - a.place.score) || a.r.name.localeCompare(b.r.name, 'zh');
  $('#board').innerHTML = LEVELS_BEST_FIRST.map((l) => {
    const items = rows.get(l).sort(byScore);
    return `<div class="tier lv-${l}${items.length ? '' : ' empty'}">
      <div class="label">${esc(levelLabel(l))}</div>
      <div class="items">${items.map((e) => chip(e.r, e.place, e.matched)).join('')}</div>
    </div>`;
  }).join('');

  const poolTitle = boardView === 'couple' ? '待评'
    : boardView === 'friends' ? '朋友还没评'
      : `${nameOf(boardView)} 还没评`;
  pool.sort((a, b) => a.r.name.localeCompare(b.r.name, 'zh'));
  let poolBody = pool.map((e) => chip(e.r, e.place, e.matched)).join('');
  if (!state.restaurants.length) {
    poolBody = `<span class="pool-empty">${isOwner()
      ? '还没有餐厅。点右上角「添加餐厅」，把第一家放上榜。'
      : '还没有餐厅记录，过几天再来看看吧。'}</span>`;
  } else if (!pool.length) {
    poolBody = '<span class="pool-empty">都评完了</span>';
  }
  $('#pool').innerHTML = `<span class="pool-title">${esc(poolTitle)}</span>${poolBody}`;

  $('#searchInfo').textContent = q ? (hits ? `找到 ${hits} 家` : '没找到') : '';
}

function render() {
  if (!state.loaded) return;
  renderChrome();
  const sums = new Map(state.restaurants.map((r) => [r.id, summarize(r)]));
  renderStats(sums);
  renderViewSeg();
  renderBoard(sums);
  if (detailId && $('#detailDialog').open) renderDetail();
}

$('#viewSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  boardView = b.dataset.view;
  lsSet(VIEW_KEY, boardView);
  render();
});
$('#search').addEventListener('input', render);

/* ---------- 详情面板 ---------- */
function mapUrl(r) {
  const q = [r.name, r.address || r.area, 'Ottawa'].filter(Boolean).join(' ');
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

function renderDetail() {
  const r = state.restaurants.find((x) => x.id === detailId);
  if (!r) { closeDetail(); return; }
  const s = summarize(r);
  const os = owners();
  const meta = [r.area, r.cuisine, '$'.repeat(r.price || 2), r.last_visit ? '最近 ' + r.last_visit : null, `去过 ${r.visits || 1} 次`]
    .filter(Boolean).map(esc).join(' · ');
  const allRated = os.length && s.ownerScores.every((x) => x != null);

  const ownerLines = os.map((o, i) => {
    const v = s.revs.find((x) => x.user_id === o.id);
    return `<div class="who-line"><span class="n">${esc(shownName(o))}</span>${pill(s.ownerScores[i])}
      ${v?.comment ? `<span class="c">${esc(v.comment)}</span>` : ''}</div>`;
  }).join('');

  const friends = [...s.friends].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  const friendLines = friends.map((v) => `
    <div class="who-line"><span class="n">${esc(nameOf(v.user_id))}</span>${pill(Number(v.score))}
      ${v.comment ? `<span class="c">${esc(v.comment)}</span>` : ''}</div>`).join('');

  const mine = state.me && s.revs.find((v) => v.user_id === state.me.id);
  const reviewBtn = state.me
    ? `<button class="primary" data-act="review" data-id="${r.id}">${mine ? '改我的见解' : '写见解'}</button>`
    : `<button class="primary" data-act="login">登录后写见解</button>`;

  $('#detailBody').innerHTML = `
    <div class="detail">
      <div class="detail-head">
        <div class="t">
          <h2 id="detailName">${esc(r.name)}</h2>
          <p class="sub">${meta}</p>
        </div>
        ${allRated ? pill(s.couple, 'big-pill') : '<span class="big-pill lv-none">待评</span>'}
        <button class="ghost close" data-close aria-label="关闭">×</button>
      </div>

      ${os.length ? `<div class="block"><h3>我们俩</h3>${ownerLines}</div>` : ''}

      ${(r.dishes || []).length || r.notes || r.again ? `<div class="block">
        ${(r.dishes || []).length ? `<p class="text">推荐：${(r.dishes || []).map(esc).join(' · ')}</p>` : ''}
        ${r.notes ? `<p class="text">${esc(r.notes)}</p>` : ''}
        ${AGAIN[r.again] ? `<p class="muted small">${AGAIN[r.again]}</p>` : ''}
      </div>` : ''}

      <div class="block">
        <h3>朋友说${friends.length ? ` · ${friends.length} 条 · 平均 ${esc(scoreLabel(s.friendAvg))}` : ''}</h3>
        ${friendLines || '<p class="muted small">还没有朋友评价这家。</p>'}
      </div>

      <div class="actions">
        ${reviewBtn}
        <a class="btn" href="${mapUrl(r)}" target="_blank" rel="noopener">地图</a>
        ${isOwner() ? `
          <button data-act="edit" data-id="${r.id}">编辑</button>
          <button class="danger" data-act="delete" data-id="${r.id}">删除</button>` : ''}
      </div>
    </div>`;
}

function openDetail(id) {
  detailId = id;
  renderDetail();
  const d = $('#detailDialog');
  if (!d.open) d.showModal();
}
function closeDetail() {
  detailId = null;
  const d = $('#detailDialog');
  if (d.open) d.close();
}
// 点面板外面的暗色区域也能关
$('#detailDialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeDetail(); });
$('#detailDialog').addEventListener('close', () => { detailId = null; });

/* ---------- 添加 / 编辑餐厅（owner） ---------- */
const editForm = $('#editForm');

function ownerScoreRows(r) {
  const os = owners();
  const rows = os.map((o) => {
    const v = r ? state.reviews.find((x) => x.restaurant_id === r.id && x.user_id === o.id) : null;
    const on = r ? !!v : true;
    return `
      <div class="owner-score">
        <label class="check"><input type="checkbox" name="use_${o.id}" ${on ? 'checked' : ''}>${esc(shownName(o))} 的评级</label>
        ${levelPicker('score_' + o.id, v ? Number(v.score) : null, !on)}
      </div>`;
  }).join('');
  const hint = os.length < 2
    ? '<p class="small muted">另一位注册并被设成用户后，这里会出现 TA 的评级。</p>'
    : '<p class="small muted">取消勾选 = 先不评级，留给 TA 自己来。</p>';
  return rows + hint;
}

function openEditor(r) {
  editingId = r ? r.id : null;
  $('#editTitle').textContent = r ? '编辑餐厅' : '添加餐厅';
  editForm.reset();
  const v = r || { last_visit: today(), visits: 1, price: 2, again: 'maybe' };
  for (const key of ['name', 'area', 'cuisine', 'price', 'last_visit', 'visits', 'again', 'address', 'notes']) {
    editForm.elements[key].value = v[key] ?? '';
  }
  editForm.elements.dishes.value = (v.dishes || []).join(', ');
  $('#ownerScores').innerHTML = ownerScoreRows(r);
  $('#editDialog').showModal();
}

editForm.addEventListener('change', (e) => {
  const m = e.target.name?.match(/^use_(.+)$/);
  if (!m) return;
  editForm.querySelectorAll(`input[name="score_${m[1]}"]`).forEach((i) => (i.disabled = !e.target.checked));
});

editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const f = editForm.elements;
  const payload = {
    name: clip(f.name.value, 80),
    area: clip(f.area.value, 40),
    cuisine: clip(f.cuisine.value, 40),
    price: Number(f.price.value),
    last_visit: f.last_visit.value || null,
    visits: Math.min(999, Math.max(1, Number(f.visits.value) || 1)),
    again: f.again.value,
    dishes: f.dishes.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20),
    address: clip(f.address.value, 120),
    notes: clip(f.notes.value, 1000),
  };
  if (!payload.name) return;
  const scores = [];
  for (const o of owners()) {
    if (!f['use_' + o.id]?.checked) continue;
    const level = pickedLevel(editForm, 'score_' + o.id);
    if (!level) { toast(`请给「${shownName(o)}」选一档，或者取消勾选`, true); return; }
    scores.push({ user_id: o.id, score: level });
  }
  busy(e.submitter || editForm.querySelector('[type=submit]'), async () => {
    let rid = editingId;
    if (rid) {
      await must(sb.from('restaurants').update(payload).eq('id', rid));
    } else {
      rid = (await must(sb.from('restaurants').insert(payload).select('id').single())).id;
    }
    if (scores.length) {
      await must(sb.from('reviews').upsert(scores.map((x) => ({ ...x, restaurant_id: rid })), { onConflict: 'restaurant_id,user_id' }));
    }
    $('#editDialog').close();
    toast(editingId ? '已保存' : '已添加');
    await loadAll({ quiet: true });
  });
});

/* ---------- 写见解（所有登录的人） ---------- */
const reviewForm = $('#reviewForm');
const myReview = (rid) => state.reviews.find((v) => v.restaurant_id === rid && v.user_id === state.me?.id);

function openReview(r) {
  reviewingId = r.id;
  const mine = myReview(r.id);
  $('#reviewTitle').textContent = `我对「${r.name}」的见解`;
  $('#reviewLevels').innerHTML = levelPicker('score', mine ? Number(mine.score) : null);
  reviewForm.elements.comment.value = mine?.comment || '';
  $('#reviewDelete').hidden = !mine;
  $('#reviewDialog').showModal();
}

reviewForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const level = pickedLevel(reviewForm, 'score');
  if (!level) { toast('先选一档吧', true); return; }
  busy(e.submitter || reviewForm.querySelector('[type=submit]'), async () => {
    await must(sb.from('reviews').upsert({
      restaurant_id: reviewingId,
      user_id: state.me.id,
      score: level,
      comment: clip(reviewForm.elements.comment.value, 1000),
    }, { onConflict: 'restaurant_id,user_id' }));
    $('#reviewDialog').close();
    toast('见解已保存');
    await loadAll({ quiet: true });
  });
});

$('#reviewDelete').addEventListener('click', (e) => {
  const mine = myReview(reviewingId);
  if (!mine || !confirm('确定删除你对这家餐厅的评级和见解吗？')) return;
  busy(e.currentTarget, async () => {
    await must(sb.from('reviews').delete().eq('id', mine.id));
    $('#reviewDialog').close();
    toast('已删除');
    await loadAll({ quiet: true });
  });
});

/* ---------- 通用点击 ---------- */
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act], [data-close]');
  if (!el) return;
  if (el.hasAttribute('data-close')) {
    const d = el.closest('dialog');
    if (d === $('#detailDialog')) closeDetail(); else d?.close();
    return;
  }
  const r = state.restaurants.find((x) => x.id === el.dataset.id);
  switch (el.dataset.act) {
    case 'open': if (r) openDetail(r.id); break;
    case 'add': if (isOwner()) openEditor(); break;
    case 'edit': if (r && isOwner()) openEditor(r); break;
    case 'review':
      if (!r) break;
      if (state.me) openReview(r);
      else openAuth('login', '登录后就能写见解啦。还没有账号？点上面的「注册」。');
      break;
    case 'login': openAuth('login'); break;
    case 'delete':
      if (r && isOwner() && confirm(`确定删除「${r.name}」吗？大家对它的见解也会一起删除。`)) {
        busy(el, async () => {
          await must(sb.from('restaurants').delete().eq('id', r.id));
          closeDetail();
          toast('已删除');
          await loadAll({ quiet: true });
        });
      }
      break;
  }
});

$('#addBtn').addEventListener('click', () => openEditor());
$('#refreshBtn').addEventListener('click', (e) => busy(e.currentTarget, () => loadAll({ quiet: true })));
$('#logoutBtn').addEventListener('click', () => sb.auth.signOut());

// 切回这个页面时（比如手机从后台回来），超过 30 秒就自动刷新一次
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.loaded && Date.now() - state.loadedAt > 30000) {
    loadAll({ quiet: true });
  }
});

/* ---------- 改用户名（点顶栏的名字也可以） ---------- */
const renameForm = $('#renameForm');
function openRename() {
  if (!state.me) return;
  renameForm.elements.username.value = state.me.username || '';
  $('#renameHint').textContent = `用户名（留空就显示账号「${state.me.account}」）`;
  setFieldMsg(renameForm, 'rename', '');
  $('#renameDialog').showModal();
}
$('#renameBtn').addEventListener('click', openRename);
$('#meName').addEventListener('click', openRename);
renameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const username = clip(renameForm.elements.username.value, 20);
  busy(e.submitter || renameForm.querySelector('[type=submit]'), async () => {
    const rows = await fetchNames();
    if (shownNameTaken(rows, username || state.me.account, state.me.id)) {
      const msg = username ? '这个用户名已经有人用了，换一个吧' : '你的账号和别人的用户名重名了，请填一个用户名';
      setFieldMsg(renameForm, 'rename', msg);
      return;
    }
    await must(sb.from('profiles').update({ username }).eq('id', state.me.id));
    $('#renameDialog').close();
    toast('用户名已更新');
    await loadAll({ quiet: true });
  });
});

/* ---------- 导出备份（owner） ---------- */
$('#exportBtn').addEventListener('click', () => {
  const data = {
    version: 3,
    exportedAt: new Date().toISOString(),
    profiles: state.profiles.map(({ id, account, username, role }) => ({ id, account, username, role })),
    restaurants: state.restaurants,
    reviews: state.reviews,
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `foodrank-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* ---------- 导入旧版（本地版本）数据（owner） ---------- */
async function importLegacy(items) {
  const me = state.me;
  const partner = owners().find((o) => o.id !== me.id);
  const existing = new Set(state.restaurants.map((r) => r.name.trim().toLowerCase()));
  const fresh = items.filter((it) => it && it.name && !existing.has(String(it.name).trim().toLowerCase()));
  if (!fresh.length) { toast('没有需要导入的新记录（同名的餐厅会跳过）'); return true; }

  const msg = `将导入 ${fresh.length} 家餐厅` +
    (items.length > fresh.length ? `（跳过 ${items.length - fresh.length} 家已存在的）` : '') +
    `。\n\n旧数据里第一个人的分数 → 记到「${shownName(me)}」名下\n` +
    (partner ? `第二个人的分数 → 记到「${shownName(partner)}」名下` : '第二个人的分数 → 跳过（另一位还没注册）') +
    '\n旧的半分（比如 8.5）会四舍五入成整数等级。\n\n确定吗？';
  if (!confirm(msg)) return false;

  let done = 0;
  for (const it of fresh) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(it.date || '') ? it.date : null;
    const row = {
      name: clip(it.name, 80),
      area: clip(it.area, 40),
      cuisine: clip(it.cuisine, 40),
      price: [1, 2, 3, 4].includes(Number(it.price)) ? Number(it.price) : 2,
      last_visit: date,
      visits: Math.min(999, Math.max(1, Number(it.visits) || 1)),
      again: AGAIN[it.again] ? it.again : 'maybe',
      dishes: Array.isArray(it.dishes) ? it.dishes.map((d) => String(d).trim()).filter(Boolean).slice(0, 20) : [],
      address: clip(it.address, 120),
      notes: clip(it.notes, 1000),
    };
    const { id } = await must(sb.from('restaurants').insert(row).select('id').single());
    const scores = [];
    if (it.scoreA != null) scores.push({ restaurant_id: id, user_id: me.id, score: toLevel(it.scoreA) });
    if (partner && it.scoreB != null) scores.push({ restaurant_id: id, user_id: partner.id, score: toLevel(it.scoreB) });
    if (scores.length) await must(sb.from('reviews').insert(scores));
    done++;
  }
  toast(`已导入 ${done} 家餐厅`);
  await loadAll({ quiet: true });
  return true;
}

$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items)) throw new Error('这不是旧版本导出的备份文件');
    await importLegacy(items);
  } catch (err) {
    toast('导入失败：' + errMsg(err), true);
  }
});

// 旧的本地版本把数据存在 localStorage 里，owner 登录后提示一次上传
function legacyItems() {
  try {
    const items = JSON.parse(lsGet(LEGACY_KEY) || '[]');
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

function checkMigration() {
  const items = legacyItems();
  const visible = isOwner() && items.length > 0 && !lsGet(MIGRATED_KEY);
  $('#migrateBanner').hidden = !visible;
  if (visible) $('#migrateCount').textContent = items.length;
}

$('#migrateBtn').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  if (await importLegacy(legacyItems())) {
    lsSet(MIGRATED_KEY, new Date().toISOString());
    $('#migrateBanner').hidden = true;
  }
}));
$('#migrateDismiss').addEventListener('click', () => {
  lsSet(MIGRATED_KEY, 'dismissed');
  $('#migrateBanner').hidden = true;
});

init();
