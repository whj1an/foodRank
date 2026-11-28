-- 锐评 · 数据库（第 2 版）
-- 新项目：在 Supabase SQL Editor 里把整份文件运行一次。
-- 从第 1 版（从夯到拉）升级：先运行 upgrade-from-v1.sql，再运行这份。
-- 不要在已经有数据的库上重复运行这份文件。

-- ---------- 表 ----------

-- 库：一份排行榜（两个地区的餐厅都在里面）。每个用户注册时自动有一个自己的库；
-- 绑定的两个人共用同一个库，所以一个人添加的餐厅另一个人也能看到、也能排。
create table public.boards (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- 用户：用户名就是登录用的名字（小写英文字母和数字，3–20 位）
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  username   text not null unique check (username ~ '^[a-z0-9]{3,20}$'),
  board_id   uuid not null references public.boards (id),
  created_at timestamptz not null default now()
);
create index profiles_board_id_idx on public.profiles (board_id);

-- 每条细节最多 120 个字
create function public.details_ok(arr text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(char_length(d) between 1 and 120), true) from unnest(arr) as d;
$$;

-- 餐厅（页面上的一个标签）
--   region = 地区，ottawa / toronto，两个地区互不相通
--   level  = 等级 1–10（10 = A，1 = F；夯拉样式每档管两个等级，比如 10、9 都在「夯」）；null = 还在待评区
--   photos = 最多 3 张图：[{ "src": 原图路径, "thumb": 缩略图路径 }]，第一张是封面
create table public.restaurants (
  id         uuid primary key default gen_random_uuid(),
  board_id   uuid not null references public.boards (id) on delete cascade,
  region     text not null check (region in ('ottawa', 'toronto')),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  details    text[] not null default '{}' check (cardinality(details) <= 20 and public.details_ok(details)),
  photos     jsonb not null default '[]' check (jsonb_typeof(photos) = 'array' and jsonb_array_length(photos) <= 3),
  level      smallint check (level between 1 and 10),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  ranked_by  uuid references public.profiles (id) on delete set null,
  ranked_at  timestamptz,
  updated_at timestamptz not null default now()
);
create index restaurants_board_id_idx on public.restaurants (board_id);

-- ---------- 自动处理 ----------

