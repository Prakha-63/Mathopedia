import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { one, run, now } from './db.js';
import { audit } from './audit.js';
import { sendVerification, sendReset } from './mail.js';
import { ok } from './http.js';

export const router = express.Router();

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const norm = e => String(e || '').trim().toLowerCase();
const userByEmail = e => one('SELECT * FROM users WHERE email = ?', norm(e));
const userByUsername = u => one('SELECT * FROM users WHERE username = ?', norm(u));

/* sign-in accepts either, so the seeded demo logins ("reviewer") still work
   while real accounts use their address */
const lookup = idf => userByEmail(idf) || userByUsername(idf);

const pub = u => ({ email: u.email, name: u.name, username: u.username,
  role: u.role, credential: u.credential, emailVerified: !!u.email_verified });

/* ---------------------------------------------------------------- limits */
function limited(bucket, max, windowMs, msg) {
  run('DELETE FROM attempts WHERE at < ?', now() - 86400e3);
  const n = one('SELECT COUNT(*) c FROM attempts WHERE bucket = ? AND at > ?', bucket, now() - windowMs).c;
  if (n >= max) return msg;
  run('INSERT INTO attempts (bucket, at) VALUES (?, ?)', bucket, now());
  return null;
}
const emailLimit = e => limited(`mail:${e}`, 5, 3600e3, 'Too many emails for this address. Try again later.')
                     || limited(`mail1:${e}`, 1, 60e3, 'Please wait a minute before requesting another email.');
const loginLimit = e => limited(`login:${e}`, 10, 900e3, 'Too many sign-in attempts. Try again in 15 minutes.');

/* ---------------------------------------------------------------- tokens
   Stored hashed with a purpose, so the raw value exists only inside the email
   and a verification token cannot be replayed as a reset. */
function issueToken(email, purpose, minutes) {
  run('DELETE FROM tokens WHERE email = ? AND purpose = ?', email, purpose);
  const raw = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO tokens (token_hash,email,purpose,expires_at) VALUES (?,?,?,?)',
      sha(raw), email, purpose, now() + minutes * 60e3);
  return raw;
}
function consumeToken(raw, purpose) {
  const t = one('SELECT * FROM tokens WHERE token_hash = ? AND purpose = ?', sha(raw || ''), purpose);
  if (!t || t.used_at) return { error: 'That link is invalid or has already been used.' };
  if (t.expires_at < now()) return { error: 'That link has expired. Request a new one.' };
  run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', now(), t.token_hash);
  return { email: t.email };
}

/* six digits from the CSPRNG, rejection-sampled so no digit is favoured */
function sixDigits() {
  const out = [];
  while (out.length < 6)
    for (const b of crypto.randomBytes(32)) {
      if (b < 250) { out.push(b % 10); if (out.length === 6) break; }
    }
  return out.join('');
}
function issueCode(email, purpose, minutes) {
  run('DELETE FROM tokens WHERE email = ? AND purpose = ?', email, purpose);
  const code = sixDigits();
  run('INSERT INTO tokens (token_hash,email,purpose,expires_at) VALUES (?,?,?,?)',
      sha(code), email, purpose, now() + minutes * 60e3);
  return code;
}
function checkCode(email, code, purpose) {
  const t = one('SELECT * FROM tokens WHERE email = ? AND purpose = ?', email, purpose);
  if (!t || t.used_at) return { error: 'No active code for that address. Request a new one.' };
  if (t.expires_at < now()) return { error: 'That code has expired. Request a new one.' };
  if (t.attempts >= 5) {
    run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', now(), t.token_hash);
    return { error: 'Too many incorrect attempts. Request a new code.' };
  }
  if (t.token_hash !== sha(String(code || '').trim())) {
    run('UPDATE tokens SET attempts = attempts + 1 WHERE token_hash = ?', t.token_hash);
    return { error: `Incorrect code. ${4 - t.attempts} attempt${t.attempts === 3 ? '' : 's'} left.` };
  }
  run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', now(), t.token_hash);
  return { email: t.email };
}

/* ---------------------------------------------------------------- sessions */
const COOKIE = 'mathopedia_sid';
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

