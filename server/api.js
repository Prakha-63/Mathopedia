import { all, one, unj } from './db.js';

/* The payload mirrors the shapes the page already renders from, so the view
   layer is untouched: the data simply arrives from SQLite instead of being
   written into the HTML. */

export function bootstrap() {
  const cats = {}, fieldGlyph = {};
  for (const f of all('SELECT * FROM fields ORDER BY sort_order')) {
    cats[f.id] = { label: f.label, color: f.color };
    if (f.glyph) fieldGlyph[f.id] = f.glyph;
  }

  const verif = new Map();
  for (const v of all('SELECT * FROM verifications'))
    verif.set(v.concept_id, { statement: !!v.statement, proof: !!v.proof,
      references: !!v.refs_checked, notation: !!v.notation,
      reviewers: unj(v.reviewers, []), date: v.checked_at });

  const concepts = all('SELECT * FROM concepts').map(c => {
    const o = { id: c.id, name: c.name, kind: c.kind, field: c.field,
      difficulty: c.difficulty, abstraction: c.abstraction, summary: c.summary,
      dna: unj(c.dna, {}) };
    if (verif.has(c.id)) o.verification = verif.get(c.id);
    return o;
  });

  const edges = all('SELECT from_id,to_id,type,why FROM edges')
    .map(e => ({ from: e.from_id, to: e.to_id, type: e.type, why: e.why }));

  /* references come back as the raw strings the renderer expects; the
     normalised table is what makes them shareable behind the scenes */
  const refsByArticle = new Map();
  for (const r of all(`SELECT ar.article_id, r.id, r.raw, r.authors, r.title, r.publisher, r.year, r.url
                         FROM article_refs ar JOIN refs r ON r.id = ar.ref_id
                        ORDER BY ar.article_id, ar.position`)) {
    if (!refsByArticle.has(r.article_id)) refsByArticle.set(r.article_id, []);
    refsByArticle.get(r.article_id).push({ id: r.id, raw: r.raw, authors: r.authors,
      title: r.title, publisher: r.publisher, year: r.year, url: r.url });
  }

  const histByArticle = new Map();
  for (const h of all(`SELECT article_id, version, editor_name, summary, created_at, content_available
                       FROM article_versions ORDER BY article_id, id DESC`)) {
    if (!histByArticle.has(h.article_id)) histByArticle.set(h.article_id, []);
    histByArticle.get(h.article_id).push({ version: h.version, editor: h.editor_name,
      summary: h.summary, date: dateLabel(h.created_at), snapshot: !!h.content_available });
  }

  const commentsBy = group(all('SELECT * FROM comments ORDER BY id'), 'article_id',
    c => ({ who: c.author_name, cred: c.author_credential, txt: c.body }));
  const flagsBy = group(all('SELECT * FROM flags ORDER BY id'), 'article_id',
    f => ({ reason: f.reason, note: f.note, reporter: f.reporter, resolved: !!f.resolved }));

  const articles = all(`SELECT a.*, v.content FROM articles a
                        LEFT JOIN article_versions v ON v.id = a.current_version_id`).map(a => {
    const c = unj(a.content, {});
    return { id: a.id, conceptId: a.concept_id, cat: a.field, status: a.status,
      title: a.title, author: a.author_name, credential: a.author_credential,
      reviewer: a.reviewer_name, date: dateLabel(a.created_at), views: a.views,
      tags: c.tags || [], abstract: c.abstract || '', sections: c.sections || [],
      figure: c.figure || undefined,
      references: refsByArticle.get(a.id) || [],
      history: histByArticle.get(a.id) || [],
      comments: commentsBy.get(a.id) || [], flags: flagsBy.get(a.id) || [] };
  });

  const users = all('SELECT id,name,credential,role,email_verified,active FROM users WHERE name IS NOT NULL')
    .map(u => ({ id: u.id, name: u.name, credential: u.credential, role: u.role,
                 verified: !!u.email_verified, active: !!u.active }));

  const examples = {};
  for (const e of all('SELECT * FROM examples'))
    examples[e.concept_id] = { q: e.question, steps: unj(e.steps, []), a: e.answer };

  const mathQuestions = {};
  for (const q of all('SELECT * FROM quiz_questions ORDER BY id')) {
    (mathQuestions[q.concept_id] ||= []).push(
      { q: q.question, options: unj(q.options, []), answer: q.answer, explain: q.explain });
  }

  return { cats, fieldGlyph, concepts, edges, articles, users, examples, mathQuestions };
}

function group(rows, key, shape) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(shape(r));
  }
  return m;
}

/* the page prints dates as 'Jun 3, 2026' */
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function dateLabel(ms) {
  const d = new Date(ms || Date.now());
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}
