import express from 'express';
import crypto from 'node:crypto';
import { one, run, now } from './db.js';
import { startSession, pub } from './auth.js';
import { audit } from './audit.js';

/* Google sign-in via the server-side authorization-code flow.
   No library and no local JWT verification: the code is exchanged with Google
   directly over TLS and the profile is read from Google's userinfo endpoint,
   so there is nothing to verify client-side and no secret in the browser. */

export const router = express.Router();

const APP_URL = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
const CALLBACK = `${APP_URL}/api/auth/google/callback`;
const STATE_COOKIE = 'mathopedia_oauth_state';

export const googleReady = () =>
  !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

router.get('/google', (req, res) => {
  if (!googleReady())
    return res.status(503).send('Google sign-in is not configured on this server.');
  /* random state in an HttpOnly cookie, compared on return: without it an
     attacker could complete someone else's sign-in */
  const state = crypto.randomBytes(16).toString('base64url');
  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1', maxAge: 10 * 60e3, path: '/' });

  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', CALLBACK);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email profile');
  u.searchParams.set('state', state);
  u.searchParams.set('prompt', 'select_account');
  res.redirect(u.toString());
});

router.get('/google/callback', async (req, res) => {
  const fail = msg => res.redirect('/?oauth_error=' + encodeURIComponent(msg));
  try {
    if (!googleReady()) return fail('Google sign-in is not configured.');
    if (req.query.error) return fail('Google sign-in was cancelled.');
    if (!req.query.state || req.query.state !== req.cookies[STATE_COOKIE])
      return fail('Sign-in could not be verified. Please try again.');
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: req.query.code, client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: CALLBACK, grant_type: 'authorization_code' }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) return fail(tok.error_description || 'Google rejected the sign-in.');

    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo',
      { headers: { Authorization: `Bearer ${tok.access_token}` } });
    const info = await infoRes.json();
    if (!infoRes.ok || !info.email) return fail('Google did not return an email address.');
    if (!info.email_verified) return fail('That Google account has an unverified email address.');

    const email = String(info.email).toLowerCase();
    let user = one('SELECT * FROM users WHERE email = ?', email);

    if (!user) {
      /* Google has already proved the address, so the account starts verified
         and with no password — one can be set later through the reset flow. */
      run(`INSERT INTO users (email,name,email_verified,created_at) VALUES (?,?,1,?)`,
          email, info.name || email, now());
      user = one('SELECT * FROM users WHERE email = ?', email);
      req.actorName = email;
      audit(req, 'register', email, 'created via Google');
    } else if (!user.email_verified) {
      run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
    }
    if (!user.active) return fail('This account has been suspended by an administrator.');

    run(`INSERT INTO oauth_accounts (provider,provider_uid,user_id,linked_at) VALUES ('google',?,?,?)
         ON CONFLICT(provider,provider_uid) DO UPDATE SET user_id = excluded.user_id`,
        info.sub, user.id, now());

    startSession(res, user.id);
    req.user = user;
    audit(req, 'login', email, 'via Google');
    res.redirect('/?signed_in=google');
  } catch (e) {
    console.error('[oauth]', e.message);
    fail('Could not reach Google. Please try again.');
  }
});

export { pub };