-- 新用户注册时：建一个自己的库 + 一条 profile
-- 用户名重复或格式不对时这里会报错，整个注册会被取消
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  b uuid;
begin
  insert into public.boards default values returning id into b;
  insert into public.profiles (id, username, board_id)
  values (
    new.id,
    lower(split_part(new.email, '@', 1)),   -- 登录用的内部邮箱是「用户名@域名」
    b
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 当前登录的人在用哪个库
create function public.my_board()
returns uuid
language sql
stable
security definer set search_path = ''
as $$
  select board_id from public.profiles where id = auth.uid();
$$;

-- 网页（authenticated）写餐厅时，谁添加、谁排序、什么时候排的都由数据库来记，网页改不了：
--   新加的餐厅一律先进待评区；改等级时自动记下排序的人和时间（用数据库的时间，
--   所以两个人同时排同一家，以后点「完成」的那个为准）。
-- 数据库管理员（在 SQL Editor 里运行的函数，比如绑定 / 解绑）不受这些限制。
create function public.restaurants_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if current_user = 'authenticated' then
      new.created_by := auth.uid();
      new.created_at := now();
      new.level := null;
      new.ranked_by := null;
      new.ranked_at := null;
    end if;
  else
    if current_user = 'authenticated' then
      new.board_id := old.board_id;
      new.region := old.region;
      new.created_by := old.created_by;
      new.created_at := old.created_at;
      if new.level is distinct from old.level then
        new.ranked_by := case when new.level is null then null else auth.uid() end;
        new.ranked_at := case when new.level is null then null else now() end;
      else
        new.ranked_by := old.ranked_by;
        new.ranked_at := old.ranked_at;
      end if;
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger restaurants_guard before insert or update on public.restaurants
  for each row execute function public.restaurants_guard();

-- 点「完成」时一次保存所有刚排好的餐厅：items = [{ "id": "...", "level": 1–10 或 null }]
-- 在一个事务里完成，所以同一批的排序时间完全相同（页面上同一批按添加时间从左往右排）
create function public.save_ranking(items jsonb)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  n integer;
begin
  update public.restaurants r
     set level = (i ->> 'level')::smallint
    from jsonb_array_elements(items) as i
   where r.id = (i ->> 'id')::uuid
     and r.board_id = public.my_board();
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 取消绑定：自己搬到一个新库，并且带走一份解绑前的完整排行（对方的库原样保留）
create function public.unbind()
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  me uuid := auth.uid();
  old_board uuid;
  new_board uuid;
begin
  if me is null then
    raise exception '请先登录';
  end if;
  select board_id into old_board from public.profiles where id = me for update;
  if (select count(*) from public.profiles where board_id = old_board) < 2 then
    raise exception '你现在没有和任何人绑定';
  end if;
  insert into public.boards default values returning id into new_board;
  insert into public.restaurants
    (board_id, region, name, details, photos, level, created_by, created_at, ranked_by, ranked_at, updated_at)
  select new_board, region, name, details, photos, level, created_by, created_at, ranked_by, ranked_at, updated_at
    from public.restaurants
   where board_id = old_board;
  update public.profiles set board_id = new_board where id = me;
end;
$$;

-- 绑定两个人（只能在 SQL Editor 里运行，网页调用不了）：
--   select public.bind_users('whj', 'xxr');
-- 第二个人搬进第一个人的库，第二个人原来库里的餐厅也一起搬过去，以后两人共用一份排行。
create function public.bind_users(first_user text, second_user text)
returns void
language plpgsql
security definer set search_path = ''
as $$
declare
  a_board uuid;
  b_board uuid;
begin
  select board_id into a_board from public.profiles where username = lower(first_user);
  select board_id into b_board from public.profiles where username = lower(second_user);
  if a_board is null then raise exception '找不到用户 %', first_user; end if;
  if b_board is null then raise exception '找不到用户 %', second_user; end if;
  if a_board = b_board then raise exception '% 和 % 已经绑定了', first_user, second_user; end if;
  update public.restaurants set board_id = a_board where board_id = b_board;
  update public.profiles set board_id = a_board where board_id = b_board;
  delete from public.boards where id = b_board;
end;
$$;

-- 已经注册过的账号（比如第 1 版里注册的）补一个库和 profile；用户名不合规的会跳过
do $$
declare
  u record;
  b uuid;
begin
  for u in select id, email from auth.users
           where id not in (select id from public.profiles) order by created_at loop
    begin
      insert into public.boards default values returning id into b;
      insert into public.profiles (id, username, board_id)
      values (u.id,
              lower(split_part(u.email, '@', 1)),
              b);
    exception when others then
      raise notice '跳过 %：%', u.email, sqlerrm;
    end;
  end loop;
end;
$$;

-- ---------- 权限 ----------
-- 所有人（包括没登录的访客）都能看；登录的人只能改自己库里的餐厅。

alter table public.boards      enable row level security;
alter table public.profiles    enable row level security;
alter table public.restaurants enable row level security;

-- 表权限（grant）：决定网页能不能碰这张表；RLS 再决定能碰哪几行。
-- 有些 Supabase 项目不会自动给新表开权限，所以这里明确写出来，先全部收回再按需给。
revoke all on public.boards, public.profiles, public.restaurants from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.boards, public.profiles, public.restaurants to anon, authenticated;
grant insert, update, delete on public.restaurants to authenticated;

-- 函数权限：Supabase 默认允许网页调用 public 里的所有函数，所以先全部收回
revoke execute on function public.details_ok(text[]), public.handle_new_user(), public.my_board(),
  public.restaurants_guard(), public.save_ranking(jsonb), public.unbind(), public.bind_users(text, text)
  from public, anon, authenticated;
grant execute on function public.details_ok(text[]) to anon, authenticated;
grant execute on function public.my_board() to anon, authenticated;
grant execute on function public.save_ranking(jsonb), public.unbind() to authenticated;
-- bind_users 只给数据库管理员用，不给网页

create policy "boards: 所有人可读" on public.boards
  for select to anon, authenticated using (true);

create policy "profiles: 所有人可读" on public.profiles
  for select to anon, authenticated using (true);

create policy "restaurants: 所有人可读" on public.restaurants
  for select to anon, authenticated using (true);
create policy "restaurants: 往自己的库里加" on public.restaurants
  for insert to authenticated with check (board_id = (select public.my_board()));
create policy "restaurants: 改自己库里的" on public.restaurants
  for update to authenticated
  using (board_id = (select public.my_board()))
  with check (board_id = (select public.my_board()));
create policy "restaurants: 删自己库里的" on public.restaurants
  for delete to authenticated using (board_id = (select public.my_board()));

-- ---------- 图片 ----------
-- 公开的 photos 桶：谁都能看图；登录的人只能往自己库的文件夹（库 id/…）里传、删。
-- 单张最大 20 MB。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 20971520,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create policy "photos: 看自己库里的" on storage.objects
  for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select public.my_board())::text);
create policy "photos: 传到自己库里" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = (select public.my_board())::text);
create policy "photos: 删自己库里的" on storage.objects
  for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = (select public.my_board())::text);
