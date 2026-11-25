**English** | [中文](README.zh-CN.md)

# 从夯到拉 (From "Hang" to "La") · Ottawa Restaurant Ratings

A ranking of the Ottawa restaurants the two of us have eaten at. Friends can sign in and add their own reviews too.

The site's interface is in Chinese. "夯" (hāng) to "拉" (lā) is Chinese internet slang for a tier list, from "absolutely top" down to "total flop".

- **Front end**: plain HTML / CSS / JavaScript. Nothing to install or build.
- **Back end**: [Supabase](https://supabase.com) (database + sign-in; the free tier is plenty)
- **Hosting**: [Vercel](https://vercel.com) (free)

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | Styles (colors are variables at the top of the file; the ten rating colors are `.lv-1` to `.lv-10`) |
| `app.js` | All the logic |
| `config.js` | Your Supabase URL and public key go here |
| `supabase/schema.sql` | Database tables and access rules; run it once in Supabase |
| `manifest.webmanifest`, `icons/` | Name and icons used when adding the site to a phone's home screen |

## Ratings

There are 10 levels. Visitors can switch between three display styles at any time; each browser remembers its own choice.

| Tier (Chinese slang) | Letter | Number |
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

The couple's combined rating is the average of both scores. The number style shows decimals (e.g. 9.5); the other two styles round to the nearest level.

## Accounts and roles

- To register you enter an **account** (letters and digits only, 3–20 characters, not case-sensitive), an optional **username**, and a **password** (at least 6 characters). No email needed.
- The site shows the username if there is one, otherwise the account.
- Accounts must be unique, and so must the name everyone sees (the username, or the account if no username was set), ignoring case.
- Once signed in, you can change your username at any time. The account can't be changed.

| Role | What they can do |
|---|---|
| **Users** (the two of us) | Add / edit / delete restaurants, rate for either of us, remove inappropriate reviews, export backups |
| **Friends** (everyone else who registers) | Rate each restaurant and write a review (can only edit their own) |
| **Visitors** (not signed in) | See every restaurant, rating and review, but can't change anything |

---

## 1. Create a Supabase project (about 10 minutes)

1. Sign up at <https://supabase.com> and click **New project**
   - For Region, pick **Canada (Central)**, the closest to Ottawa
   - Set any strong database password and save it (the website doesn't use it)
2. Sidebar **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` → **Run**
   - If you ran an older version before, first clear the old tables using the instructions at the top of that file (this deletes all data)
3. Sidebar **Authentication** → **Sign In / Providers** → **Email**:
   - ⚠️ **You must turn off "Confirm email".** The site signs people in with an account name, backed by an internal email address that never receives mail. With email confirmation on, nobody can sign in.
4. Sidebar **Project Settings** → **API Keys**, and copy two values into `config.js`:
   - **Project URL** (`https://xxxx.supabase.co`, also shown under Project Settings → Data API)
   - **Publishable key** (`sb_publishable_...`) or the legacy **anon public** key
   - ⚠️ Never use a secret / service_role key (the site refuses to start if you do)

## 2. Try it locally

```bash
python3 -m http.server 5173
```

Open <http://localhost:5173>:

1. Each of you clicks "登录 / 注册" (Sign in / Register) at the top right → "注册" (Register), and fills in an account, username and password
2. Back in the Supabase **SQL Editor**, run this (with your own two accounts):

   ```sql
   update public.profiles set role = 'owner' where account in ('your_account', 'partner_account');
   ```

3. Refresh the page. If the top right shows "用户" (User), it worked.

**What about old data?** The very first local-only version stored data in the browser. Open <http://localhost:5173> in **the same browser**, sign in with one of your accounts, and click the "上传到云端" (Upload to cloud) banner at the top. Old half-point scores (like 8.5) are rounded to whole levels.

## 3. Publish online (Vercel)

1. Create a repository on GitHub and push this folder to it
2. Sign in to <https://vercel.com> with GitHub → **Add New… → Project** → choose the repository
3. Set Framework Preset to **Other**, leave everything else as is → **Deploy**
4. You'll get a URL like `https://xxx.vercel.app`

From then on, every `git push` updates the site automatically.

> **After changing `style.css` or `app.js`**: bump the number after `?v=` in `index.html` (e.g. `style.css?v=3` → `?v=4`), otherwise phone browsers may keep using the old cached copy.

> Don't want to use Git? Drag the whole folder onto <https://app.netlify.com/drop> to get a URL right away.

## 4. Use it on your phone

- **iPhone**: open the URL in Safari → Share → **Add to Home Screen**, and it works like an app
- **Android**: Chrome menu → **Add to Home screen**
- **Friends**: send the URL in WeChat; they can open it there, register, and start writing reviews

## Things to keep in mind

- The site is publicly viewable: anyone with the URL can see every restaurant, rating, note and review without signing in, so don't put anything too personal in the notes. Anyone can also register as a "friend" and write reviews; an invite code could be added later to limit sign-ups.
- Free Supabase projects **pause after 7 days without any visits**. Click Restore in the dashboard to bring it back; no data is lost.
- Use "导出备份" (Export backup) at the bottom of the page now and then to save a JSON copy.

## FAQ

**Registration says Supabase doesn't accept the internal email format**
Behind the scenes, an account becomes an internal email like `account@fromhang2la.app`. If Supabase rejects that domain, add a line `accountEmailDomain: 'another-domain.com'` to `config.js`. Note: **after changing it, accounts registered earlier can no longer sign in**, so settle this before anyone registers.

**Someone forgot their password**
There's no email, so they can't reset it themselves. Reset it for them in the Supabase **SQL Editor** (with their account and the new password):

```sql
update auth.users set encrypted_password = extensions.crypt('new_password', extensions.gen_salt('bf'))
where id = (select id from public.profiles where account = 'their_account');
```
