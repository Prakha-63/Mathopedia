import express from 'express';
import { all, one, run, now } from './db.js';
import { ok } from './http.js';

/* ==========================================================================
   NOTIFICATIONS
   The page kept these in an array keyed by role, so a message meant for the
   author of an article went to whoever happened to be signed in as a
   contributor in that browser tab, and vanished on reload. A notification is
   addressed to a person — the notifications table already had for_user for
   exactly this — and the role form is kept only for the broadcasts that
   genuinely have no single recipient.
   ========================================================================== */

/* Addressed to one account. userId may be null for a seeded author who never
   had one, in which case there is nobody to tell and nothing is written. */
export function notifyUser(userId, body) {
  if (!userId) return false;
  run('INSERT INTO notifications (for_user,body,created_at) VALUES (?,?,?)', userId, body, now());
  return true;
}

/* Addressed to everyone holding a role — "an article is waiting in the queue"
   has no single recipient. */
export function notifyRole(role, body) {
  run('INSERT INTO notifications (for_role,body,created_at) VALUES (?,?,?)', role, body, now());
}

export const router = express.Router();

router.get('/', ok((req, res) => {
  if (!req.user) return res.json({ notifications: [], unread: 0 });
  const rows = all(
    `SELECT id, body, read, created_at FROM notifications
      WHERE for_user = ? OR (for_user IS NULL AND for_role = ?)
      ORDER BY id DESC LIMIT 50`, req.user.id, req.user.role);
  res.json({
    notifications: rows.map(n => ({ id: n.id, text: n.body, read: !!n.read, at: n.created_at })),
    unread: rows.filter(n => !n.read).length,
  });
}));

router.post('/read', ok((req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  const id = req.body?.id;
  if (id == null)
    run('UPDATE notifications SET read = 1 WHERE for_user = ? OR (for_user IS NULL AND for_role = ?)',
        req.user.id, req.user.role);
  else
    run('UPDATE notifications SET read = 1 WHERE id = ? AND (for_user = ? OR (for_user IS NULL AND for_role = ?))',
        +id, req.user.id, req.user.role);
  res.json({ ok: true });
}));
