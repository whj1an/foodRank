**English** | [中文](README.zh-CN.md)

# 锐评 (Ruìpíng) · Restaurant Tier List for Ottawa & Toronto

A tier list of the restaurants we've eaten at, kept separately for Ottawa and Toronto. Two people can bind their accounts and share one list.

The site's interface is in Chinese. "从夯到拉" (from "夯" to "拉") is Chinese internet slang for a tier list, from "夯" (hāng, absolutely top) down to "拉完了" (lā wán le, total flop).

- **Front end**: plain HTML / CSS / JavaScript. Nothing to install or build. Designed for phone browsers first.
- **Back end**: [Supabase](https://supabase.com) (database + sign-in + photo storage; the free tier is plenty)
- **Hosting**: [Vercel](https://vercel.com) (free)

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `style.css` | Styles (colors are variables at the top of the file; the ten rating colors are `.lv-1` to `.lv-10`) |
| `app.js` | All the logic |
| `config.js` | Your Supabase URL and public key go here, plus whose list visitors see |
| `supabase/schema.sql` | Database tables, access rules and the photo bucket; run it once in Supabase |
| `supabase/upgrade-from-v1.sql` | Only for upgrading from the first version (从夯到拉) |
| `manifest.webmanifest`, `icons/` | Name and icons used when adding the site to a phone's home screen |
| `docs/Requirements.md` | The product spec |

## How it works

- **Regions**: the title "锐评 ▾" opens a menu to switch between Ottawa and Toronto. Each region has its own list; a restaurant added in Ottawa never shows up in Toronto.
- **The list**: 10 rows (levels), plus a "待评" (to be rated) row at the bottom. New restaurants go into 待评 in the order they were added.
- **Reading**: tap a restaurant to see its tier, full name, photos (swipe left / right; they loop, so the first photo follows the last), details, and who added and ranked it.
- **Search**: type in the search box. Only restaurants whose name or details match stay visible, highlighted and in their usual order; the rest are hidden. Tap × to clear.
- **Ranking**: tap "编辑" (Edit). The page switches to a fresh, empty list plus the 待评 row. Long-press a restaurant, drag it onto a row (the row lights up and shows where it will snap; in the 夯拉 style it's the height of your finger that picks one of the two rows next to a label), let go, and tap "完成" (Done) to save. Restaurants ranked in the same batch sit left to right by when they were added, in front of the ones ranked earlier.
- **Adding**: the square "+" next to the search box, or "添加" in the bottom bar. Enter a name, up to 3 photos (uploaded at original size; the first is the cover), and any number of details (120 characters each).
- **Mistakes**: in a restaurant's detail sheet, "编辑" changes its name / photos / details, "放回待评" moves it back to the 待评 row so you can rank it again, and "删除" deletes it.

### Rating styles

Switch with the buttons above the list; each browser remembers its own choice. The list always has 10 rows. The letter and number styles label every row; the 夯拉 style uses only the five original tiers of the meme, and each one covers two rows (for example, the row between 夯 and 顶级 belongs to 夯):

| 夯拉 (5 tiers) | Letter | Number |
|---|---|---|
| 夯 | A, A- | 10, 9 |
| 顶级 | B, B- | 8, 7 |
| 人上人 | C, C- | 6, 5 |
| NPC | D, D- | 4, 3 |
| 拉完了 | E, F | 2, 1 |

## Accounts

- There are two kinds of people: **users** (signed in) and **visitors** (not signed in).
- To register you enter a **username** (letters and digits only, 3–20 characters, not case-sensitive) and a **password** (at least 6 characters). You sign in with the same username. No email needed.
- Every user has their own list. Visitors can see a list but can't change anything. Which list they see is set by `homeUser` in `config.js`.
- **Binding**: two bound users share one list. What either of them adds appears in both people's 待评 row, and either can rank it. If both rank at the same time, whoever taps "完成" later wins.
- **Unbinding**: in the account sheet (bottom bar → "账户"), tap the underlined "已绑定 xxx，取消绑定". Both people keep a full copy of the list as it was, and from then on each has their own.
- Binding is done once in the Supabase SQL Editor (see step 2 below); there's no button for it.

---

## 1. Create a Supabase project (about 10 minutes)

1. Sign up at <https://supabase.com> and click **New project**
   - For Region, pick **Canada (Central)**
   - Set any strong database password and save it (the website doesn't use it)
2. Sidebar **SQL Editor** → **New query** → paste the whole of `supabase/schema.sql` → **Run**
   - **Upgrading from the first version (从夯到拉)?** First run `supabase/upgrade-from-v1.sql` (this deletes the old restaurants and reviews; existing logins are kept), then `schema.sql`.
   - Don't run `schema.sql` a second time on a database that's already set up.
3. Sidebar **Authentication** → **Sign In / Providers** → **Email**:
   - ⚠️ **You must turn off "Confirm email".** The site signs people in with a username, backed by an internal email address that never receives mail. With email confirmation on, nobody can sign in.
4. Sidebar **Project Settings** → **API Keys**, and copy two values into `config.js`:
   - **Project URL** (`https://xxxx.supabase.co`, also shown under Project Settings → Data API)
   - **Publishable key** (`sb_publishable_...`) or the legacy **anon public** key
   - ⚠️ Never use a secret / service_role key (the site refuses to start if you do)
5. In `config.js`, set `homeUser` to the username whose list visitors should see.

## 2. Register and bind

1. Open the site, tap "登录 / 注册" (Sign in / Register) at the top right → "注册" (Register), and each of you registers a username and password.
2. In the Supabase **SQL Editor**, bind the two accounts (with your own usernames):

   ```sql
   select public.bind_users('first_username', 'second_username');
   ```

   The second person moves into the first person's list, bringing along anything they'd already added.
3. Refresh the page. In "账户" (Account) at the bottom, you should see "已绑定 …" (Bound to …).

## 3. Try it locally

```bash
python3 -m http.server 5173
```

Open <http://localhost:5173>. It uses the same Supabase database as the live site.

## 4. Publish online (Vercel)

1. Create a repository on GitHub and push this folder to it
2. Sign in to <https://vercel.com> with GitHub → **Add New… → Project** → choose the repository
3. Set Framework Preset to **Other**, leave everything else as is → **Deploy**
4. You'll get a URL like `https://xxx.vercel.app`

From then on, every `git push` updates the site automatically.

> **After changing `style.css` or `app.js`**: bump the number after `?v=` in `index.html` (e.g. `style.css?v=4` → `?v=5`), otherwise phone browsers may keep using the old cached copy.

> **When a change also needs new SQL**: run the SQL in Supabase first, then push the code. The new page doesn't work against the old database.

## 5. Use it on your phone

- **Android**: open the URL in Chrome → menu → **Add to Home screen**
- **iPhone**: open the URL in Safari → Share → **Add to Home Screen**

## Things to keep in mind

- The site is publicly viewable: anyone with the URL can see the list, photos and details without signing in, so don't put anything too personal in them. Anyone can also register their own account (with their own separate list).
- Photos are stored at original size. The free Supabase plan includes 1 GB of storage, which is roughly a few hundred phone photos. Each photo also gets a small thumbnail for the list.
- iPhone photos in HEIC format: Safari usually converts them to JPG when uploading. If a photo can't be opened, the page says so; pick a JPG or PNG instead.
- Free Supabase projects **pause after 7 days without any visits**. Click Restore in the dashboard to bring it back; no data is lost.
- Use "导出备份" (Export backup) in the account sheet now and then to save a JSON copy (photos are saved as links).

## FAQ

**Registration says Supabase doesn't accept the internal email format**
Behind the scenes, a username becomes an internal email like `username@fromhang2la.app`. If Supabase rejects that domain, add a line `accountEmailDomain: 'another-domain.com'` to `config.js`. Note: **after changing it, accounts registered earlier can no longer sign in**, so settle this before anyone registers.

**Someone forgot their password**
There's no email, so they can't reset it themselves. Reset it for them in the Supabase **SQL Editor** (with their username and the new password):

```sql
update auth.users set encrypted_password = extensions.crypt('new_password', extensions.gen_salt('bf'))
where id = (select id from public.profiles where username = 'their_username');
```
