import { run, now } from './db.js';

/* Written from the server only. Every entry records who, what, against what,
   and from where — the admin viewer in the next stage reads this table. */
export function audit(req, action, target, detail) {
  const u = req?.user || null;
  run('INSERT INTO audit_log (actor_id,actor_name,action,target,detail,ip,at) VALUES (?,?,?,?,?,?,?)',
      u?.id ?? null, u?.name || u?.email || (req?.actorName ?? null),
      action, target ?? null, detail ?? null, ip(req), now());
}

const ip = req => (req?.headers?.['x-forwarded-for']?.split(',')[0]
                || req?.socket?.remoteAddress || null);
