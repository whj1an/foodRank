-- ---------- 表 ----------

-- 每个注册用户一条资料
--   account  = 注册账号（只能是小写英文字母和数字，用来登录）
--   username = 用户名（可选，大家看到的名字；没填就显示账号）
--   role     = owner：你们俩，可以管理餐厅；friend：朋友，只能写自己的见解
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  account    text not null unique check (account ~ '^[a-z0-9]{3,20}$'),
  username   text check (username = btrim(username) and char_length(username) between 1 and 20),
  role       text not null default 'friend' check (role in ('owner', 'friend')),
  created_at timestamptz not null default now()
);
-- 大家看到的名字（用户名，没有就用账号）不能重复，不分大小写
create unique index profiles_shown_name_key on public.profiles (lower(coalesce(username, account)));

-- 餐厅（只有 owner 能添加 / 修改）
create table public.restaurants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  area        text check (char_length(area) <= 40),
  cuisine     text check (char_length(cuisine) <= 40),
  price       smallint not null default 2 check (price between 1 and 4),
  address     text check (char_length(address) <= 120),
  last_visit  date,
  visits      integer not null default 1 check (visits between 1 and 999),
  again       text not null default 'maybe' check (again in ('yes', 'maybe', 'no')),
  dishes      text[] not null default '{}',
  notes       text check (char_length(notes) <= 1000),
  created_by  uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- 评价：每人对每家餐厅一条
--   score = 评级 1–10（10 = 夯 = A，1 = 拉夯了 = F），网页上可以切换显示样式
create table public.reviews (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  user_id       uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  score         smallint not null check (score between 1 and 10),
  comment       text check (char_length(comment) <= 1000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, user_id)
);
create index reviews_restaurant_id_idx on public.reviews (restaurant_id);
create index reviews_user_id_idx on public.reviews (user_id);

-- ---------- 自动处理 ----------

-- 新用户注册时，自动建一条 profile（账号和用户名来自注册表单）
-- 账号或名字重复、格式不对时这里会报错，整个注册会被取消
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, account, username)
  values (
    new.id,
    lower(coalesce(nullif(new.raw_user_meta_data ->> 'account', ''), split_part(new.email, '@', 1))),
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')), '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 修改时自动更新 updated_at
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger restaurants_touch before update on public.restaurants
  for each row execute function public.touch_updated_at();
create trigger reviews_touch before update on public.reviews
  for each row execute function public.touch_updated_at();

-- 判断某人是不是 owner
create function public.is_owner(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = uid and role = 'owner');
$$;

-- ---------- 权限（Row Level Security）----------
-- 所有人（包括没登录的访客）都能看；只有登录的人能增删改，并且按角色限制。

alter table public.profiles    enable row level security;
alter table public.restaurants enable row level security;
alter table public.reviews     enable row level security;

-- 表权限（grant）：决定网页能不能碰这张表；上面的 RLS 再决定能碰哪几行。
-- 有些 Supabase 项目不会自动给新表开权限，所以这里明确写出来，先全部收回再按需给。
revoke all on public.profiles, public.restaurants, public.reviews from anon, authenticated;
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.restaurants, public.reviews to anon, authenticated;
grant insert, update, delete on public.restaurants, public.reviews to authenticated;
grant update (username) on public.profiles to authenticated;   -- 只能改用户名这一列
grant execute on function public.is_owner(uuid) to anon, authenticated;

-- profiles：大家都能看名字；只能改自己的用户名（账号和角色不能改）
create policy "profiles: 所有人可读" on public.profiles
  for select to anon, authenticated using (true);
create policy "profiles: 改自己" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- restaurants：owner 可增删改
create policy "restaurants: 所有人可读" on public.restaurants
  for select to anon, authenticated using (true);
create policy "restaurants: owner 新增" on public.restaurants
  for insert to authenticated with check ((select public.is_owner()));
create policy "restaurants: owner 修改" on public.restaurants
  for update to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));
create policy "restaurants: owner 删除" on public.restaurants
  for delete to authenticated using ((select public.is_owner()));

-- reviews：每人写自己的；owner 可以替另一位 owner 打分（一起吃饭时一个人录入）；
--          owner 可以删除任何评价（管理用）
create policy "reviews: 所有人可读" on public.reviews
  for select to anon, authenticated using (true);
create policy "reviews: 写自己的或 owner 代录" on public.reviews
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    or ((select public.is_owner()) and public.is_owner(user_id))
  );
create policy "reviews: 改自己的或 owner 代录" on public.reviews
  for update to authenticated
  using (
    user_id = (select auth.uid())
    or ((select public.is_owner()) and public.is_owner(user_id))
  )
  with check (
    user_id = (select auth.uid())
    or ((select public.is_owner()) and public.is_owner(user_id))
  );
create policy "reviews: 删自己的或 owner 管理" on public.reviews
  for delete to authenticated
  using (user_id = (select auth.uid()) or (select public.is_owner()));
