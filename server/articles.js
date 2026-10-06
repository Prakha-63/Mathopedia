import express from 'express';
import { all, one, run, tx, now, unj } from './db.js';
import { requireRole } from './auth.js';
import { audit } from './audit.js';
import { dateLabel } from './api.js';
import { indexArticle, indexConcept } from './search.js';
import { setArticleRefs, articleRefs, usageCounts } from './refs.js';

export const router = express.Router();

const ok = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  console.error(e.message); res.status(500).json({ error: e.message || 'Server error.' });
});

const meta = v => ({ id: v.id, version: v.version, editor: v.editor_name,
  summary: v.summary, date: dateLabel(v.created_at), at: v.created_at,
  snapshot: !!v.content_available });

/* ---------------------------------------------------------------- read */
router.get('/:id/versions', ok((req, res) => {
  const a = one('SELECT * FROM articles WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'No such article.' });
  res.json({
    current: a.current_version_id,
    versions: all('SELECT * FROM article_versions WHERE article_id = ? ORDER BY id DESC', a.id).map(meta),
  });
}));

router.get('/:id/versions/:vid', ok((req, res) => {
  const v = one('SELECT * FROM article_versions WHERE id = ? AND article_id = ?',
                +req.params.vid, req.params.id);
  if (!v) return res.status(404).json({ error: 'No such version.' });
  if (!v.content_available)
    return res.status(409).json({ error: 'This revision is recorded in the history but its text was never stored, so it cannot be shown or compared.' });
  res.json({ ...meta(v), content: unj(v.content, {}) });
}));

/* references attached to an article, in order */
router.get('/:id/references', ok((req, res) => {
  const a = one('SELECT * FROM articles WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'No such article.' });
  if (a.status !== 'reviewed' && !canEdit(req.user, a) && !isStaff(req.user))
    return res.status(403).json({ error: 'Not visible.' });
  const refs = articleRefs(a.id);
  res.json({ references: refs, usage: usageCounts(refs.map(r => r.id)) });
}));

const isStaff = u => !!u && (u.role === 'admin' || u.role === 'reviewer');
const canEdit = (u, a) => !!u && (a.author_id === u.id || isStaff(u));

/* ---------------------------------------------------------------- create
   Creating an article persists the same way a revision does. The concept node,
   the article row, its first version, its references and its prerequisite
   edges are written in one transaction, so a submission cannot land
   half-created. */
const slugify = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'article';

router.post('/', requireRole('contributor', 'reviewer', 'admin'), ok((req, res) => {
  const { title, abstract, sections, tags, figure, references, field,
          conceptId, prerequisites } = req.body || {};
  if (!title || !abstract || !Array.isArray(sections) || !sections.length)
    return res.status(400).json({ error: 'A title, an abstract and at least one section are required.' });
  if (!field || !one('SELECT 1 FROM fields WHERE id = ?', field))
    return res.status(400).json({ error: 'Choose a field for this article.' });

  let cid = conceptId && conceptId !== '__new__' ? String(conceptId) : null;
  if (cid && !one('SELECT 1 FROM concepts WHERE id = ?', cid))
    return res.status(400).json({ error: 'That concept no longer exists.' });
  if (cid && one('SELECT 1 FROM articles WHERE concept_id = ?', cid))
    return res.status(409).json({ error: 'That concept already has an article.' });

  let aid = slugify(title);
  if (one('SELECT 1 FROM articles WHERE id = ?', aid))
    aid = aid + '-' + Math.floor(Math.random() * 900 + 100);

  const author = req.user.name || req.user.email;
  const made = tx(() => {
    if (!cid) {
      cid = slugify(title);
      if (one('SELECT 1 FROM concepts WHERE id = ?', cid))
        cid = cid + '-' + Math.floor(Math.random() * 900 + 100);
      const dna = { algebra: 20, analysis: 20, geometry: 20, topology: 20, probability: 20 };
      if (dna[field] !== undefined) dna[field] = 85;
      run('INSERT INTO concepts (id,name,field,kind,difficulty,abstraction,summary,dna)'
        + " VALUES (?,?,?,'theorem',50,50,?,?)",
          cid, title, field, String(abstract).replace(/\\[()]/g, '').slice(0, 200), JSON.stringify(dna));
    }

    run('INSERT INTO articles (id,concept_id,field,status,title,author_id,author_name,'
      + "author_credential,views,created_at,updated_at) VALUES (?,?,?,'under_review',?,?,?,?,0,?,?)",
        aid, cid, field, title, req.user.id, author, req.user.credential || null, now(), now());

    let stored = [];
    if (references !== undefined) {
      const r = setArticleRefs(aid, references);
      if (r.error) throw new Error(r.error);        // rolls the whole creation back
      stored = r.refs;
    }

    run('INSERT INTO article_versions (article_id,version,editor_id,editor_name,summary,'
      + "content,content_available,created_at) VALUES (?,'v1.0',?,?,'Initial submission',?,1,?)",
        aid, req.user.id, author,
        JSON.stringify({ title, abstract, tags: tags || [], sections,
                         figure: figure || null, references: stored }), now());
    run('UPDATE articles SET current_version_id = ? WHERE id = ?',
        one('SELECT MAX(id) m FROM article_versions WHERE article_id = ?', aid).m, aid);

    /* prerequisite rows become real edges, each carrying its reasoning */
    for (const p of Array.isArray(prerequisites) ? prerequisites : []) {
      if (!p || !p.from || p.from === cid) continue;
      if (!one('SELECT 1 FROM concepts WHERE id = ?', p.from)) continue;
      const why = String(p.why || '').trim()
        || ('Recorded by ' + author + ' on submission; no reasoning was given.');
      run("INSERT OR IGNORE INTO edges (from_id,to_id,type,why) VALUES (?,?,'prerequisite',?)",
          p.from, cid, why);
    }
    return { aid, cid };
  });

  indexArticle(made.aid);
  indexConcept(made.cid);
  audit(req, 'article_created', made.aid, title);
  res.json({ id: made.aid, conceptId: made.cid, version: 'v1.0' });
}));

/* ---------------------------------------------------------------- write
   A submission appends a version. Nothing is ever overwritten: the article row
   only moves its current_version_id pointer. */
router.post('/:id/versions', requireRole('contributor', 'reviewer', 'admin'), ok((req, res) => {
  const a = one('SELECT * FROM articles WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'No such article.' });

  const { title, abstract, sections, tags, figure, summary, references } = req.body || {};
  if (!canEdit(req.user, a))
    return res.status(403).json({ error: 'You can only revise your own articles.' });
  if (!title || !abstract || !Array.isArray(sections) || !sections.length)
    return res.status(400).json({ error: 'A title, an abstract and at least one section are required.' });

  /* next major version, derived from the highest one present rather than a
     row count, so a history containing v1.1 does not skip a number */
  const highest = all('SELECT version FROM article_versions WHERE article_id = ?', a.id)
    .reduce((m, r) => Math.max(m, parseInt(String(r.version).replace(/^v/, ''), 10) || 0), 0);
  const n = highest;
  /* references are normalised into refs/article_refs for reuse, and a copy
     goes into the snapshot so the version records what was cited at the time */
  let stored = articleRefs(a.id);
  if (references !== undefined) {
    const r = setArticleRefs(a.id, references);
    if (r.error) return res.status(400).json({ error: r.error });
    stored = r.refs;
  }
  const content = JSON.stringify({ title, abstract, tags: tags || [], sections,
    figure: figure || null, references: stored });

  const id = tx(() => {
    run(`INSERT INTO article_versions (article_id,version,editor_id,editor_name,summary,content,content_available,created_at)
         VALUES (?,?,?,?,?,?,1,?)`,
        a.id, `v${n + 1}.0`, req.user.id, req.user.name || req.user.email,
        summary || 'Revised', content, now());
    const vid = one('SELECT MAX(id) m FROM article_versions WHERE article_id = ?', a.id).m;
    /* a revision returns the article to the queue, which is the existing
       Contributor -> Reviewer -> Published rule, not a new one */
    run(`UPDATE articles SET current_version_id = ?, title = ?, status = 'under_review',
           reviewer_id = NULL, reviewer_name = NULL, updated_at = ? WHERE id = ?`,
        vid, title, now(), a.id);
    indexArticle(a.id);
    return vid;
  });

  audit(req, 'article_revised', a.id, `${a.title} -> v${n + 1}.0`);
  res.json({ versionId: id, version: `v${n + 1}.0` });
}));
