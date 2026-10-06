import express from 'express';
import { all, one, run, unj } from './db.js';

export const router = express.Router();

/* ==========================================================================
   SEARCH
   FTS5 does the matching and bm25 the ranking; the only thing layered on top
   is a boost for a title that actually matches, so "Determinants" outranks an
   article that merely mentions determinants in passing.
   ========================================================================== */

/* FTS5 MATCH is its own grammar: a stray quote, hyphen or caret is a syntax
   error, not a search. Reduce the input to quoted terms and add a prefix
   wildcard so partial words still match. */
function toMatchQuery(raw) {
  const terms = String(raw || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)          // unicode-aware: keeps accented and non-Latin words
    .filter(t => t.length > 1);
  if (!terms.length) return null;
  return terms.map(t => `"${t.replace(/"/g, '')}"*`).join(' AND ');
}

/* Symbol-only queries ("∫", "ℝ", "≅") tokenise to nothing, because unicode61
   treats symbols as separators. Rather than return a silent zero, fall back to
   a literal scan of the places a symbol would actually appear. */
function symbolSearch(raw, limit) {
  const like = `%${String(raw).trim()}%`;
  return all(`
    SELECT c.id ref_id, 'concept' kind, c.name title, c.summary snippet, 0 score
      FROM concepts c WHERE c.name LIKE ? OR c.summary LIKE ?
    UNION ALL
    SELECT a.id, 'article', a.title, substr(v.content, 1, 160), 0
      FROM articles a JOIN article_versions v ON v.id = a.current_version_id
     WHERE a.title LIKE ? OR v.content LIKE ?
     LIMIT ?`, like, like, like, like, limit);
}

/* an unpublished article is visible to its author, to reviewers and to admins */
function visibleFilter(user) {
  if (user && (user.role === 'admin' || user.role === 'reviewer')) return { sql: '', args: [] };
  if (user) return { sql: " AND (a.status = 'reviewed' OR a.author_id = ?)", args: [user.id] };
  return { sql: " AND a.status = 'reviewed'", args: [] };
}

router.get('/', (req, res) => {
  const started = process.hrtime.bigint();
  const q = String(req.query.q || '').trim();
  const field = req.query.field && req.query.field !== 'all' ? req.query.field : null;
  const limit = Math.min(+req.query.limit || 60, 200);
  if (!q) return res.json({ query: '', results: [], total: 0, ms: 0 });

  const match = toMatchQuery(q);
  const vis = visibleFilter(req.user);
  let rows;

  if (!match) {
    rows = symbolSearch(q, limit);
  } else {
    /* bm25 takes one weight per column, in table order, so all five must be
       listed: ref_id and kind are UNINDEXED and can never match, then title
       matters most, then tags, then body. It returns a negative score where
       lower is better, so it is negated for sorting. */
    rows = all(`
      SELECT f.ref_id, f.kind, f.title,
             snippet(search_fts, 3, '<mark>', '</mark>', '…', 14) snippet,
             -bm25(search_fts, 0.0, 0.0, 10.0, 1.0, 4.0) score
        FROM search_fts f
       WHERE search_fts MATCH ?
       ORDER BY score DESC
       LIMIT ?`, match, limit * 2);
  }

  /* resolve to concepts, apply field and visibility filters, and lift exact
     title hits to the top */
  const needle = q.toLowerCase();
  const seen = new Set();
  const out = [];

  for (const r of rows) {
    let conceptId = r.ref_id, article = null;
    if (r.kind === 'article') {
      article = one(`SELECT a.* FROM articles a WHERE a.id = ?${vis.sql}`, r.ref_id, ...vis.args);
      if (!article) continue;                       // not visible to this reader
      conceptId = article.concept_id || article.id;
    }
    const c = one('SELECT * FROM concepts WHERE id = ?', conceptId);
    if (!c) continue;
    if (field && c.field !== field) continue;
    if (seen.has(c.id)) continue;                   // one row per concept
    seen.add(c.id);

    const title = (r.title || c.name).toLowerCase();
    const boost = title === needle ? 1000              // exact title
                : title.startsWith(needle) ? 400       // title begins with the query
                : title.includes(needle) ? 150 : 0;    // title contains it

    out.push({ conceptId: c.id, name: c.name, field: c.field, kind: r.kind,
      articleId: article ? article.id : null,
      status: article ? article.status : null,
      snippet: cleanSnippet(r.snippet) || c.summary,
      score: (r.score || 0) + boost });
  }

  out.sort((a, b) => b.score - a.score);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  res.json({ query: q, total: out.length, ms: +ms.toFixed(1),
             results: out.slice(0, limit) });
});

