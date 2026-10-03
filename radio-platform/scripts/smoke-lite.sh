#!/usr/bin/env bash
# Acceptance check for the simple (lite) server: every endpoint the web page calls, plus noindex and source status.
# Usage: scripts/smoke-lite.sh [base-url]   (default http://127.0.0.1:8080). Needs curl and python3.
set -euo pipefail
BASE="${1:-http://127.0.0.1:8080}"
fail() { echo "FAIL: $*" >&2; exit 1; }
json() { curl -fsS "$BASE$1"; }
py() { python3 -c "$1"; }

curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "page does not serve the app"
curl -fsSI "$BASE/" | grep -qi 'x-robots-tag: noindex' || fail "noindex header missing"
json /api/health | py "import sys,json; h=json.load(sys.stdin); assert h['status']=='ok' and h['content'] in ('ok','degraded','empty'), h; print('health', h['content'], 'episodes', h['episodes'], 'news', h['news'], 'failing', h['failing'])"
json /api/channels | py "import sys,json; c=json.load(sys.stdin)['channels']; assert {'ajn-radio','ajn-exclusive'} <= {x['slug'] for x in c}, c"
FIRST=$(json '/api/channels/ajn-radio/episodes?limit=5')
echo "$FIRST" | py "import sys,json; d=json.load(sys.stdin); e=d['episodes']; assert 0 < len(e) <= 5 and all(x['audioUrl'].startswith('https://') for x in e), d"
CURSOR=$(echo "$FIRST" | py "import sys,json; print(json.load(sys.stdin).get('nextCursor') or '')")
[ -z "$CURSOR" ] || json "/api/channels/ajn-radio/episodes?limit=5&cursor=$CURSOR" | py "import sys,json; assert json.load(sys.stdin)['episodes'], 'second page empty'"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/channels/ajn-radio/episodes?cursor=does-not-exist")" = 400 ] || fail "invalid cursor not rejected"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/channels/nope/episodes")" = 404 ] || fail "unknown channel not 404"
json /api/channels/ajn-radio/episodes/facets | py "import sys,json; assert json.load(sys.stdin)['facets']"
json /api/news | py "import sys,json; n=json.load(sys.stdin); assert n['top'] and all(i['url'].startswith('https://') for i in n['top']), n; print('news top', len(n['top']), 'sources', len(n['bySource']), 'fetchedAt', n.get('fetchedAt'))"
json /api/sources | py "import sys,json; s=json.load(sys.stdin)['sources']; print('sources', {x['slug']: x['lastStatus'] for x in s})"
echo "smoke-lite OK ($BASE)"
