// 在 Supabase 控制台 → Project Settings → API Keys 里找到下面两个值，填进来。
//
// supabaseAnonKey 填「Publishable key」（sb_publishable_ 开头）或旧版的「anon public」key。
// 这个 key 本来就是公开的，放在网页里没问题，数据安全靠数据库里的权限规则（schema.sql）。
// 千万不要填 secret / service_role key！
window.FOODRANK_CONFIG = {
  supabaseUrl: 'https://genalbwifdlimqaenoyg.supabase.co',
  supabaseAnonKey: 'sb_publishable_PJpVNiksKWh0gclLJuuV7Q_7GpYU2QY',
  // 可选：账号在背后会变成「账号@这个域名」的内部邮箱（不会真的发邮件）。
  // 一般不用改；只有 Supabase 拒绝这个域名时才换，而且要在大家注册之前定好。
  // accountEmailDomain: 'fromhang2la.app',
};
