import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';                       // opens the database and applies the schema
import { bootstrap } from './api.js';
import { attachUser, router as authRoutes } from './auth.js';
import { router as oauthRoutes, googleReady } from './oauth.js';
import { router as adminRoutes } from './admin.js';
import { router as articleRoutes } from './articles.js';
import { router as searchRoutes } from './search.js';
import { smtpReady } from './mail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
/* resolved against this file, not the shell's cwd, so `npm start` works from
   anywhere */
const SITE_DIR = path.resolve(here, process.env.SITE_DIR || '../public');
const PAGE = process.env.PAGE || 'mathopedia-v5.html';

const app = express();
app.use(express.json());

/* ponytail: a three-line cookie parse beats a dependency */
app.use((req, _res, next) => {
  req.cookies = Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean)
    .map(c => { const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))]; }));
  next();
});
app.use(attachUser);

/* what the frontend may offer, so it never renders a control the server
   cannot honour */
app.get('/api/config', (_req, res) => res.json({ google: googleReady(), smtp: smtpReady() }));
app.get('/api/bootstrap', (_req, res) => res.json(bootstrap()));
app.use('/api', authRoutes);
app.use('/api/auth', oauthRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/articles', articleRoutes);
app.use('/api/search', searchRoutes);

/* The page is served with the current database contents inlined ahead of the
   app scripts: no fetch race, and the view keeps reading the shapes it already
   knows. Served from this origin, so the session cookie is first-party and
   there is no CORS surface at all. */
function renderPage(_req, res) {
  const html = fs.readFileSync(path.join(SITE_DIR, PAGE), 'utf8');
  const payload = JSON.stringify(bootstrap()).replace(/</g, '\\u003c');
  res.type('html').send(html.replace('</head>',
    `<script>window.__BOOTSTRAP__=${payload};</script>\n</head>`));
}
app.get(['/', '/index.html', '/' + PAGE, '/verify-email', '/reset-password'], renderPage);
app.use(express.static(SITE_DIR));

app.listen(PORT, () => {
  console.log(`Mathopedia on ${APP_URL}`);
  if (!smtpReady())   console.warn('  [warn] SMTP not configured — no email will be sent');
  if (!googleReady()) console.warn('  [warn] GOOGLE_CLIENT_ID/SECRET unset — Google sign-in hidden');
  if (!process.env.SESSION_SECRET) console.warn('  [warn] SESSION_SECRET unset — sessions drop on restart');
});
