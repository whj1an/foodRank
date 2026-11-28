-- 从第 1 版（从夯到拉）升级到第 2 版（锐评）：先运行这份，再运行 schema.sql。
-- ⚠️ 会删掉第 1 版的所有餐厅和评价（建议先在旧网页上「导出备份」）。
-- 登录账号（auth.users）会保留：运行 schema.sql 时会自动给它们补上新的 profile，
-- 用原来的账号当用户名，密码不变。

drop trigger if exists on_auth_user_created on auth.users;
drop table if exists public.reviews, public.restaurants, public.profiles cascade;
drop function if exists public.handle_new_user() cascade;
drop function if exists public.is_owner(uuid) cascade;
drop function if exists public.touch_updated_at() cascade;
