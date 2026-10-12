#!/bin/bash
# Reviewer decision flow on an isolated article. Cleans up after itself.
B=http://127.0.0.1:3001
J="Content-Type: application/json"
D=$(mktemp -d)
jq(){ node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(eval('(x=>('+process.argv[1]+'))')(JSON.parse(d)))}catch(e){console.log('(unparsed) '+d.slice(0,120))}})" "$1"; }

curl -s -c $D/con.txt -X POST $B/api/login -H "$J" -d '{"email":"contributor","password":"contrib123"}' -o /dev/null
curl -s -c $D/rev.txt -X POST $B/api/login -H "$J" -d '{"email":"reviewer","password":"review123"}' -o /dev/null

echo "SETUP — contributor submits an article"
NEW=$(curl -s -b $D/con.txt -X POST $B/api/articles -H "$J" -d '{
  "title":"Review Flow Probe","abstract":"Disposable record for testing reviewer decisions.",
  "field":"algebra","conceptId":"__new__",
  "sections":[{"heading":"Body","body":"Placeholder."}],"tags":["probe"]}')
AID=$(echo "$NEW" | jq "x.id"); CID=$(echo "$NEW" | jq "x.conceptId")
echo "  created $AID (status under_review)"

echo
echo "GUARDS"
printf "  revise with no comment   -> "; curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"revise"}' -w "  [%{http_code}]\n"
printf "  reject with no comment   -> "; curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"reject"}' -w "  [%{http_code}]\n"
printf "  unknown action           -> "; curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"banish"}' -w "  [%{http_code}]\n"
printf "  contributor may not rule -> "; curl -s -b $D/con.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"approve"}' -w "  [%{http_code}]\n"
printf "  anonymous may not rule   -> "; curl -s -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"approve"}' -w "  [%{http_code}]\n"
printf "  unknown article          -> "; curl -s -b $D/rev.txt -X POST $B/api/articles/no-such/review -H "$J" -d '{"action":"approve"}' -w "  [%{http_code}]\n"

echo
echo "REQUEST REVISION"
curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" \
  -d '{"action":"revise","comment":"Please add a worked example after the definition."}' -w "  [%{http_code}]\n"
printf "  status now        : "; curl -s -b $D/con.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).articles.find(x=>x.id==='$AID');console.log(a.status+'  reviewer='+a.reviewer)})"
printf "  reviewer note     : "; curl -s -b $D/con.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).articles.find(x=>x.id==='$AID');console.log(JSON.stringify(a.comments))})"
printf "  AUTHOR notified   : "; curl -s -b $D/con.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log(n.unread+' unread | newest: '+(n.notifications[0]?n.notifications[0].text:'none'))})"
printf "  REVIEWER sees own : "; curl -s -b $D/rev.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log((n.notifications[0]&&/Review Flow Probe/.test(n.notifications[0].text)&&/your article/.test(n.notifications[0].text))?'LEAKED to reviewer':'no author-addressed message (correct)')})"
printf "  left the queue    : "; curl -s -b $D/rev.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const q=JSON.parse(d).articles.filter(x=>x.status==='under_review').map(x=>x.id);console.log(q.includes('$AID')?'STILL IN QUEUE':'yes, out of the reviewer queue')})"

echo
echo "CONTRIBUTOR RESUBMITS"
curl -s -b $D/con.txt -X POST $B/api/articles/$AID/versions -H "$J" -d '{
  "title":"Review Flow Probe","abstract":"Disposable record, revised.",
  "sections":[{"heading":"Body","body":"Placeholder with the worked example added."}],
  "tags":["probe"],"summary":"Addressed reviewer note"}' -w "  [%{http_code}]\n"
printf "  status now        : "; curl -s -b $D/con.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).articles.find(x=>x.id==='$AID');console.log(a.status)})"
printf "  REVIEWER notified : "; curl -s -b $D/rev.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log(n.notifications[0]?n.notifications[0].text:'none')})"

echo
echo "REJECT"
curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" \
  -d '{"action":"reject","comment":"Out of scope for the encyclopedia."}' -w "  [%{http_code}]\n"
printf "  status now        : "; curl -s -b $D/con.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).articles.find(x=>x.id==='$AID');console.log(a.status+'  reviewer='+a.reviewer)})"
printf "  AUTHOR notified   : "; curl -s -b $D/con.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log(n.notifications[0].text)})"
printf "  hidden from public: "; curl -s "$B/api/search?q=Review%20Flow%20Probe" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.results.filter(x=>x.articleId==='$AID').length===0?'yes':'VISIBLE ANONYMOUSLY')})"

echo
echo "APPROVE (from rejected)"
curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"approve"}' -w "  [%{http_code}]\n"
printf "  status now        : "; curl -s -b $D/con.txt $B/api/bootstrap | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d).articles.find(x=>x.id==='$AID');console.log(a.status+'  reviewer='+a.reviewer)})"
printf "  AUTHOR notified   : "; curl -s -b $D/con.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const n=JSON.parse(d);console.log(n.notifications[0].text)})"
printf "  approve again     -> "; curl -s -b $D/rev.txt -X POST $B/api/articles/$AID/review -H "$J" -d '{"action":"approve"}' -w "  [%{http_code}]\n"
printf "  history           : "; curl -s $B/api/articles/$AID/versions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);console.log(v.versions.map(x=>x.version+' ('+x.summary+')').join(' | '))})"

echo
echo "MARK READ"
printf "  unread before     : "; curl -s -b $D/con.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).unread))"
curl -s -b $D/con.txt -X POST $B/api/notifications/read -H "$J" -d '{}' -o /dev/null
printf "  unread after      : "; curl -s -b $D/con.txt $B/api/notifications | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).unread))"

echo
echo "CLEAN UP"
node --experimental-sqlite --no-warnings --env-file=.env -e "
import('./server/db.js').then(({run,all})=>{
  const aid='$AID', cid='$CID';
  run('DELETE FROM comments WHERE article_id = ?', aid);
  run('UPDATE articles SET current_version_id = NULL WHERE id = ?', aid);
  run('DELETE FROM article_versions WHERE article_id = ?', aid);
  run('DELETE FROM article_refs WHERE article_id = ?', aid);
  run('DELETE FROM articles WHERE id = ?', aid);
  run('DELETE FROM verifications WHERE concept_id = ?', cid);
  run('DELETE FROM edges WHERE from_id = ? OR to_id = ?', cid, cid);
  run('DELETE FROM concepts WHERE id = ?', cid);
  run('DELETE FROM search_fts WHERE ref_id IN (?,?)', aid, cid);
  run(\"DELETE FROM notifications WHERE body LIKE '%Review Flow Probe%'\");
  run(\"DELETE FROM audit_log WHERE target = ? OR detail LIKE 'Review Flow Probe%'\", aid);
  console.log('  removed article, concept, versions, comments, verification, notifications and audit rows');
});"
curl -s -b $D/con.txt -X POST $B/api/logout -o /dev/null
curl -s -b $D/rev.txt -X POST $B/api/logout -o /dev/null
rm -rf $D
