# Deploying this to a real, live URL (GitHub + Supabase + Vercel)

This walks through getting the app running on the actual internet, testable from any
browser — not just previewable, but backed by a real Postgres database and the real
engines. Every step below happens in a web dashboard; the only local tool you strictly
need is a way to get this code onto GitHub (a one-time step, covered below).

Three free accounts, if you don't already have them:

- **GitHub** (github.com) — hosts the code; Vercel builds directly from it.
- **Supabase** (supabase.com) — hosts the Postgres database.
- **Vercel** (vercel.com) — builds and hosts the app itself.

None of this depends on npm working in any sandbox — Vercel's own build servers run
`npm install` with full internet access when they build your project. The npm registry
restriction that shows up throughout this codebase's comments is specific to the
environment this was built in, not something you'll hit here.

## 1. Get the code onto GitHub

If you're comfortable with `git`:

```bash
cd debt-equity-platform
git init
git add .
git commit -m "Initial commit"
gh repo create debt-equity-platform --private --source=. --push   # or create the repo on github.com first, then git remote add + push
```

If you'd rather not use the command line: create a new repository at github.com/new,
then use GitHub's "uploading an existing file" web page to drag the project folder's
contents in. Either way, make sure `.gitignore` (already in this repo) is respected so
`node_modules/` and `.env` don't get committed.

## 2. Create the Supabase project and load the schema

1. At supabase.com, create a new project (pick any region; note the database password
   you set — you'll need it below). Wait for it to finish provisioning (a couple of
   minutes).
2. Open the **SQL Editor** in the Supabase dashboard, paste the entire contents of
   `db/schema.sql`, and run it. This creates every table, enum, index, and foreign key
   — the exact same DDL that was executed and validated against a real Postgres 16
   instance while building this (see the README's "relational schema" section).
3. **Also run `db/seed.sql`** (same SQL Editor) — as of v0.13.0 this is no longer just
   optional sample data: it's also how you get your very first login. It adds one
   sample entity with a stock option grant and a term loan (skip that part if you'd
   rather start from a clean database), but it also creates the one bootstrap user
   account (`bootstrap@example.com` / `changeme123!`) that owns that entity — see that
   file's header comment. Without running this (or inserting a `User`/`EntityAccess`
   row yourself), there is no way to log into a freshly deployed instance at all: the
   in-app "create a user" endpoint requires already being logged in as an OWNER.
   **Change the bootstrap password immediately after your first login** — see the
   security note below.
4. From the project page, click **Connect** and find the connection string section.
   You need two variants:
   - The **pooled** connection (port **6543**) — this is `DATABASE_URL`. Make sure
     `?pgbouncer=true` is on the end of it; append it if it isn't.
   - The **direct** connection (port **5432**) — this is `DIRECT_URL`.
   Both look like `postgresql://postgres.xxxxx:[PASSWORD]@aws-0-<region>.pooler.supabase.com:<port>/postgres`
   — substitute the database password from step 1 for `[PASSWORD]`.

## 3. Deploy to Vercel

1. At vercel.com, **Add New Project**, import the GitHub repo you created in step 1.
   Vercel auto-detects Next.js — you shouldn't need to change any build settings.
2. Before deploying, add **Environment Variables**:
   - `DATABASE_URL` — the pooled connection string from step 2.
   - `DIRECT_URL` — the direct connection string from step 2.
   - `SESSION_SECRET` — see the security note below. **Set this before deploying**, not
     after: `src/middleware.ts` fails closed (every page and API route returns a 500)
     if it's unset, rather than silently letting requests through unauthenticated. A
     quick way to generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
3. Click **Deploy**. Vercel runs `npm install` (which triggers `prisma generate` via
   this repo's `postinstall` script — no manual step needed) and then `npm run build`.
4. Once it finishes, you get a real `https://your-project.vercel.app` URL. Open it —
   you'll land on a login page (`/login`), not a Basic Auth browser prompt: log in with
   the bootstrap account from step 2 above (`bootstrap@example.com` / `changeme123!`).

Every time you push a new commit to GitHub, Vercel automatically rebuilds and
redeploys — that's the "live" part: editing code, pushing, and seeing the change on the
real URL a minute or two later, without ever installing Node.js locally.

## Security note — read before you deploy

**As of v0.13.0, this app has real per-user authentication and per-entity
authorization** — see the README's "Real authentication and multi-tenancy" section for
the full design. This replaces the earlier (through v0.12.0) shared-password Basic Auth
stopgap entirely; if you're upgrading an existing deployment rather than starting fresh,
see the migration note in `.env.example`.

What this means in practice: every user is a real row in the `User` table with their
own scrypt-hashed password and their own session; every entity's data is only visible
to (and, depending on role, editable by) the specific users granted access to it via
`EntityAccess` (OWNER, EDITOR, or VIEWER — see `prisma/schema.prisma`'s doc comments);
an authenticated user with no grant on a given entity gets the same 404 a nonexistent
entity ID would, never a 403, so they can't even confirm the entity exists. Sessions are
signed (HMAC-SHA256), tamper-evident cookies with a 7-day expiry, not indefinite like
the old Basic Auth credential was.

**You still need to do a few things a production auth system would normally handle for
you:** there's no self-service "forgot password" or "change password" UI yet (rotating
the bootstrap account's password today means generating a new hash with
`hashPassword()` from `src/lib/auth/passwordHashing.ts` and updating the `User` row
directly in Supabase's Table Editor or SQL Editor); there's no rate limiting on login
attempts; and there's no audit trail of who did what beyond whatever Vercel's own
request logs capture. None of these are as serious as the old stopgap's complete lack
of per-user identity, but they're real gaps against a production-grade system —
tracked in the README's "Gaps" section, not swept under the rug.

**Change the bootstrap password immediately after your first login.** `bootstrap@example.com`
/ `changeme123!` is a well-known, publicly-documented credential (it's printed in
`db/seed.sql`) — treat it as compromised by default on any deployment that will ever
hold real client data. Use it once to log in and either create your real first user via
the "grant access" flow (`POST /api/auth/users` — there's no UI for this yet, so it's a
`curl`/Postman call while logged in as the bootstrap user) or change the bootstrap
user's own password hash directly, then never use the well-known credential again.

`SESSION_SECRET` is the one secret that matters most here: anyone who obtains it can
forge a valid session for any user ID without ever knowing a password. Generate it with
real randomness (see the env var comment above), never reuse it across environments,
and rotating it is also your emergency "log everyone out everywhere" button if you ever
suspect it's leaked — every existing session becomes unverifiable the instant it
changes.

## If something breaks

- **Build fails with a Prisma "engine not found" or binary-related error**: Prisma
  needs to know which binary target to generate for Vercel's runtime; check Prisma's
  current [Deploy to Vercel guide](https://www.prisma.io/docs/orm/prisma-client/deployment/serverless/deploy-to-vercel)
  for the current `binaryTargets` recommendation — this can change with Prisma/Vercel
  runtime versions, so it wasn't safe to hard-code a value here without being able to
  verify it against a live deploy.
- **Intermittent "prepared statement already exists" errors once the app is live**:
  almost always means `?pgbouncer=true` is missing from `DATABASE_URL`.
- **`npx prisma migrate dev` and `db/schema.sql` drift apart over time**: if you change
  `prisma/schema.prisma` later, update `db/schema.sql` to match and re-run it against
  Supabase's SQL Editor (or switch to `prisma migrate deploy` once you're comfortable
  running Prisma CLI commands locally) — see the note in `db/schema.sql`'s header.
