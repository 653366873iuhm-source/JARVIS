#!/usr/bin/env bash
# One-shot: start the local stack (same steps as testnet/local-e2e/start-local.sh), run the Python integration
# tests against it, then stop it. For sandboxes that kill background processes when the command ends.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN=/tmp/agentpad-local-e2e; mkdir -p "$RUN"; rm -f "$RUN"/agentpad-local.db*
T0=$(date +%s)
cleanup() { for p in $(cat "$RUN"/*.pid 2>/dev/null); do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done; }
trap cleanup EXIT
cd "$ROOT/contracts"
./node_modules/.bin/hardhat node --hostname 127.0.0.1 --port 8545 > "$RUN/hardhat.log" 2>&1 & echo $! > "$RUN/hardhat.pid"
for i in $(seq 1 60); do curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 && break; sleep 0.5; done
echo "hardhat up +$(( $(date +%s)-T0 ))s"
./node_modules/.bin/hardhat run scripts/deploy.ts --network localhost > "$RUN/deploy.log" 2>&1 || { tail -n 20 "$RUN/deploy.log"; exit 1; }
echo "deployed +$(( $(date +%s)-T0 ))s"
cd "$ROOT/backend"
./node_modules/.bin/tsx ../testnet/local-e2e/mock-services.ts 8790 > "$RUN/mock.log" 2>&1 & echo $! > "$RUN/mock.pid"
( set -a; . ../testnet/local-e2e/backend.env; set +a; exec ./node_modules/.bin/tsx src/main.ts ) > "$RUN/backend.log" 2>&1 & echo $! > "$RUN/backend.pid"
for i in $(seq 1 120); do curl -sf http://127.0.0.1:8080/health > /dev/null && break; sleep 0.5; done
echo "backend up +$(( $(date +%s)-T0 ))s: $(curl -s http://127.0.0.1:8080/health)"
cd "$ROOT/sdk/python"
AGENTPAD_LOCAL_E2E=1 python3 -m pytest -q -x tests/test_integration_local.py "$@"
RC=$?
echo "done +$(( $(date +%s)-T0 ))s rc=$RC"
exit $RC
