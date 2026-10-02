#!/bin/bash
# ==============================================================================
# KubeVision AI — Development Environment Orchestrator
#
#   scripts/dev-up.sh               # start stack (if needed) + forwards + backend + UI (:8090)
#   scripts/dev-up.sh --dev         # same, with vite hot-reload dev server (:5173)
#   scripts/dev-up.sh reload        # rebuild & restart backend + frontend (reloads code changes)
#   scripts/dev-up.sh reload --dev  # reload backend + restart vite dev server
#   scripts/dev-up.sh reload --all  # reload host AND re-apply in-cluster configs to update pods
#   scripts/dev-up.sh stop          # stop host processes (backend, vite, port-forwards)
#   scripts/dev-up.sh status        # check status of backend, forwards, and cluster pods
#
# Safe to re-run: every step is skipped if already up unless 'reload' or '--rebuild' is passed.
# Logs and pids land in .run/ (gitignored).
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_DIR=".run"
mkdir -p "$RUN_DIR"

LOG() { echo "--- $*"; }

alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

declare -A FWD_SVC=(
  [9090]="svc/prometheus-kube-prometheus-prometheus:9090:9090"
  [3100]="svc/loki-gateway:3100:80"
  [3200]="svc/tempo:3200:3200"
)

# probe: check if port is accepting connections
probe() {
  (echo > /dev/tcp/127.0.0.1/"$1") 2>/dev/null || curl -s -m 2 "http://127.0.0.1:$1" >/dev/null 2>&1
}

# --- Actions and Process Helpers ----------------------------------------------

stop_backend() {
  LOG "Stopping backend"
  local pid=""
  if [ -f "$RUN_DIR/backend.pid" ]; then
    pid="$(cat "$RUN_DIR/backend.pid" 2>/dev/null || true)"
  fi
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
    echo "  backend (pid $pid) stopped"
  else
    pkill -f "bin/kubevision-backend" 2>/dev/null && echo "  backend stopped" || echo "  backend not running"
  fi
  rm -f "$RUN_DIR/backend.pid"
}

stop_frontend() {
  LOG "Stopping frontend dev server"
  if [ -f "$RUN_DIR/frontend.pid" ] && kill -0 "$(cat "$RUN_DIR/frontend.pid")" 2>/dev/null; then
    kill "$(cat "$RUN_DIR/frontend.pid")" 2>/dev/null || true
    echo "  frontend (pid $(cat "$RUN_DIR/frontend.pid")) stopped"
  fi
  pkill -f "vite" 2>/dev/null || true
  rm -f "$RUN_DIR/frontend.pid"
}

stop_forwards() {
  LOG "Stopping port-forwards"
  pkill -f "kubectl -n monitoring port-forward" 2>/dev/null && echo "  forwards stopped" || echo "  forwards not running"
}

ensure_forwards() {
  local started=""
  for port in 9090 3100 3200; do
    IFS=: read -r svc lport rport <<< "${FWD_SVC[$port]}"
    if probe "$lport"; then
      LOG "Forward :$lport already up"
    else
      nohup kubectl -n monitoring port-forward "$svc" "$lport:$rport" >/dev/null 2>&1 &
      started="$started $!"
    fi
  done
  [ -n "$started" ] && { LOG "Started forwards:$started"; sleep 3; }
}

restart_forwards() {
  stop_forwards
  sleep 1
  ensure_forwards
}

build_backend() {
  LOG "Building backend"
  mkdir -p bin
  (cd backend && GOMODCACHE="$PWD/../.gomodcache" GOCACHE="$PWD/../.gocache" \
    GOTOOLCHAIN=auto GOSUMDB=off go build -o ../bin/kubevision-backend ./cmd/server)
}

start_backend() {
  if [ "$FOREGROUND" = true ]; then
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
    nohup ./bin/kubevision-backend > "$RUN_DIR/backend.log" 2>&1 &
  echo $! > "$RUN_DIR/backend.pid"

  for _ in $(seq 1 20); do
    curl -sf -m 2 localhost:8090/api/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
}

restart_backend() {
  stop_backend
  start_backend
}

build_frontend() {
  if [ ! -d frontend/node_modules ]; then
    LOG "Installing frontend dependencies"
    npm --prefix frontend install
  fi
  LOG "Building frontend"
  npm --prefix frontend run build
}

start_frontend_dev() {
  if [ ! -d frontend/node_modules ]; then
    LOG "Installing frontend dependencies"
    npm --prefix frontend install
  fi

  if ss -tln 2>/dev/null | grep -qE ":517[34] "; then
    LOG "Vite dev server already running"
  else
    LOG "Starting vite dev server (logs: $RUN_DIR/frontend.log)"
    VITE_API_TARGET=http://localhost:8090 nohup npm --prefix frontend run dev \
      > "$RUN_DIR/frontend.log" 2>&1 &
    echo $! > "$RUN_DIR/frontend.pid"
    sleep 2
  fi
  local ui_port=""
  for port in 5173 5174; do probe "$port" && ui_port="$port" && break; done
  echo
  echo "Up. UI: http://localhost:${ui_port:-5173}  (hot reload)"
}

