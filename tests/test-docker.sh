#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-reddit-mcp-buddy:test}"
CONTAINER=""

cleanup() {
  local result=$?
  if [ -n "$CONTAINER" ]; then
    if [ "$result" -ne 0 ]; then
      docker logs "$CONTAINER" >&2 || true
    fi
    docker rm -f "$CONTAINER" > /dev/null || true
  fi
  exit "$result"
}
trap cleanup EXIT

for tool in docker curl jq; do
  command -v "$tool" > /dev/null
done

CONTAINER=$(docker run -d -p 127.0.0.1::3000 --health-interval=1s "$IMAGE")
BASE_URL="http://$(docker port "$CONTAINER" 3000/tcp)"

for ((attempt = 0; attempt < 30; attempt++)); do
  if [ "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = healthy ]; then
    break
  fi
  sleep 1
done
test "$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER")" = healthy
docker exec "$CONTAINER" node --version
curl --fail --silent --show-error --max-time 10 "$BASE_URL/health" |
  jq -e '.status == "ok" and .server == "reddit-mcp-buddy"' > /dev/null
echo 'Container health check and published HTTP port passed'

mcp_request() {
  curl --fail --silent --show-error --max-time 10 "$BASE_URL/mcp" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$1" |
    sed -n 's/^data: *//p'
}

mcp_request '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"docker-smoke","version":"1.0.0"}}}' |
  jq -e -s 'length == 1 and (.[0] | .id == 1 and .error == null and .result.serverInfo.name == "reddit-mcp-buddy" and (.result.protocolVersion | type == "string"))' > /dev/null
echo 'MCP initialization passed'

curl --fail --silent --show-error --max-time 10 "$BASE_URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null

mcp_request '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' |
  jq -e -s 'length == 1 and (.[0] | .id == 2 and .error == null and ([.result.tools[].name] | contains(["browse_subreddit", "search_reddit", "get_post_details", "user_analysis", "reddit_explain"])))' > /dev/null
echo 'MCP tool discovery passed'

docker stop --time 15 "$CONTAINER" > /dev/null
test "$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER")" = 0
echo 'Container shutdown passed'
