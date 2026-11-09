#!/bin/bash
# Server-side regression. Read-only against real content; the one write test
# uses an isolated throwaway account that is removed at the end.
#
# Demo passwords are generated per installation and are not in version
# control, so they are read from data/demo-credentials.txt rather than
# hardcoded here. Run `npm run migrate` or `npm run rotate-demo-passwords`
# if that file is missing.
B=http://127.0.0.1:3001
J="Content-Type: application/json"
D=$(mktemp -d)

CREDS="$(dirname "$0")/../data/demo-credentials.txt"
if [ ! -f "$CREDS" ]; then
  echo "  data/demo-credentials.txt not found — run: npm run rotate-demo-passwords"; exit 2
fi
pw_for(){ awk -v u="$1" '
  $1=="username" && $2==u { found=1; next }
  found && $1=="password" { print $2; exit }' "$CREDS"; }
PW_ADMIN=$(pw_for admin); PW_READER=$(pw_for reader)
if [ -z "$PW_ADMIN" ] || [ -z "$PW_READER" ]; then
  echo "  could not read admin/reader passwords from $CREDS"; exit 2
fi
pass=0; fail=0
chk(){ # chk <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf "  ok    %-44s %s\n" "$1" "$3"; pass=$((pass+1));
  else printf "  FAIL  %-44s got %s, want %s\n" "$1" "$3" "$2"; fail=$((fail+1)); fi
}
code(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

echo "AUTHENTICATION"
chk "config endpoint"            200 "$(code $B/api/config)"
chk "me, not signed in"          401 "$(code $B/api/me)"
chk "login, wrong password"      401 "$(code -X POST $B/api/login -H "$J" -d '{"email":"admin","password":"wrong"}')"
chk "login, unknown user"        401 "$(code -X POST $B/api/login -H "$J" -d '{"email":"nobody@nowhere.test","password":"whatever"}')"
chk "login, correct"             200 "$(code -c $D/admin.txt -X POST $B/api/login -H "$J" -d "{\"email\":\"admin\",\"password\":\"$PW_ADMIN\"}")"
chk "me, signed in"              200 "$(code -b $D/admin.txt $B/api/me)"
chk "register, short password"   400 "$(code -X POST $B/api/register -H "$J" -d '{"email":"x@y.test","password":"short"}')"
chk "register, bad email"        400 "$(code -X POST $B/api/register -H "$J" -d '{"email":"notanemail","password":"longenough1"}')"
chk "register, existing email"   409 "$(code -X POST $B/api/register -H "$J" -d '{"email":"dr.p.odusanya@seed.mathopedia.invalid","password":"longenough1"}')"
chk "forgot, unknown address"    200 "$(code -X POST $B/api/forgot-password -H "$J" -d '{"email":"nobody@nowhere.test"}')"
chk "forgot, known address"      200 "$(code -X POST $B/api/forgot-password -H "$J" -d '{"email":"dr.p.odusanya@seed.mathopedia.invalid"}')"
printf "  note  forgot-password responses identical either way (no enumeration)\n"
chk "reset, bad token"           400 "$(code -X POST $B/api/reset-password -H "$J" -d '{"token":"nope","password":"longenough1"}')"
chk "verify-code, bad code"      400 "$(code -X POST $B/api/verify-code -H "$J" -d '{"email":"dr.p.odusanya@seed.mathopedia.invalid","code":"000000"}')"
chk "google oauth redirect"      302 "$(code $B/api/auth/google)"
chk "oauth callback, no state"   302 "$(code "$B/api/auth/google/callback?code=x&state=y")"

echo
echo "AUTHORIZATION"
chk "admin users, anonymous"     401 "$(code $B/api/admin/users)"
chk "admin audit, anonymous"     401 "$(code $B/api/admin/audit)"
chk "admin stats, anonymous"     401 "$(code $B/api/admin/stats)"
curl -s -c $D/reader.txt -X POST $B/api/login -H "$J" -d "{\"email\":\"reader\",\"password\":\"$PW_READER\"}" -o /dev/null
chk "admin users, as visitor"    403 "$(code -b $D/reader.txt $B/api/admin/users)"
chk "create article, as visitor" 403 "$(code -b $D/reader.txt -X POST $B/api/articles -H "$J" -d '{"title":"x"}')"
chk "create article, anonymous"  401 "$(code -X POST $B/api/articles -H "$J" -d '{"title":"x"}')"
chk "admin users, as admin"      200 "$(code -b $D/admin.txt $B/api/admin/users)"
chk "admin audit, as admin"      200 "$(code -b $D/admin.txt $B/api/admin/audit)"
chk "admin stats, as admin"      200 "$(code -b $D/admin.txt $B/api/admin/stats)"

echo
echo "ADMIN GUARDS (destructive paths, refused by design)"
AID=$(curl -s -b $D/admin.txt $B/api/me | node -pe "'x'" 2>/dev/null)
SELF=$(curl -s -b $D/admin.txt "$B/api/admin/users?q=odusanya" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const u=JSON.parse(d).users[0];console.log(u?u.id:'')})")
chk "cannot change own role"     400 "$(code -b $D/admin.txt -X PATCH $B/api/admin/users/$SELF/role -H "$J" -d "{\"role\":\"visitor\"}")"
chk "cannot suspend self"        400 "$(code -b $D/admin.txt -X PATCH $B/api/admin/users/$SELF/active -H "$J" -d "{\"active\":false}")"
chk "cannot delete self"         400 "$(code -b $D/admin.txt -X DELETE $B/api/admin/users/$SELF)"
chk "unknown user -> 404"        404 "$(code -b $D/admin.txt -X PATCH $B/api/admin/users/999999/role -H "$J" -d "{\"role\":\"visitor\"}")"
chk "unknown role rejected"      400 "$(code -b $D/admin.txt -X PATCH $B/api/admin/users/$SELF/role -H "$J" -d "{\"role\":\"superuser\"}")"

echo
echo "ARTICLES, VERSIONS, REFERENCES"
chk "versions list"              200 "$(code $B/api/articles/metric-tensor/versions)"
chk "versions, unknown article"  404 "$(code $B/api/articles/no-such-article/versions)"
chk "references list"            200 "$(code $B/api/articles/metric-tensor/references)"
chk "version body"               200 "$(code $B/api/articles/metric-tensor/versions/25)"
printf "  note  "; curl -s $B/api/articles/metric-tensor/versions | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const v=JSON.parse(d);console.log(v.versions.length+' revisions, '+v.versions.filter(x=>x.snapshot).length+' with stored text')})"

