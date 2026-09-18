#!/usr/bin/env bash
# DEMS system status — a one-glance view of every moving part:
# Fabric network containers, IPFS daemon, and the Node backend.
#
# Usage:
#   scripts/dems-status.sh            one-shot snapshot
#   scripts/dems-status.sh --watch    auto-refreshing snapshot (Ctrl+C to stop)
#   scripts/dems-status.sh --logs     tail all three services' logs live

set -uo pipefail

print_snapshot() {
  echo "================================================================"
  echo " DEMS — System Status   $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "================================================================"

  echo ""
  echo "-- systemd services (auto-start on boot/login) --"
  for pair in "dems-fabric.service:Fabric containers (docker start)" \
              "dems-ipfs.service:IPFS daemon" \
              "dems-backend.service:Node backend (Fabric Gateway + REST API)"; do
    svc="${pair%%:*}"; label="${pair##*:}"
    state=$(systemctl --user is-active "$svc" 2>/dev/null)
    if [ "$state" = "active" ]; then mark="[ UP  ]"; else mark="[DOWN ]"; fi
    printf "  %s %-45s %s\n" "$mark" "$label" "($state)"
  done

  echo ""
  echo "-- Fabric network containers --"
  docker ps --format "{{.Names}}\t{{.Status}}" 2>/dev/null \
    | grep -E "orderer\.example\.com|peer0\.org|ca_org|ca_orderer|dev-peer0" \
    | while IFS=$'\t' read -r name status; do
        printf "  %-70s %s\n" "$name" "$status"
      done
  docker ps --format "{{.Names}}" 2>/dev/null \
    | grep -qE "orderer\.example\.com|peer0\.org|ca_org|ca_orderer" \
    || echo "  (none running — docker/dems-fabric.service may be down)"

  echo ""
  echo "-- IPFS daemon --"
  ipfs_ver=$(curl -s -X POST http://127.0.0.1:5001/api/v0/version 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['Version'])" 2>/dev/null)
  if [ -n "$ipfs_ver" ]; then
    echo "  reachable — Kubo v$ipfs_ver on 127.0.0.1:5001 (WebUI: http://127.0.0.1:5001/webui)"
  else
    echo "  NOT reachable on 127.0.0.1:5001"
  fi

  echo ""
  echo "-- DEMS backend (http://localhost:3000) --"
  health=$(curl -s http://localhost:3000/api/health 2>/dev/null)
  if [ -n "$health" ]; then
    echo "$health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  reachable — channel={d.get('channel')} chaincode={d.get('chaincode')}\")
print(f\"  officers enrolled: {', '.join(o.split('::')[1] for o in d.get('officers', []))}\")
print(f\"  IPFS connected: {d.get('ipfsConnected')}\")
" 2>/dev/null || echo "  reachable, but response unparseable: $health"
  else
    echo "  NOT reachable"
  fi

  echo ""
  echo "-- quick links --"
  echo "  App:          http://localhost:3000"
  echo "  IPFS WebUI:   http://127.0.0.1:5001/webui"
  echo ""
  echo "  Live logs:    scripts/dems-status.sh --logs"
  echo "  Restart one:  systemctl --user restart dems-backend.service"
  echo "================================================================"
}

case "${1:-}" in
  --watch)
    watch -n 3 -c "bash '$0'"
    ;;
  --logs)
    echo "Tailing dems-fabric, dems-ipfs, dems-backend logs — Ctrl+C to stop"
    journalctl --user -u dems-fabric.service -u dems-ipfs.service -u dems-backend.service -f -n 30
    ;;
  *)
    print_snapshot
    ;;
esac
