import { all, one, run, now } from './db.js';

/* ==========================================================================
   REFERENCES
   Normalised so one citation serves many articles. Nothing the client sends is
   trusted: the raw text is bounded, the URL scheme is checked server-side, and
   bibliographic fields are only stored when supplied — never inferred, so a
   migrated citation that has only raw text keeps only raw text.
   ========================================================================== */

const MAX_PER_ARTICLE = 60;
const MAX_RAW = 600;

/* http and https only. Anything else — javascript:, data:, vbscript:, file: —
   is dropped rather than stored, so it can never reach an href. */
export function safeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.href.length > 500) return null;
  return u.href;
}

const normalise = raw => String(raw).trim().toLowerCase().replace(/\s+/g, ' ');

/* a four-digit year is the only thing that can be read off free text reliably */
const yearFrom = raw => {
  const m = String(raw).match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  const y = m ? +m[1] : null;
  return y && y >= 1400 && y <= new Date().getFullYear() + 1 ? y : null;
};

function validate(r) {
  const raw = String(r?.raw ?? '').trim();
  if (!raw) return { error: 'A reference needs its citation text.' };
  if (raw.length > MAX_RAW) return { error: `A reference may be at most ${MAX_RAW} characters.` };

  const year = r.year != null && r.year !== '' ? parseInt(r.year, 10) : yearFrom(raw);
  if (year != null && (!Number.isInteger(year) || year < 1400 || year > new Date().getFullYear() + 1))
    return { error: `“${year}” is not a plausible publication year.` };

  /* a supplied URL that is not usable is an error rather than a silent drop,
     so a contributor finds out instead of wondering where it went */
  let url = null;
  if (r.url != null && String(r.url).trim() !== '') {
    url = safeUrl(r.url);
    if (!url) return { error: 'A reference URL must be a complete http or https address.' };
  } else {
    url = safeUrl((raw.match(/https?:\/\/\S+/) || [])[0]);
  }

  const text = v => { const t = String(v ?? '').trim(); return t ? t.slice(0, 300) : null; };
  return { ref: { raw, authors: text(r.authors), title: text(r.title),
                  publisher: text(r.publisher), year, url } };
}

/* reuse an identical citation rather than storing it twice; fields supplied
   this time fill gaps on an existing row without overwriting what is there */
export function upsertRef(r) {
  const norm = normalise(r.raw);
  const hit = one('SELECT * FROM refs WHERE norm = ?', norm);
  if (hit) {
    run(`UPDATE refs SET authors = COALESCE(authors, ?), title = COALESCE(title, ?),
           publisher = COALESCE(publisher, ?), year = COALESCE(year, ?), url = COALESCE(url, ?)
         WHERE id = ?`,
        r.authors, r.title, r.publisher, r.year, r.url, hit.id);
    return hit.id;
  }
  run('INSERT INTO refs (raw,norm,authors,title,publisher,year,url,created_at) VALUES (?,?,?,?,?,?,?,?)',
      r.raw, norm, r.authors, r.title, r.publisher, r.year, r.url, now());
  return one('SELECT id FROM refs WHERE norm = ?', norm).id;
}

/* Replaces an article's reference list, preserving the order given. Returns the
   stored rows so the caller can put a copy in the version snapshot. */
export function setArticleRefs(articleId, list) {
  if (!Array.isArray(list)) return { error: 'References must be a list.' };
  if (list.length > MAX_PER_ARTICLE) return { error: `At most ${MAX_PER_ARTICLE} references per article.` };

  const clean = [];
  const seen = new Set();
  for (const item of list) {
    const v = validate(typeof item === 'string' ? { raw: item } : item);
    if (v.error) return { error: v.error };
    const key = normalise(v.ref.raw);
    if (seen.has(key)) continue;                 // the same citation twice on one article
    seen.add(key);
    clean.push(v.ref);
  }

  run('DELETE FROM article_refs WHERE article_id = ?', articleId);
  const stored = clean.map((r, i) => {
    const id = upsertRef(r);
    run('INSERT OR REPLACE INTO article_refs (article_id,ref_id,position) VALUES (?,?,?)', articleId, id, i);
    return { id, ...r };
  });
  return { refs: stored };
}

export function articleRefs(articleId) {
  return all(`SELECT r.id, r.raw, r.authors, r.title, r.publisher, r.year, r.url
                FROM article_refs ar JOIN refs r ON r.id = ar.ref_id
               WHERE ar.article_id = ? ORDER BY ar.position`, articleId);
}

/* how many articles cite each of these — shown so a contributor can see that a
   citation is shared before editing it */
export function usageCounts(ids) {
  if (!ids.length) return {};
  const out = {};
  for (const id of ids)
    out[id] = one('SELECT COUNT(*) c FROM article_refs WHERE ref_id = ?', id).c;
  return out;
}
