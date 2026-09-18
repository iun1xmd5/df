#!/usr/bin/env bash
# Blocks until peer0.org1's gRPC port answers, so dems-backend doesn't
# start (and crash-exit) before the Fabric peer containers are ready
# after a Docker/host restart.
set -euo pipefail

HOST=127.0.0.1
PORT=7051
TRIES=60

for i in $(seq 1 "$TRIES"); do
  if (exec 3<>"/dev/tcp/${HOST}/${PORT}") 2>/dev/null; then
    exec 3<&- 3>&-
    echo "peer0.org1 is accepting connections on ${HOST}:${PORT}"
    exit 0
  fi
  sleep 2
done

echo "ERROR: peer0.org1 never came up on ${HOST}:${PORT} after $((TRIES*2))s" >&2
exit 1
