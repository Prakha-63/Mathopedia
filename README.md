# Mathopedia

A peer-reviewed encyclopedia of mathematics. Concepts are the central object;
articles attach to them, pass through a Contributor → Reviewer → Published
workflow, and keep an append-only revision history.

**This is a local project, not a production deployment.** It runs over plain
HTTP on localhost, it has never been hardened or load-tested, and the security
notes at the end list what would have to change before it faced the internet.

---

## Overview

| | |
|---|---|
| Concepts | 111, linked by 167 prerequisite and related-to edges |
| Articles | 22 — 10 published, 12 under review |
| Revisions | 34, append-only, with side-by-side comparison |
| References | 37 normalised citations, 5 shared across articles |
| Search | SQLite FTS5, typically 2–9 ms |

Roles are `visitor`, `pending`, `contributor`, `reviewer` and `admin`. A
contributor writes and revises; a reviewer approves or returns work; an
administrator manages accounts and reads the audit log. Every role check is
enforced on the server.

## Architecture

```
public/mathopedia-v5.html     one page: markup, styles and view logic
          │
          │  same origin — no CORS, cookie is first-party
          ▼
server/   Express 4
          ├── auth.js      register, verify, login, reset, sessions
          ├── oauth.js     Google authorization-code flow
          ├── mail.js      SMTP via nodemailer
          ├── articles.js  create, revise, versions, references
          ├── refs.js      citation normalisation and URL checks
          ├── search.js    FTS5 query building, ranking, indexing
          ├── admin.js     users, roles, audit, stats
          ├── audit.js     append-only action log
          ├── api.js       the bootstrap payload
          ├── http.js      shared route error wrapper
          └── db.js        SQLite handle and query helpers
          ▼
data/mathopedia.db           SQLite + FTS5
```

The server reads the database once per page load and injects it as
`window.__BOOTSTRAP__` ahead of the app scripts, so the first render is
already database-backed and there is no fetch race. The page holds no copy of
the encyclopedia; without the server it shows an explicit *server unavailable*
state.

## Requirements

- **Node.js 22.5 or newer.** The built-in `node:sqlite` module is required;
  there is no `better-sqlite3` to compile.
- No database server, no build step, no bundler.

## Installation

```bash
npm install
cp .env.example .env     # then edit, see below
npm start
```

Open <http://localhost:3001>.

## Environment variables

All of them live in `.env`, which is git-ignored. `.env.example` is the
template.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | Defaults to 3001 |
| `APP_URL` | no | Base URL used in emails and the OAuth callback |
| `DATABASE_URL` | no | Defaults to `file:../data/mathopedia.db` |
| `SESSION_SECRET` | **yes** | Mixed into session token hashes. If unset a random one is generated per boot, so every restart signs everyone out |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASSWORD` | for email | Verification and password-reset messages |
| `SMTP_FROM` | no | Defaults to `SMTP_USER` |
| `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` | for Google | Google sign-in; the button is hidden when unset |
| `COOKIE_SECURE` | no | Set to `1` only when served over HTTPS |

The server prints a warning at startup for each capability that is not
configured, and `/api/config` tells the page which controls to show — it never
renders a button the server cannot honour.

## Database setup

`data/mathopedia.db` is committed to nobody: it is git-ignored, and the schema
is applied automatically at startup from `server/schema.sql`, which is written
with `CREATE TABLE IF NOT EXISTS` throughout. Starting the server against an
empty directory gives you an empty but valid database.

To load the seed content:

```bash
npm run migrate      # idempotent — safe to re-run
```

To check the database and search index:

```bash
npm run check        # exits non-zero if anything fails
```

Back up by copying the file, but checkpoint the write-ahead log first or the
copy may be missing recent writes:

```bash
node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('./data/mathopedia.db');d.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();d.close()"
cp data/mathopedia.db data/backups/mathopedia-$(date +%Y%m%d).db
```

## SMTP setup

Any SMTP provider works. With Gmail you need an **app password**, not your
account password — enable 2-Step Verification, then create one under App
passwords and use the 16-character value as `SMTP_PASSWORD`.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your-16-char-app-password
SMTP_FROM=Mathopedia <you@gmail.com>
```

Port 465 is detected as implicit TLS; anything else uses STARTTLS. Without
SMTP configured, registration still creates the account but no mail is sent,
so the address cannot be confirmed.

## Google OAuth setup

1. In the Google Cloud console create an **OAuth 2.0 Client ID** of type *Web
   application*.
2. Add the authorised redirect URI exactly:
   `http://localhost:3001/api/auth/google/callback`
3. Put the client ID and secret in `.env` and restart.

The flow is server-side: the browser never sees the secret, the authorization
code is exchanged directly with Google, and the profile is read from Google's
userinfo endpoint — nothing is verified client-side. A random `state` is kept
in an HttpOnly cookie and compared on return. An account created this way
starts verified and with no password; one can be set later through password
reset.

## Running locally

```bash
npm start       # http://localhost:3001
npm run check   # database and index integrity
npm run migrate # import seed data (idempotent)
```

The server serves the page and the API from one origin, so the session cookie
is first-party and there is no CORS configuration anywhere.

## Admin setup

The seeded administrator signs in with username `admin`. Demo accounts for the
other roles are listed on the sign-in page; they are ordinary database rows
checked against a bcrypt hash like any other account.

To promote an existing account from the command line:

```bash
node --experimental-sqlite --env-file=.env -e "import('./server/db.js').then(({run})=>run(\"UPDATE users SET role='admin', email_verified=1 WHERE email=?\", 'you@example.com'))"
```

The console refuses to remove the last administrator, to change your own role,
or to suspend your own account.

## Project structure

```
mathopedia/
├── public/
│   └── mathopedia-v5.html     the entire frontend
├── server/                    Express + SQLite (12 modules, ~1.5k lines)
│   ├── server.js  db.js  schema.sql  http.js  api.js
│   ├── auth.js  oauth.js  mail.js  audit.js
│   └── articles.js  refs.js  search.js  admin.js
├── scripts/
│   ├── migrate.js             one-off seed import
│   ├── check.js               integrity checks
│   └── dump.json              seed data
├── data/                      the database (git-ignored)
├── .env.example
├── package.json
└── README.md
```

## Security notes

What the code does today:

- Passwords are hashed with bcrypt at cost 12 and never logged.
- Sessions are opaque server-side rows; the cookie is HttpOnly and
  SameSite=Lax. `active` is re-read on every request, so suspending an account
  ends its live sessions immediately.
- Verification and reset tokens are stored hashed, single-use, expiring, and
  scoped by purpose — a verification token cannot be replayed as a reset.
- Password reset does not reveal whether an address is registered.
- Rate limits apply to login, registration, resend and reset.
- Every role check runs on the server. The registration endpoint accepts no
  role; new accounts are always `visitor`.
- Reference URLs are restricted to `http` and `https` server-side, so
  `javascript:` and `data:` can never reach an `href`.
- Every SQL statement is parameterised.
- Errors are logged server-side; clients get a generic message.

**Before this could face the internet**, at minimum: serve over HTTPS and set
`COOKIE_SECURE=1`; set a real `SESSION_SECRET`; move rate limiting to
per-IP as well as per-identifier; add CSRF tokens for cookie-authenticated
state changes; review the admin console's exposure of email addresses and IPs;
and replace the demo accounts. None of that is done — this is a local project.
