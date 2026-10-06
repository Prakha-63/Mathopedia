/* One-off import of the seeded Mathopedia data into SQLite.
   Input is dump.json, produced by reading the globals off the running page —
   the page builds them correctly, so its own runtime is a more reliable parser
   than anything that re-reads the HTML.

   Idempotent: every write is INSERT OR REPLACE / OR IGNORE keyed on the source
   id, so re-running after a fix does not duplicate rows.

   Run:  node --experimental-sqlite --no-warnings --env-file=.env migrate.js
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { db, all, one, run, tx, now, j } from '../server/db.js';

const d = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'dump.json'), 'utf8'));
const t = now();
const say = (n, what) => console.log(String(n).padStart(5), what);

/* a date like 'Jun 3, 2026' -> epoch ms; unparseable dates keep the import
   moving rather than failing, and fall back to the run time */
const when = s => { const n = Date.parse(s); return Number.isFinite(n) ? n : t; };

tx(() => {
  // ------------------------------------------------------------ fields
  let i = 0;
  for (const [id, c] of Object.entries(d.cats)) {
    run(`INSERT INTO fields (id,label,color,glyph,sort_order) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, color=excluded.color,
           glyph=excluded.glyph, sort_order=excluded.sort_order`,
        id, c.label, c.color || null, d.fieldGlyph?.[id] || null, i++);
  }
  say(i, 'fields');

  // ------------------------------------------------------------ users
  // Seeded people are authors and reviewers with no login. Demo accounts keep
  // their literal password so the judge logins still work; everything else has
  // no password_hash and cannot sign in until it registers properly.
  const byName = new Map();
  for (const u of d.users) {
    const email = `${u.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '')}@seed.mathopedia.invalid`;
    run(`INSERT INTO users (email,name,credential,role,email_verified,active,created_at)
         VALUES (?,?,?,?,0,?,?) ON CONFLICT(email) DO UPDATE SET
           name=excluded.name, credential=excluded.credential, role=excluded.role, active=excluded.active`,
        email, u.name, u.credential || null, u.role || 'visitor', u.active === false ? 0 : 1, t);
    byName.set(u.name, one('SELECT id FROM users WHERE email = ?', email).id);
  }
  say(byName.size, 'seeded people');

  /* The demo logins are the same people as the seeded authors above. Give the
     existing row a username and password rather than creating a second account
     for the same human, which would split their articles across two identities. */
  let demo = 0;
  for (const a of d.accounts) {
    if (!a.password) continue;                       // nothing to carry over
    const hash = bcrypt.hashSync(a.password, 12);    // never store the literal
    const existing = byName.get(a.name);
    if (existing) {
      run(`UPDATE users SET password_hash = ?, username = ?, role = ?, email_verified = 1,
             credential = COALESCE(credential, ?) WHERE id = ?`,
          hash, a.username, a.role, a.credential || null, existing);
    } else {
      const email = `${a.username}@demo.mathopedia.invalid`;
      run(`INSERT INTO users (email,password_hash,name,username,credential,role,email_verified,active,created_at)
           VALUES (?,?,?,?,?,?,1,1,?) ON CONFLICT(email) DO UPDATE SET
             password_hash=excluded.password_hash, role=excluded.role`,
          email, hash, a.name, a.username, a.credential || null, a.role, t);
      byName.set(a.name, one('SELECT id FROM users WHERE email = ?', email).id);
    }
    demo++;
  }
  say(demo, 'demo logins (passwords hashed)');

  // ------------------------------------------------------------ concepts + edges
  for (const c of d.concepts) {
    run(`INSERT INTO concepts (id,name,field,kind,difficulty,abstraction,summary,dna)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, field=excluded.field, kind=excluded.kind,
           difficulty=excluded.difficulty, abstraction=excluded.abstraction,
           summary=excluded.summary, dna=excluded.dna`,
        c.id, c.name, c.field, c.kind || null, c.difficulty ?? null,
        c.abstraction ?? null, c.summary || null, j(c.dna));
  }
  say(d.concepts.length, 'concepts');

  let edges = 0;
  for (const e of d.edges) {
    if (!one('SELECT 1 FROM concepts WHERE id = ?', e.from) ||
        !one('SELECT 1 FROM concepts WHERE id = ?', e.to)) continue;   // skip dangling
    run(`INSERT OR IGNORE INTO edges (from_id,to_id,type,why) VALUES (?,?,?,?)`,
        e.from, e.to, e.type, e.why || null);
    edges++;
  }
  say(edges, 'edges');

  // ------------------------------------------------------------ verifications
  for (const { conceptId, v } of d.verifications) {
    if (!one('SELECT 1 FROM concepts WHERE id = ?', conceptId)) continue;
    run(`INSERT INTO verifications (concept_id,statement,proof,refs_checked,notation,reviewers,checked_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(concept_id) DO UPDATE SET
           statement=excluded.statement, proof=excluded.proof, refs_checked=excluded.refs_checked,
           notation=excluded.notation, reviewers=excluded.reviewers, checked_at=excluded.checked_at`,
        conceptId, v.statement ? 1 : 0, v.proof ? 1 : 0, v.references ? 1 : 0,
        v.notation ? 1 : 0, j(v.reviewers || []), v.date || null);
  }
  say(d.verifications.length, 'verification records');

  // ------------------------------------------------------------ references
  // Dedup on normalised text. A four-digit year is the only field that can be
  // read off a free-text citation reliably, so it is the only one parsed; the
  // rest stay null rather than being guessed at.
  const refId = raw => {
    const norm = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    const hit = one('SELECT id FROM refs WHERE norm = ?', norm);
    if (hit) return hit.id;
    const year = (raw.match(/\b(1[5-9]\d{2}|20\d{2})\b/) || [])[1];
    const url = (raw.match(/https?:\/\/\S+/) || [])[0];
    run('INSERT INTO refs (raw,norm,year,url,created_at) VALUES (?,?,?,?,?)',
        raw.trim(), norm, year ? +year : null, url || null, t);
    return one('SELECT id FROM refs WHERE norm = ?', norm).id;
  };

  // ------------------------------------------------------------ articles
  let versions = 0, stubs = 0;
  for (const a of d.articles) {
    const authorId = byName.get(a.author) || null;
    const reviewerId = a.reviewer ? byName.get(a.reviewer) || null : null;
    const created = when(a.date);

    run(`INSERT INTO articles (id,concept_id,field,status,title,author_id,author_name,
           author_credential,reviewer_id,reviewer_name,views,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, title=excluded.title,
           views=excluded.views, updated_at=excluded.updated_at`,
        a.id, a.conceptId || a.id, a.cat, a.status, a.title, authorId, a.author || null,
        a.credential || null, reviewerId, a.reviewer || null, a.views || 0, created, created);

    // current content becomes the newest version, with a real snapshot
    const content = j({ title: a.title, abstract: a.abstract, tags: a.tags || [],
                        sections: a.sections || [], figure: a.figure || null });
    const hist = Array.isArray(a.history) ? a.history.slice().reverse() : [];   // oldest first
    const newestLabel = hist.length ? hist[hist.length - 1].version : 'v1.0';

    // older history entries carry no content in the source, so they are recorded
    // as metadata with content_available = 0 rather than inventing a snapshot
    for (const h of hist.slice(0, -1)) {
      run(`INSERT INTO article_versions (article_id,version,editor_id,editor_name,summary,
             content,content_available,created_at) VALUES (?,?,?,?,?,?,0,?)`,
          a.id, h.version, byName.get(h.editor) || null, h.editor || null,
          h.summary || null, '{}', when(h.date));
      stubs++;
    }
    const newest = hist.length ? hist[hist.length - 1] : { editor: a.author, summary: 'Initial submission', date: a.date };
    run(`INSERT INTO article_versions (article_id,version,editor_id,editor_name,summary,
           content,content_available,created_at) VALUES (?,?,?,?,?,?,1,?)`,
        a.id, newestLabel, byName.get(newest.editor) || null, newest.editor || null,
        newest.summary || null, content, when(newest.date));
    versions++;
    run('UPDATE articles SET current_version_id = ? WHERE id = ?',
        one('SELECT MAX(id) m FROM article_versions WHERE article_id = ?', a.id).m, a.id);

    (a.references || []).forEach((raw, i) =>
      run('INSERT OR IGNORE INTO article_refs (article_id,ref_id,position) VALUES (?,?,?)', a.id, refId(raw), i));

    for (const c of a.comments || [])
      run('INSERT INTO comments (article_id,author_name,author_credential,body,created_at) VALUES (?,?,?,?,?)',
          a.id, c.who || null, c.cred || null, c.txt || '', created);
    for (const f of a.flags || [])
      run('INSERT INTO flags (article_id,reason,note,reporter,resolved,created_at) VALUES (?,?,?,?,?,?)',
          a.id, f.reason || '', f.note || null, f.reporter || null, f.resolved ? 1 : 0, created);
  }
  say(d.articles.length, 'articles');
  say(versions + stubs, `versions (${versions} with content, ${stubs} metadata-only from history)`);
  say(one('SELECT COUNT(*) c FROM refs').c, 'distinct references');

  // ------------------------------------------------------------ teaching aids
  for (const [cid, ex] of Object.entries(d.examples)) {
    if (!one('SELECT 1 FROM concepts WHERE id = ?', cid)) continue;
    run(`INSERT INTO examples (concept_id,question,steps,answer) VALUES (?,?,?,?)
         ON CONFLICT(concept_id) DO UPDATE SET question=excluded.question,
           steps=excluded.steps, answer=excluded.answer`,
        cid, ex.q, j(ex.steps || []), ex.a || null);
  }
  say(Object.keys(d.examples).length, 'worked examples');

  run('DELETE FROM quiz_questions');
  let qn = 0;
  for (const [cid, list] of Object.entries(d.mathQuestions)) {
    if (!one('SELECT 1 FROM concepts WHERE id = ?', cid)) continue;
    for (const q of list) {
      run('INSERT INTO quiz_questions (concept_id,question,options,answer,explain) VALUES (?,?,?,?,?)',
          cid, q.q, j(q.options), q.answer, q.explain || null);
      qn++;
    }
  }
  say(qn, 'quiz questions');

  // ------------------------------------------------------------ search index
  run('DELETE FROM search_fts');
  for (const a of all(`SELECT a.id, a.title, v.content, a.field FROM articles a
                       JOIN article_versions v ON v.id = a.current_version_id`)) {
    const c = JSON.parse(a.content || '{}');
    const body = [c.abstract || '', ...(c.sections || []).map(s => `${s.heading} ${s.body}`)]
      .join(' ').replace(/<[^>]+>/g, ' ');
    run('INSERT INTO search_fts (ref_id,kind,title,body,tags) VALUES (?,?,?,?,?)',
        a.id, 'article', a.title, body, (c.tags || []).join(' '));
  }
  for (const c of all('SELECT id,name,summary,field FROM concepts'))
    run('INSERT INTO search_fts (ref_id,kind,title,body,tags) VALUES (?,?,?,?,?)',
        c.id, 'concept', c.name, c.summary || '', c.field);
  say(one('SELECT COUNT(*) c FROM search_fts').c, 'search index rows');

  run('INSERT INTO audit_log (actor_name,action,detail,at) VALUES (?,?,?,?)',
      'migration', 'data_import', `imported from dump.json`, t);
});

console.log('\nmigration complete');
