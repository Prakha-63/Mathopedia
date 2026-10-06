-- Mathopedia schema. SQLite now; the DDL stays close to portable SQL so moving
-- to Postgres means changing types (INTEGER PRIMARY KEY -> SERIAL, INTEGER
-- booleans -> BOOLEAN, epoch millis -> TIMESTAMPTZ) rather than restructuring.

-- ---------------------------------------------------------------- identity
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,                     -- null for accounts created via OAuth only
  name TEXT,
  username TEXT UNIQUE,
  credential TEXT,                        -- scholar credential, set on approval
  role TEXT NOT NULL DEFAULT 'visitor',   -- visitor | contributor | reviewer | admin
  email_verified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,      -- 0 = suspended by an administrator
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider TEXT NOT NULL,
  provider_uid TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  linked_at INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_uid)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL,                  -- verify | verify_code | reset
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY, bucket TEXT NOT NULL, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(bucket, at);

-- ---------------------------------------------------------------- knowledge graph
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, color TEXT, glyph TEXT, sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  field TEXT NOT NULL REFERENCES fields(id),
  kind TEXT,                              -- definition | theorem | field | application
  difficulty INTEGER, abstraction INTEGER,
  summary TEXT,
  dna TEXT                                -- JSON {field: weight}; display-only, never queried by key
);
CREATE INDEX IF NOT EXISTS idx_concepts_field ON concepts(field);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                     -- prerequisite | related | alternative | application
  why TEXT,
  UNIQUE (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id, type);

-- ---------------------------------------------------------------- articles
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  concept_id TEXT REFERENCES concepts(id),
  field TEXT NOT NULL REFERENCES fields(id),
  status TEXT NOT NULL DEFAULT 'under_review',   -- under_review | reviewed | rejected
  title TEXT NOT NULL,
  author_id INTEGER REFERENCES users(id),
  author_name TEXT, author_credential TEXT,      -- kept for seeded authors with no account
  reviewer_id INTEGER REFERENCES users(id),
  reviewer_name TEXT,
  claimed_by INTEGER REFERENCES users(id),
  views INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  current_version_id INTEGER                     -- -> article_versions(id)
);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_concept ON articles(concept_id);

-- Every submission writes a row here and never overwrites one. `content` holds
-- the whole editable payload as JSON, which makes both diffing and rollback a
-- single comparison rather than a join across section rows.
CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  version TEXT NOT NULL,                  -- 'v2.0'
  editor_id INTEGER REFERENCES users(id),
  editor_name TEXT,
  summary TEXT,
  content TEXT NOT NULL,                  -- JSON {title, abstract, tags[], sections[], figure}
  content_available INTEGER NOT NULL DEFAULT 1,  -- 0 for migrated history with no snapshot
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_article ON article_versions(article_id, id DESC);

-- ---------------------------------------------------------------- references
-- Normalised so one citation can serve many articles. `raw` is the source text
-- exactly as supplied; parsed columns are filled only where they can be read
-- off with confidence, and left null otherwise rather than guessed at.
CREATE TABLE IF NOT EXISTS refs (
  id INTEGER PRIMARY KEY,
  raw TEXT NOT NULL,
  norm TEXT UNIQUE NOT NULL,              -- lowercased, whitespace-collapsed, for dedup
  authors TEXT, title TEXT, publisher TEXT, year INTEGER, url TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS article_refs (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  ref_id INTEGER NOT NULL REFERENCES refs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (article_id, ref_id)
);

-- ---------------------------------------------------------------- review
CREATE TABLE IF NOT EXISTS verifications (
  concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  statement INTEGER NOT NULL DEFAULT 0,
  proof INTEGER NOT NULL DEFAULT 0,
  refs_checked INTEGER NOT NULL DEFAULT 0,
  notation INTEGER NOT NULL DEFAULT 0,
  reviewers TEXT,                         -- JSON array of names
  checked_at TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                     -- contributor | reviewer
  status TEXT NOT NULL DEFAULT 'pending', -- pending | more_info | approved | rejected
  payload TEXT NOT NULL,                  -- JSON: credential evidence, profiles, declarations
  reason TEXT,
  submitted_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  author_name TEXT, author_credential TEXT,
  body TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  reason TEXT NOT NULL, note TEXT, reporter TEXT,
  resolved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  for_role TEXT, for_user INTEGER REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- audit
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT,
  action TEXT NOT NULL,                   -- login | register | verify | role_change | article_submit | ...
  target TEXT,
  detail TEXT,
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);

-- ---------------------------------------------------------------- teaching aids
CREATE TABLE IF NOT EXISTS examples (
  concept_id TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
  question TEXT NOT NULL, steps TEXT NOT NULL, answer TEXT
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY,
  concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  question TEXT NOT NULL, options TEXT NOT NULL, answer TEXT NOT NULL, explain TEXT
);

-- ---------------------------------------------------------------- search
-- FTS5 ships with SQLite, so full-text search needs no extra dependency.
-- Rebuilt from articles + concepts by search.js; `rowid` maps to articles only
-- when kind = 'article'.
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  ref_id UNINDEXED, kind UNINDEXED, title, body, tags, tokenize='porter unicode61'
);
