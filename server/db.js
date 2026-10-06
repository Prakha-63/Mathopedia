import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (process.env.DATABASE_URL || 'file:./auth.db').replace(/^file:/, '');

export const db = new DatabaseSync(path.resolve(here, file));
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');      // concurrent reads while a write is in flight
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

/* Three helpers instead of an ORM. Swapping to Postgres means reimplementing
   these over pg and changing ? placeholders to $1 — the callers do not move. */
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);

export function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const now = () => Date.now();
export const j = v => JSON.stringify(v ?? null);
export const unj = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
