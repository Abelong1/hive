# HIVE — CPE Thesis Digital Archive (prototype)

Static site + Supabase backend (project `hive-archive`, Singapore).

| Page | Who | What |
|---|---|---|
| `index.html` | public | Browse approved entries (read-only) |
| `portal.html` | researchers | Sign in, redeem invite code, create/edit own entry |
| `activity.html` | ACES admins | Activity logs: edits (with restore), status, sign-ins, codes, consent, alerts, CSV export |
| `admin.html` | ACES admins | Approve/reject, take down, issue invite codes, adviser photos |

## Go live
1. **Deploy** this folder to Vercel (project root = this folder). `vercel.json` adds the security headers.
2. **Supabase dashboard → Authentication**
   - URL Configuration: set Site URL to the deployed URL; add `<url>/portal.html` to Redirect URLs.
   - Providers → Email: keep "Confirm email" ON, minimum password length 10.
   - Attack Protection: turn on CAPTCHA (Turnstile or hCaptcha).
   - SMTP: the built-in sender allows only a few emails per hour. Add a custom SMTP before real students sign up.
3. **First admin**: sign up on the portal, confirm the email, then run in the SQL editor:
   `insert into public.profiles (id, full_name, role) select id, 'Your Name', 'admin' from auth.users where email = 'you@example.com';`
4. Admin page → Invite codes → create one per thesis group.
5. When real entries exist: Admin → Published → "Delete all sample entries".

## Activity log
- `supabase/activity_log.sql` (already applied). Triggers write every change to `activity_log`; only admins can read it; nobody can edit or delete it through the API.
- Sign-in history needs Supabase's auth audit log in the database: Dashboard → Authentication → Audit Logs → turn OFF "Disable writing auth audit logs to project database". Failed portal sign-ins are logged regardless.

## Rules enforced by the database (not the pages)
- Public sees only `approved` rows and never `owner_id` or consent fields.
- A researcher can only read/edit their own rows; any edit sends an approved entry back to `pending`.
- Nothing can be approved without both consent boxes recorded.
- Only admins can approve, issue or revoke codes. Codes are single-use and expire in 7 days.
- Photos: JPG/PNG/WebP, max 2 MB, uploaded only into the uploader's own folder.

## Never
- Put the Supabase `service_role`/secret key in any file here. Only the publishable key (in `js/config.js`) belongs in the browser.
- Give admin to more people than needed; enable 2FA on the Supabase, Vercel, GitHub and domain accounts.