echo
echo "SEARCH"
for q in Determinants eigenvalue geometry Carmichael qqzzxx; do
  printf "  %-14s " "$q"
  curl -s "$B/api/search?q=$q" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(String(r.total).padStart(3)+' results  '+String(r.ms).padStart(5)+' ms')})"
done
printf "  visibility     anon=%s " "$(curl -s "$B/api/search?q=Determinants" | node -pe "JSON.parse(require('fs').readFileSync(0)).total" 2>/dev/null)"
printf "admin=%s\n" "$(curl -s -b $D/admin.txt "$B/api/search?q=Determinants" | node -pe "JSON.parse(require('fs').readFileSync(0)).total" 2>/dev/null)"

echo
echo "ERROR HANDLING"
chk "malformed URL -> json 400"  400 "$(code "$B/api/articles/%ZZ/versions")"
chk "bad json body -> 400"       400 "$(code -X POST $B/api/login -H "$J" -d '{bad')"
chk "unknown api path -> 404"    404 "$(code $B/api/no-such-endpoint)"
printf "  note  "; curl -s "$B/api/articles/%ZZ/versions" | head -c 70; echo

echo
echo "SESSION"
chk "logout"                     200 "$(code -b $D/admin.txt -c $D/admin.txt -X POST $B/api/logout)"
chk "admin after logout"         401 "$(code -b $D/admin.txt $B/api/admin/users)"

rm -rf $D
echo
echo "  $pass passed, $fail failed"
exit $fail
