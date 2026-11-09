/* Rotates the seeded demo account passwords.
     npm run rotate-demo-passwords

   Generates a fresh random password for each demo account, hashes it with the
   same mechanism the server uses (bcryptjs, cost 12), and rewrites
   data/demo-credentials.txt, which is git-ignored.

   It touches only the five seeded demo logins. Accounts a person registered
   themselves are left alone — rotating those would lock them out. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { all, one, run } from '../server/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO = ['reader', 'contributor', 'reviewer', 'admin', 'administrative1023'];

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const SYMS = '!@#$%&*?-_';
function newPassword(len = 20) {
  const bytes = crypto.randomBytes(len * 2);
  let out = '';
  for (let i = 0; out.length < len - 2; i++) out += ALPHA[bytes[i] % ALPHA.length];
  for (let k = 0; k < 2; k++) {
    const s = SYMS[crypto.randomBytes(1)[0] % SYMS.length];
    const at = crypto.randomBytes(1)[0] % out.length;
    out = out.slice(0, at) + s + out.slice(at);
  }
  return out;
}

const rows = [];
for (const username of DEMO) {
  const u = one('SELECT id,username,name,role FROM users WHERE username = ?', username);
  if (!u) { console.log(`  skipped ${username} — no such account`); continue; }
  const pw = newPassword();
  run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pw, 12), u.id);
  rows.push({ ...u, password: pw });
  console.log(`  rotated ${u.username.padEnd(20)} ${u.role.padEnd(13)} ${u.name}`);
}

/* Anything else that can sign in is listed but never touched, so whoever runs
   this can see at a glance which accounts it did not cover. */
const untouched = all(
  `SELECT username, email, role FROM users
    WHERE password_hash IS NOT NULL AND username NOT IN (${DEMO.map(() => '?').join(',')})`, ...DEMO);

const file = path.join(here, '..', 'data', 'demo-credentials.txt');
fs.writeFileSync(file,
`MATHOPEDIA — DEMO ACCOUNT CREDENTIALS
Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}

This file is git-ignored and must never be committed.
Sign in with the USERNAME, not the email.

` + rows.map(r =>
`  ${r.role.toUpperCase()}
    username  ${r.username}
    password  ${r.password}
    person    ${r.name}
`).join('\n') +
(untouched.length
  ? `\nNot rotated — these have passwords their owner chose:\n` +
    untouched.map(u => `  ${String(u.username || '—').padEnd(20)} ${u.role.padEnd(13)} ${u.email}`).join('\n') + '\n'
  : ''), 'utf8');

console.log(`\n  ${rows.length} rotated. Credentials in data/demo-credentials.txt`);
if (untouched.length) console.log(`  ${untouched.length} other account(s) left alone — listed in that file.`);