/* the body column holds stripped article text; tidy what snippet() hands back */
/* The indexed body is article prose with LaTeX still in it. Snippets are a
   preview, not the article, so the commands that carry meaning are mapped to
   their symbol and the purely structural ones are dropped. */
const TEX = {
  times:'×', cdot:'·', div:'÷', pm:'±', neq:'≠', le:'≤', ge:'≥', leq:'≤', geq:'≥',
  to:'→', mapsto:'↦', implies:'⇒', iff:'⇔', in:'∈', notin:'∉', subset:'⊂',
  subseteq:'⊆', cup:'∪', cap:'∩', setminus:'' + String.fromCharCode(92), emptyset:'∅',
  infty:'∞', sum:'∑', prod:'∏', int:'∫', partial:'∂', nabla:'∇', sqrt:'√',
  alpha:'α', beta:'β', gamma:'γ', delta:'δ', epsilon:'ε', zeta:'ζ', theta:'θ',
  lambda:'λ', mu:'μ', pi:'π', sigma:'σ', tau:'τ', phi:'φ', chi:'χ', omega:'ω',
  Gamma:'Γ', Delta:'Δ', Lambda:'Λ', Sigma:'Σ', Phi:'Φ', Omega:'Ω',
  mid:'|', approx:'≈', equiv:'≡', sim:'~', cong:'≅', forall:'∀', exists:'∃',
};
function cleanSnippet(s) {
  if (!s) return null;
  return String(s)
    .replace(/\\[()[\]]/g, '')       // inline and display math delimiters
    .replace(/\\([a-zA-Z]+)/g, (m, c) => (c in TEX ? TEX[c] : ''))
    .replace(/[{}$]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}<]+/u, '')  // leading punctuation, keeping a <mark>
    .trim().slice(0, 240);
}

/* ---------------------------------------------------------------- index */
export function indexArticle(id) {
  const a = one(`SELECT a.id, a.title, v.content FROM articles a
                 LEFT JOIN article_versions v ON v.id = a.current_version_id WHERE a.id = ?`, id);
  run("DELETE FROM search_fts WHERE kind = 'article' AND ref_id = ?", id);
  if (!a) return;                                   // deleted: removal is the whole job
  const c = unj(a.content, {});
  const body = [c.abstract || '', ...(c.sections || []).map(s => `${s.heading} ${s.body}`)]
    .join(' ').replace(/<[^>]+>/g, ' ');
  run("INSERT INTO search_fts (ref_id,kind,title,body,tags) VALUES (?, 'article', ?, ?, ?)",
      a.id, a.title, body, (c.tags || []).join(' '));
}

export function indexConcept(id) {
  const c = one('SELECT id,name,summary,field FROM concepts WHERE id = ?', id);
  run("DELETE FROM search_fts WHERE kind = 'concept' AND ref_id = ?", id);
  if (!c) return;
  run("INSERT INTO search_fts (ref_id,kind,title,body,tags) VALUES (?, 'concept', ?, ?, ?)",
      c.id, c.name, c.summary || '', c.field);
}

export function rebuildIndex() {
  run('DELETE FROM search_fts');
  for (const a of all('SELECT id FROM articles')) indexArticle(a.id);
  for (const c of all('SELECT id FROM concepts')) indexConcept(c.id);
  return one('SELECT COUNT(*) c FROM search_fts').c;
}