export function startSession(res, userId) {
  const raw = crypto.randomBytes(32).toString('base64url');
  run('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)',
      sha(raw + SECRET), userId, now() + 7 * 864e5);
  res.cookie(COOKIE, raw, { httpOnly: true, sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1', maxAge: 7 * 864e5, path: '/' });
}
function endSession(req, res) {
  const raw = req.cookies[COOKIE];
  if (raw) run('DELETE FROM sessions WHERE token_hash = ?', sha(raw + SECRET));
  res.clearCookie(COOKIE, { path: '/' });
}
function sessionUser(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const s = one('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha(raw + SECRET), now());
  if (!s) return null;
  const u = one('SELECT * FROM users WHERE id = ?', s.user_id);
  return u && u.active ? u : null;      // a suspension takes effect on the next request
}

/* attach the signed-in user to every request, so routes and the audit log
   never have to look it up themselves */
export function attachUser(req, _res, next) { req.user = sessionUser(req); next(); }

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (roles.length && !roles.includes(req.user.role))
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    next();
  };
}


/* ---------------------------------------------------------------- routes */
router.post('/register', ok(async (req, res) => {
  const { email, password, name, username } = req.body || {};
  const e = norm(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if ((password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (userByEmail(e)) return res.status(409).json({ error: 'That email already has an account.' });
  if (username && userByUsername(username)) return res.status(409).json({ error: 'That username is already taken.' });
  const lim = emailLimit(e); if (lim) return res.status(429).json({ error: lim });

  run('INSERT INTO users (email,password_hash,name,username,created_at) VALUES (?,?,?,?,?)',
      e, await bcrypt.hash(password, 12), name || null, norm(username) || null, now());
  req.actorName = e;
  audit(req, 'register', e, 'account created, verification sent');
  await sendVerification(e, issueToken(e, 'verify', 60 * 24), issueCode(e, 'verify_code', 10));
  res.json({ needsVerification: true });
}));

router.post('/verify-email', ok(async (req, res) => {
  const r = consumeToken(req.body?.token, 'verify');
  if (r.error) return res.status(400).json(r);
  run('UPDATE users SET email_verified = 1 WHERE email = ?', r.email);
  req.actorName = r.email;
  audit(req, 'verify_email', r.email, 'verified via link');
  res.json({ ok: true });
}));

router.post('/verify-code', ok(async (req, res) => {
  const e = norm(req.body?.email);
  const lim = limited(`code:${e}`, 10, 900e3, 'Too many attempts. Try again in 15 minutes.');
  if (lim) return res.status(429).json({ error: lim });
  const r = checkCode(e, req.body?.code, 'verify_code');
  if (r.error) return res.status(400).json(r);
  run('UPDATE users SET email_verified = 1 WHERE email = ?', r.email);
  req.actorName = r.email;
  audit(req, 'verify_email', r.email, 'verified via code');
  res.json({ ok: true });
}));

router.post('/resend-verification', ok(async (req, res) => {
  const e = norm(req.body?.email);
  const lim = emailLimit(e); if (lim) return res.status(429).json({ error: lim });
  const u = userByEmail(e);
  if (u && !u.email_verified)
    await sendVerification(e, issueToken(e, 'verify', 60 * 24), issueCode(e, 'verify_code', 10));
  res.json({ ok: true });                 // identical answer either way
}));

router.post('/login', ok(async (req, res) => {
  const idf = norm(req.body?.email);
  const lim = loginLimit(idf); if (lim) return res.status(429).json({ error: lim });
  const u = lookup(idf);
  if (!u || !u.password_hash || !await bcrypt.compare(req.body?.password || '', u.password_hash)) {
    req.actorName = idf;
    audit(req, 'login_failed', idf, 'bad credentials');
    return res.status(401).json({ error: 'Unrecognised email or password.' });
  }
  if (!u.active) return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
  if (!u.email_verified)
    return res.status(403).json({ error: 'That email has not been verified yet. Check your inbox, or resend the link.' });
  startSession(res, u.id);
  req.user = u;
  audit(req, 'login', u.email, `role ${u.role}`);
  res.json({ user: pub(u) });
}));

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: pub(req.user) });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'logout', req.user.email, null);
  endSession(req, res);
  res.json({ ok: true });
});

router.post('/forgot-password', ok(async (req, res) => {
  const e = norm(req.body?.email);
  const lim = emailLimit(e); if (lim) return res.status(429).json({ error: lim });
  if (userByEmail(e)) await sendReset(e, issueToken(e, 'reset', 60));
  res.json({ ok: true });                 // never reveals whether the address is registered
}));

router.post('/reset-password', ok(async (req, res) => {
  const { token, password } = req.body || {};
  if ((password || '').length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const r = consumeToken(token, 'reset');
  if (r.error) return res.status(400).json(r);
  const u = userByEmail(r.email);
  if (!u) return res.status(400).json({ error: 'That link is invalid.' });
  run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?',
      await bcrypt.hash(password, 12), u.id);
  run('DELETE FROM sessions WHERE user_id = ?', u.id);     // reaching the inbox ends every old session
  res.clearCookie(COOKIE, { path: '/' });
  req.actorName = u.email;
  audit(req, 'password_reset', u.email, 'all sessions invalidated');
  res.json({ ok: true });
}));