sync_cluster_stack() {
  LOG "Applying in-cluster observability stack..."
  ./scripts/setup-phase2.sh
}

ensure_cluster_stack() {
  if kubectl -n monitoring get pods >/dev/null 2>&1 \
     && [ "$(kubectl -n monitoring get pods --no-headers 2>/dev/null | grep -c Running)" -ge 4 ]; then
    LOG "Stack already running in cluster"
  else
    LOG "Stack missing - running setup"
    sync_cluster_stack
  fi
}

show_status() {
  echo "=== KubeVision Dev Environment Status ==="
  if curl -sf -m 2 localhost:8090/api/v1/health >/dev/null 2>&1; then
    echo "  Backend:       HEALTHY (http://localhost:8090)"
  else
    echo "  Backend:       NOT RUNNING"
  fi

  if ss -tln 2>/dev/null | grep -qE ":517[34] "; then
    local vport="5173"
    probe 5174 && vport="5174"
    echo "  Frontend Dev:  RUNNING (http://localhost:$vport)"
  else
    echo "  Frontend Dev:  NOT RUNNING"
  fi

  for port in 9090 3100 3200; do
    if probe "$port"; then
      echo "  Port-forward:  :$port UP"
    else
      echo "  Port-forward:  :$port DOWN"
    fi
  done

  echo ""
  echo "Monitoring Pods:"
  kubectl -n monitoring get pods --no-headers 2>/dev/null | awk '{printf "  %-55s %s\n", $1, $3}' || echo "  Cluster unreachable"
}

show_help() {
  cat << EOF
Usage: $0 [COMMAND] [OPTIONS]

Commands:
  (none)      Bring up missing parts of dev environment (idempotent)
  reload      Rebuild & restart backend + frontend (reloads code changes)
  stop        Stop backend, frontend dev server, and port-forwards
  status      Check status of host processes, port-forwards, and pods

Options:
  --dev         Run Vite dev server on :5173 with HMR hot-reloading
  --rebuild     Force rebuild and restart backend & frontend
  --all         Also reapply in-cluster configs to reload monitoring pods
  --foreground  Run backend in foreground (interactive debugging)
  -h, --help    Show this help message

Examples:
  $0                  # standard start: UI on :8090
  $0 --dev            # dev mode: Vite hot-reload on :5173
  $0 reload           # rebuild & reload backend + frontend
  $0 reload --dev     # reload backend + restart Vite
  $0 reload --all     # reload backend + frontend + update in-cluster pods
  $0 stop             # stop all host processes
EOF
}

# --- Argument Parsing ---------------------------------------------------------
ACTION="start"
DEV_MODE=false
REBUILD=false
SYNC_ALL=false
FOREGROUND=false

for arg in "$@"; do
  case "$arg" in
    stop) ACTION="stop" ;;
    reload) ACTION="reload" ;;
    status) ACTION="status" ;;
    --dev) DEV_MODE=true ;;
    --rebuild) REBUILD=true ;;
    --all) SYNC_ALL=true ;;
    --foreground) FOREGROUND=true ;;
    -h|--help)
      show_help
      exit 0
      ;;
  esac
done

# --- Execute Action -----------------------------------------------------------

if [ "$ACTION" = "stop" ]; then
  stop_backend
  stop_frontend
  stop_forwards
  LOG "Cluster left running. To pause in-cluster stores: ./scripts/stack.sh pause"
  exit 0
fi

if [ "$ACTION" = "status" ]; then
  show_status
  exit 0
fi

if [ "$ACTION" = "reload" ]; then
  LOG "Reloading KubeVision dev environment..."

  if [ "$SYNC_ALL" = true ]; then
    sync_cluster_stack
    restart_forwards
  else
    ensure_forwards
  fi

  build_backend
  restart_backend

  if [ "$DEV_MODE" = true ]; then
    stop_frontend
    start_frontend_dev
  else
    build_frontend
    echo
    echo "Reloaded. UI: http://localhost:8090  (served by backend)"
  fi

  echo "API health: curl localhost:8090/api/v1/health"
  exit 0
fi

# Default: start
if [ "$SYNC_ALL" = true ]; then
  sync_cluster_stack
else
  ensure_cluster_stack
fi

ensure_forwards

if [ "$REBUILD" = true ]; then
  build_backend
  restart_backend
  if [ "$DEV_MODE" = false ]; then
    build_frontend
  fi
else
  if curl -sf -m 2 localhost:8090/api/v1/health >/dev/null 2>&1; then
    LOG "Backend already healthy on :8090"
  else
    if [ ! -x bin/kubevision-backend ]; then
      build_backend
    fi
    start_backend
  fi
fi

if [ "$DEV_MODE" = true ]; then
  start_frontend_dev
else
  if [ ! -f frontend/dist/index.html ]; then
    build_frontend
  fi
  echo
  echo "Up. UI: http://localhost:8090  (served by backend)"
fi

echo "API health: curl localhost:8090/api/v1/health"

