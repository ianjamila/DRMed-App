#!/bin/zsh
# =============================================================================
# 0207_request_guard_e2e.sh — end-to-end proof of api_request_guard (0201/0207)
# =============================================================================
# Starts THROWAWAY containers (never the shared stack, never prod): Supabase
# Postgres 17.6.1.111 — the image that segfaults on a refused function call —
# with PostgREST v14.5 (prod's version) in front, applies the real 0201 and
# 0207 migration files, and fires anonymous requests at it. Fails if any
# request restarts Postgres or answers with an unexpected status.
#
#   supabase/tests/0207_request_guard_e2e.sh            # 0201 + 0207 (expect PASS)
#   supabase/tests/0207_request_guard_e2e.sh --only-0201   # shows the two bypasses
#
# Needs Docker (OrbStack) with both images pulled. Uses network
# drm-guard-net, containers drm-guard-pg/drm-guard-rest and port 56399; all are
# removed at the end.
# =============================================================================
set -u
export PATH="/opt/homebrew/bin:$HOME/.orbstack/bin:$PATH"
ROOT=${0:a:h:h:h}
ONLY_0201=0; [[ ${1:-} == --only-0201 ]] && ONLY_0201=1
U=http://127.0.0.1:56399
PG=public.ecr.aws/supabase/postgres:17.6.1.111
REST=public.ecr.aws/supabase/postgrest:v14.5
FAILS=0

cleanup() { docker rm -f drm-guard-rest drm-guard-pg >/dev/null 2>&1; docker network rm drm-guard-net >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker network create drm-guard-net >/dev/null
docker run -d --name drm-guard-pg --network drm-guard-net -e POSTGRES_PASSWORD=postgres $PG >/dev/null
for i in {1..60}; do docker exec drm-guard-pg pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 1; done
sleep 3
sql() { docker exec -i drm-guard-pg psql -v ON_ERROR_STOP=1 -q -U supabase_admin -h localhost -d postgres "$@"; }
sql <<'SQL' || exit 1
alter role authenticator with password 'postgres';
-- stand-ins for the migrations 0201 needs (lab_search, the 0119 default ACL)
create table public.test_requests (id int);
grant select on public.test_requests to anon;
create function public.lab_search(public.test_requests) returns text language sql as 'select null::text';
create function public.secret_fn() returns int language sql as 'select 1';
revoke all on function public.secret_fn() from public, anon, authenticated;
create function public.open_fn() returns int language sql as 'select 2';
grant execute on function public.open_fn() to anon;
create schema other; grant usage on schema other to anon, authenticated;
create function other.secret_fn() returns int language sql as 'select 9';
grant execute on function other.secret_fn() to anon;
create function other.open_other() returns int language sql as 'select 3';
grant execute on function other.open_other() to anon;
SQL
sql < $ROOT/supabase/migrations/0201_denied_call_guard.sql || exit 1
if (( ! ONLY_0201 )); then sql < $ROOT/supabase/migrations/0207_request_guard_encoded_paths.sql || exit 1; fi
docker run -d --name drm-guard-rest --network drm-guard-net -p 56399:3000 \
  -e PGRST_DB_URI=postgres://authenticator:postgres@drm-guard-pg:5432/postgres \
  -e PGRST_DB_SCHEMAS=public,other -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters $REST >/dev/null
for i in {1..30}; do curl -s -o /dev/null $U/ && break; sleep 1; done

crashes() { docker logs drm-guard-pg 2>&1 | grep -c "terminated by signal"; }
# expect <status> <method> <path> [curl header args...]
expect() {
  local want=$1 m=$2 pth=$3; shift 3
  local before=$(crashes) code
  case $m in
    POST) code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is -X POST -H 'Content-Type: application/json' "$@" -d '{}' "$U$pth") ;;
    HEAD) code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is -I "$@" "$U$pth") ;;
    *)    code=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$@" "$U$pth") ;;
  esac
  sleep 1
  local verdict=ok
  if (( $(crashes) > before )); then
    verdict="CRASH (Postgres restarted)"; FAILS=$((FAILS + 1))
    for i in {1..30}; do docker exec drm-guard-pg pg_isready -U postgres -h localhost >/dev/null 2>&1 && break; sleep 1; done; sleep 3
  elif [[ $code != $want ]]; then
    verdict="want $want"; FAILS=$((FAILS + 1))
  fi
  printf '%-4s %-22s %-52s %s %s\n' $m $pth "$*" $code "$verdict"
}

for m in POST GET HEAD; do
  expect 200 $m /rpc/open_fn
  expect 401 $m /rpc/secret_fn
  expect 401 $m /%72pc/secret_fn           # encoded route segment (0207 fix 1)
  expect 401 $m /r%70c/secret_fn
  expect 401 $m /rpc/%73ecret_fn           # encoded name (0201)
  expect 401 $m /%72pc/open_fn             # any encoded path is refused
  expect 404 $m /RPC/secret_fn
  expect 404 $m /x/../rpc/secret_fn
done
# the profile header sent twice: PostgREST uses the first (0207 fix 2)
expect 401 POST /rpc/secret_fn -H 'Content-Profile: public' -H 'Content-Profile: other'
expect 401 GET  /rpc/secret_fn -H 'Accept-Profile: public' -H 'Accept-Profile: other'
expect 401 POST /rpc/secret_fn -H 'Content-Profile: other' -H 'Content-Profile: public'
expect 401 GET  /rpc/secret_fn -H 'Content-Profile: other'   # GET ignores Content-Profile
# legitimate traffic
expect 200 GET  /rpc/open_other -H 'Accept-Profile: other'
expect 200 POST /rpc/open_other -H 'Content-Profile: other'
expect 200 GET  /test_requests
expect 200 GET  /

echo
if (( FAILS )); then echo "FAIL: $FAILS request(s) crashed Postgres or answered unexpectedly"; exit 1; fi
echo "PASS: no request restarted Postgres; every status as expected"
