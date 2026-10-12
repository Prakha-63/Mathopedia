/* Database and index integrity. Run with `npm run check`.
   Exits non-zero if any probe fails, so it is usable as a gate. */
import { all, one } from '../server/db.js';

let failed = 0;
const probe = (label, sql, want = 0) => {
  const got = one(sql).c;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(36)} ${got}${ok ? '' : ` (expected ${want})`}`);
};

console.log('\nSQLite');
const integrity = one('PRAGMA integrity_check').integrity_check;
const fks = all('PRAGMA foreign_key_check').length;
if (integrity !== 'ok') failed++;
if (fks !== 0) failed++;
console.log(`  ${integrity === 'ok' ? 'ok  ' : 'FAIL'}  integrity_check                      ${integrity}`);
console.log(`  ${fks === 0 ? 'ok  ' : 'FAIL'}  foreign_key_check                    ${fks} violation(s)`);

console.log('\nReferential integrity');
probe('orphan article_refs', 'SELECT COUNT(*) c FROM article_refs ar LEFT JOIN refs r ON r.id = ar.ref_id WHERE r.id IS NULL');
probe('refs cited by nothing', 'SELECT COUNT(*) c FROM refs r LEFT JOIN article_refs ar ON ar.ref_id = r.id WHERE ar.ref_id IS NULL');
probe('articles without a concept', 'SELECT COUNT(*) c FROM articles a LEFT JOIN concepts x ON x.id = a.concept_id WHERE x.id IS NULL');
probe('articles with no current version', 'SELECT COUNT(*) c FROM articles WHERE current_version_id IS NULL');
probe('current_version pointing nowhere', 'SELECT COUNT(*) c FROM articles a LEFT JOIN article_versions v ON v.id = a.current_version_id WHERE a.current_version_id IS NOT NULL AND v.id IS NULL');
probe('dangling edges (from)', 'SELECT COUNT(*) c FROM edges e LEFT JOIN concepts c ON c.id = e.from_id WHERE c.id IS NULL');
probe('dangling edges (to)', 'SELECT COUNT(*) c FROM edges e LEFT JOIN concepts c ON c.id = e.to_id WHERE c.id IS NULL');
probe('duplicate emails', 'SELECT COUNT(*) c FROM (SELECT email FROM users GROUP BY lower(email) HAVING COUNT(*) > 1)');
/* Two accounts may legitimately share a display name — one person with a
   work and a personal address. This probe exists to catch the migration fault
   where a single identity was split across two rows, which always showed up
   as a shared name AND a shared credential, so that is what it tests. A bare
   name collision is reported below as a note, not a failure. */
probe('identities split across rows',
  `SELECT COUNT(*) c FROM (SELECT name FROM users
     WHERE name IS NOT NULL AND credential IS NOT NULL
     GROUP BY name, credential HAVING COUNT(*) > 1)`);

console.log('\nSearch index');
probe('fts rows for deleted articles', "SELECT COUNT(*) c FROM search_fts WHERE kind = 'article' AND ref_id NOT IN (SELECT id FROM articles)");
probe('fts rows for deleted concepts', "SELECT COUNT(*) c FROM search_fts WHERE kind = 'concept' AND ref_id NOT IN (SELECT id FROM concepts)");
probe('articles missing from the index', "SELECT COUNT(*) c FROM articles a WHERE a.id NOT IN (SELECT ref_id FROM search_fts WHERE kind = 'article')");
probe('concepts missing from the index', "SELECT COUNT(*) c FROM concepts x WHERE x.id NOT IN (SELECT ref_id FROM search_fts WHERE kind = 'concept')");

console.log('\nCounts');
for (const [label, sql] of [
  ['users', 'SELECT COUNT(*) c FROM users'],
  ['articles', 'SELECT COUNT(*) c FROM articles'],
  ['  reviewed', "SELECT COUNT(*) c FROM articles WHERE status = 'reviewed'"],
  ['  under review', "SELECT COUNT(*) c FROM articles WHERE status = 'under_review'"],
  ['concepts', 'SELECT COUNT(*) c FROM concepts'],
  ['edges', 'SELECT COUNT(*) c FROM edges'],
  ['article versions', 'SELECT COUNT(*) c FROM article_versions'],
  ['references', 'SELECT COUNT(*) c FROM refs'],
  ['  shared by >1 article', 'SELECT COUNT(*) c FROM (SELECT ref_id FROM article_refs GROUP BY ref_id HAVING COUNT(*) > 1)'],
  ['indexed rows', 'SELECT COUNT(*) c FROM search_fts'],
]) console.log('  ' + label.padEnd(42) + one(sql).c);

const shared = all(`SELECT name, COUNT(*) n, group_concat(email, ', ') emails FROM users
                    WHERE name IS NOT NULL GROUP BY name HAVING COUNT(*) > 1`);
if (shared.length) {
  console.log('\nNotes');
  for (const s of shared)
    console.log(`  "${s.name}" is the display name on ${s.n} accounts (${s.emails}) — expected if that is one person with two addresses`);
}

console.log(failed ? `\n${failed} check(s) failed\n` : '\nall checks passed\n');
process.exit(failed ? 1 : 0);
