#!/bin/bash
# One command to bring the whole dev environment up.
#
#   scripts/dev-up.sh            # stack + forwards + backend, UI served by backend at :8090
#   scripts/dev-up.sh --dev      # same, plus vite hot-reload dev server (:5173/:5174)
#   scripts/dev-up.sh --rebuild  # rebuild backend and frontend binaries before starting
#
# Safe to re-run: every step is skipped if it is already up. Logs and pids
# land in .run/ (gitignored).
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_DIR=".run"
mkdir -p "$RUN_DIR"

LOG() { echo "--- $*"; }

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# --- 1. Cluster + collection stack -----------------------------------------
if kubectl -n monitoring get pods >/dev/null 2>&1 \
   && [ "$(kubectl -n monitoring get pods --no-headers 2>/dev/null | grep -c Running)" -ge 4 ]; then
  LOG "Stack already running, skipping setup-phase2"
else
  LOG "Stack missing - running setup-phase2.sh"
  ./scripts/setup-phase2.sh
fi

# --- 2. Port-forwards (backend -> stores) -----------------------------------
FWD_PIDS=""
declare -A FWD_SVC=(
  [9090]="svc/prometheus-kube-prometheus-prometheus:9090:9090"
  [3100]="svc/loki-gateway:3100:80"
  [3200]="svc/tempo:3200:3200"
)
probe() { curl -sf -m 2 "localhost:$1" >/dev/null 2>&1; }
for port in 9090 3100 3200; do
  IFS=: read -r svc lport rport <<< "${FWD_SVC[$port]}"
  if probe "$lport"; then
    LOG "Forward :$lport already up"
  else
    kubectl -n monitoring port-forward "$svc" "$lport:$rport" >/dev/null 2>&1 &
    FWD_PIDS="$FWD_PIDS $!"
  fi
done
[ -n "$FWD_PIDS" ] && { LOG "Started forwards:$FWD_PIDS"; sleep 4; }

# --- 3. Backend --------------------------------------------------------------
if [ "${1:-}" = "--rebuild" ] || [ "${2:-}" = "--rebuild" ]; then
  LOG "Building backend"
  (cd backend && GOMODCACHE="$PWD/../.gomodcache" GOCACHE="$PWD/../.gocache" \
    GOTOOLCHAIN=auto GOSUMDB=off go build -o ../bin/kubevision-backend ./cmd/server)
fi

if curl -sf -m 3 localhost:8090/api/v1/health >/dev/null 2>&1; then
  LOG "Backend already healthy on :8090"
else
  alive "$RUN_DIR/backend.pid" && kill "$(cat "$RUN_DIR/backend.pid")" 2>/dev/null || true
  if [ ! -x bin/kubevision-backend ]; then
    LOG "No binary - building backend"
    (cd backend && GOMODCACHE="$PWD/../.gomodcache" GOCACHE="$PWD/../.gocache" \
      GOTOOLCHAIN=auto GOSUMDB=off go build -o ../bin/kubevision-backend ./cmd/server)
  fi
  if [ "${1:-}" = "--foreground" ] || [ "${2:-}" = "--foreground" ]; then
    LOG "Starting backend on :8090 (foreground)"
    PORT=8090 \
    DB_PATH=./data/kubevision-dev \
    PROMETHEUS_URL=http://localhost:9090 \
    LOKI_URL=http://localhost:3100 \
    TEMPO_URL=http://localhost:3200 \
    OBSERVED_NAMESPACE="${OBSERVED_NAMESPACE:-boutique}" \
    FRONTEND_DIR="${FRONTEND_DIR:-frontend/dist}" \
      exec ./bin/kubevision-backend
  fi
  LOG "Starting backend on :8090 (logs: $RUN_DIR/backend.log)"
  PORT=8090 \
  DB_PATH=./data/kubevision-dev \
  PROMETHEUS_URL=http://localhost:9090 \
  LOKI_URL=http://localhost:3100 \
  TEMPO_URL=http://localhost:3200 \
  OBSERVED_NAMESPACE="${OBSERVED_NAMESPACE:-boutique}" \
  FRONTEND_DIR="${FRONTEND_DIR:-frontend/dist}" \
    ./bin/kubevision-backend > "$RUN_DIR/backend.log" 2>&1 &
  echo $! > "$RUN_DIR/backend.pid"
  for _ in $(seq 1 20); do
    curl -sf -m 2 localhost:8090/api/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# --- 4. Frontend -------------------------------------------------------------
if [ "${1:-}" = "--dev" ] || [ "${2:-}" = "--dev" ]; then
  if ss -tln 2>/dev/null | grep -qE ":517[34] "; then
    LOG "Vite dev server already running"
  else
    LOG "Starting vite dev server (logs: $RUN_DIR/frontend.log)"
    VITE_API_TARGET=http://localhost:8090 npm --prefix frontend run dev \
      > "$RUN_DIR/frontend.log" 2>&1 &
    echo $! > "$RUN_DIR/frontend.pid"
    sleep 2
  fi
  UI_URL=""
  for port in 5173 5174; do probe "$port" && UI_URL="$port" && break; done
  echo
  echo "Up. UI: http://localhost:${UI_URL:-5173}  (hot reload)"
else
  if [ ! -f frontend/dist/index.html ]; then
    LOG "No frontend build - building"
    npm --prefix frontend run build
  fi
  echo
  echo "Up. UI: http://localhost:8090  (served by backend)"
fi

echo "API health: curl localhost:8090/api/v1/health"
