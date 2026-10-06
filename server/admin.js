import express from 'express';
import { all, one, run, tx, now } from './db.js';
import { requireRole } from './auth.js';
import { audit } from './audit.js';
import { rebuildIndex } from './search.js';

export const router = express.Router();
router.use(requireRole('admin'));       // every route below is administrator-only

const ROLES = ['visitor', 'pending', 'contributor', 'reviewer', 'admin'];
const ok = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e.message); res.status(500).json({ error: e.message || 'Server error.' });
});

const shape = u => ({ id: u.id, email: u.email, name: u.name, username: u.username,
  credential: u.credential, role: u.role, verified: !!u.email_verified,
  active: !!u.active, created: u.created_at, hasPassword: !!u.password_hash,
  google: !!u.google, articles: u.articles });

/* ---------------------------------------------------------------- users */
router.get('/users', ok((req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const role = req.query.role && ROLES.includes(req.query.role) ? req.query.role : null;
  const status = req.query.status || null;        // active | suspended | unverified
  const limit = Math.min(+req.query.limit || 50, 200);
  const offset = Math.max(+req.query.offset || 0, 0);

  const where = [`(lower(coalesce(u.name,'')) LIKE ? OR lower(u.email) LIKE ? OR lower(coalesce(u.username,'')) LIKE ?)`];
  const args = [q, q, q];
  if (role) { where.push('u.role = ?'); args.push(role); }
  if (status === 'active') where.push('u.active = 1');
  if (status === 'suspended') where.push('u.active = 0');
  if (status === 'unverified') where.push('u.email_verified = 0');
  const sql = where.join(' AND ');

  const rows = all(`
    SELECT u.*,
      (SELECT COUNT(*) FROM oauth_accounts o WHERE o.user_id = u.id) google,
      (SELECT COUNT(*) FROM articles a WHERE a.author_id = u.id) articles
    FROM users u WHERE ${sql}
    ORDER BY u.role = 'admin' DESC, u.active DESC, lower(coalesce(u.name, u.email))
    LIMIT ? OFFSET ?`, ...args, limit, offset);

  res.json({ total: one(`SELECT COUNT(*) c FROM users u WHERE ${sql}`, ...args).c,
             users: rows.map(shape), roles: ROLES });
}));

router.patch('/users/:id/role', ok((req, res) => {
  const id = +req.params.id, role = req.body?.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  /* an administrator must not be able to lock everyone out of the console */
  if (u.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error: 'You cannot change your own role.' });
  if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1)
    return res.status(400).json({ error: 'That is the last administrator.' });

  run('UPDATE users SET role = ? WHERE id = ?', role, id);
  audit(req, 'role_change', u.email, `${u.role} -> ${role}`);
  res.json({ user: shape({ ...u, role }) });
}));

router.patch('/users/:id/active', ok((req, res) => {
  const id = +req.params.id, active = req.body?.active ? 1 : 0;
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });
  if (!active && u.role === 'admin' && adminCount() <= 1)
    return res.status(400).json({ error: 'That is the last administrator.' });

  run('UPDATE users SET active = ? WHERE id = ?', active, id);
  /* a suspension should take hold immediately, not at next sign-in */
  if (!active) run('DELETE FROM sessions WHERE user_id = ?', id);
  audit(req, active ? 'user_reinstated' : 'user_suspended', u.email, null);
  res.json({ user: shape({ ...u, active }) });
}));

router.delete('/users/:id', ok((req, res) => {
  const id = +req.params.id;
  const u = one('SELECT * FROM users WHERE id = ?', id);
  if (!u) return res.status(404).json({ error: 'No such user.' });
  if (u.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (u.role === 'admin' && adminCount() <= 1) return res.status(400).json({ error: 'That is the last administrator.' });

  tx(() => {
    /* articles outlive their author: the account link is cleared but the
       attributed name stays, so published work is not silently erased */
    run('UPDATE articles SET author_id = NULL WHERE author_id = ?', id);
    run('UPDATE articles SET reviewer_id = NULL WHERE reviewer_id = ?', id);
    run('UPDATE article_versions SET editor_id = NULL WHERE editor_id = ?', id);
    run('DELETE FROM users WHERE id = ?', id);     // sessions/oauth/applications cascade
  });
  audit(req, 'user_deleted', u.email, `role ${u.role}; articles kept under their name`);
  res.json({ ok: true });
}));

const adminCount = () => one("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1").c;

/* ---------------------------------------------------------------- audit */
router.get('/audit', ok((req, res) => {
  const q = `%${String(req.query.q || '').trim().toLowerCase()}%`;
  const action = req.query.action || null;
  const limit = Math.min(+req.query.limit || 100, 500);
  const where = [`(lower(coalesce(actor_name,'')) LIKE ? OR lower(coalesce(target,'')) LIKE ? OR lower(coalesce(detail,'')) LIKE ?)`];
  const args = [q, q, q];
  if (action) { where.push('action = ?'); args.push(action); }
  const sql = where.join(' AND ');

  res.json({
    total: one(`SELECT COUNT(*) c FROM audit_log WHERE ${sql}`, ...args).c,
    actions: all('SELECT action, COUNT(*) n FROM audit_log GROUP BY action ORDER BY n DESC'),
    entries: all(`SELECT * FROM audit_log WHERE ${sql} ORDER BY id DESC LIMIT ?`, ...args, limit),
  });
}));

/* a small summary the Analytics panel can show without inventing numbers */
router.get('/stats', ok((_req, res) => res.json({
  users: one('SELECT COUNT(*) c FROM users').c,
  active: one('SELECT COUNT(*) c FROM users WHERE active = 1').c,
  verified: one('SELECT COUNT(*) c FROM users WHERE email_verified = 1').c,
  byRole: all('SELECT role, COUNT(*) n FROM users GROUP BY role'),
  articles: one('SELECT COUNT(*) c FROM articles').c,
  underReview: one("SELECT COUNT(*) c FROM articles WHERE status = 'under_review'").c,
  versions: one('SELECT COUNT(*) c FROM article_versions').c,
  auditEntries: one('SELECT COUNT(*) c FROM audit_log').c,
  signInsToday: one('SELECT COUNT(*) c FROM audit_log WHERE action = ? AND at > ?', 'login', now() - 864e5).c,
})));

router.post('/reindex', ok((req, res) => {
  const n = rebuildIndex();
  audit(req, 'search_reindex', null, `${n} rows`);
  res.json({ rows: n });
}));
