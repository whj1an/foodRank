[English](README.md) | **中文**

# 从夯到拉 · 渥太华餐厅评分

我们俩吃过的渥太华餐厅排名，朋友也可以登录写自己的见解。

- **前端**：纯 HTML / CSS / JavaScript，不需要安装或打包
- **后端**：[Supabase](https://supabase.com)（数据库 + 登录，免费额度足够）
- **托管**：[Vercel](https://vercel.com)（免费）

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` | 页面结构 |
| `style.css` | 样式（颜色都在开头的变量里，十个等级的颜色在 `.lv-1` ~ `.lv-10`） |
| `app.js` | 所有逻辑 |
| `config.js` | 填 Supabase 的地址和公开 key |
| `supabase/schema.sql` | 数据库表和权限规则，在 Supabase 里运行一次 |

## 评级

一共 10 个等级，网页上可以随时切换三种显示样式（每个人自己的浏览器记住自己的选择）：

| 夯拉 | 字母 | 数字 |
|---|---|---|
| 夯 | A | 10 |
| 极品 | A- | 9 |
| 顶级 | B | 8 |
| 无暇 | B- | 7 |
| 人上人 | C | 6 |
| 还行 | C- | 5 |
| NPC | D | 4 |
| 路边摊 | D- | 3 |
| 拉完了 | E | 2 |
| 拉夯了 | F | 1 |

两个人的综合评级是平均值：数字样式显示小数（比如 9.5），另外两种样式四舍五入到最近的等级。

## 账号和角色

- 注册填 **账号**（只能用英文字母和数字，3–20 位，不分大小写）、**用户名**（可选）和 **密码**（至少 6 位），不需要邮箱
- 网页上优先显示用户名，没填用户名就显示账号
- 账号不能重复；大家看到的名字（用户名，或者没填时的账号）也不能重复，不分大小写
- 登录后可以随时改用户名，账号不能改

| 角色 | 能做什么 |
|---|---|
| **用户**（你们俩） | 添加 / 编辑 / 删除餐厅，给两个人评级，删除不合适的评价，导出备份 |
| **朋友**（其他注册的人） | 给每家餐厅评级 + 写见解（只能改自己的） |
| **游客**（没登录） | 能看所有餐厅、所有人的评级和见解，但不能改任何东西 |

---

## 一、创建 Supabase 项目（约 10 分钟）

1. 去 <https://supabase.com> 注册，点 **New project**
   - Region 选 **Canada (Central)**，离渥太华最近
   - 数据库密码随便设一个复杂的并记下来（网页里用不到）
2. 左边栏 **SQL Editor** → **New query** → 把 `supabase/schema.sql` 全部内容粘进去 → **Run**
   - 如果之前运行过旧版本，先按文件开头的说明清掉旧表（会删除所有数据）
3. 左边栏 **Authentication** → **Sign In / Providers** → **Email**：
   - ⚠️ **必须关掉 "Confirm email"**。网站用「账号」登录，背后是一个不会收信的内部邮箱，开着邮箱确认就没人能登录。
4. 左边栏 **Project Settings** → **API Keys**，复制两样东西填进 `config.js`：
   - **Project URL**（`https://xxxx.supabase.co`，在 Project Settings → Data API 里也能看到）
   - **Publishable key**（`sb_publishable_...`）或旧版的 **anon public** key
   - ⚠️ 不要填 secret / service_role key（网页会拒绝启动）

## 二、本地试一下

```bash
python3 -m http.server 5173
```

打开 <http://localhost:5173>：

1. 你和她分别点右上角「登录 / 注册」→「注册」，填账号、用户名、密码
2. 回到 Supabase 的 **SQL Editor**，运行（换成你们注册的账号）：

   ```sql
   update public.profiles set role = 'owner' where account in ('你的账号', '她的账号');
   ```

3. 刷新网页，右上角显示「用户」就对了

**旧数据怎么办？** 最早的本地版本把数据存在浏览器里。用**同一个浏览器**打开 <http://localhost:5173>，用你们的账号登录后，页面顶部会出现「上传到云端」的提示，点一下就行。旧的半分（比如 8.5）会四舍五入成整数等级。

## 三、发布到网上（Vercel）

1. 在 GitHub 新建一个仓库，把这个文件夹推上去
2. 去 <https://vercel.com> 用 GitHub 登录 → **Add New… → Project** → 选这个仓库
3. Framework Preset 选 **Other**，其他都不用改 → **Deploy**
4. 得到一个 `https://xxx.vercel.app` 的网址

以后每次 `git push`，Vercel 会自动更新网站。

> 不想用 Git？也可以去 <https://app.netlify.com/drop> 把整个文件夹拖进去，马上得到一个网址。

## 四、手机上用

- **iPhone**：Safari 打开网址 → 分享 → **添加到主屏幕**，用起来像个 App
- **Android**：Chrome 菜单 → **添加到主屏幕**
- **朋友**：把网址发到微信里，在微信里直接打开、注册就能写见解

## 注意事项

- 网站是公开可看的：任何拿到网址的人不用登录就能看到所有餐厅、评级、备注和见解，所以别在备注里写太私人的内容。任何人也都能注册成「朋友」来写见解；如果以后想只让受邀的朋友注册，可以再加邀请码。
- Supabase 免费项目**连续 7 天没人访问会自动暂停**，去控制台点一下 Restore 就恢复，数据不会丢。
- 定期在网页底部点「导出备份」存一份 JSON。

## 常见问题

**注册时提示「Supabase 不接受内部邮箱格式」**
账号在背后会变成 `账号@fromhang2la.app` 这样的内部邮箱。如果 Supabase 拒绝这个域名，在 `config.js` 里加一行 `accountEmailDomain: '别的域名.com'` 换一个。注意：**换了以后，之前注册的账号就登录不了了**，所以最好在大家注册之前定好。

**有人忘了密码**
没有邮箱，所以没法自己找回。在 Supabase 的 **SQL Editor** 里帮 TA 重设（换成 TA 的账号和新密码）：

```sql
update auth.users set encrypted_password = extensions.crypt('新密码', extensions.gen_salt('bf'))
where id = (select id from public.profiles where account = 'TA的账号');
```
