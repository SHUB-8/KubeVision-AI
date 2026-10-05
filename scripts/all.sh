#!/usr/bin/env bash
# ==============================================================================
# KubeVision AI — Full-Stack Master Lifecycle Controller
#
# Starts and stops the entire KubeVision AI environment end-to-end:
#   1. k3s Kubernetes service & cluster readiness
#   2. Observability pods (monitoring) and demo app workloads (boutique)
#   3. Port-forwards (Prometheus 9090, Loki 3100, Tempo 3200, Demo App 8080)
#   4. Go backend API server (:8090)
#   5. Frontend UI (:8090 production build, or :5173 Vite dev server)
#
# Usage:
#   ./scripts/all.sh                   # Start full stack (k3s, pods, forwards, backend, UI)
#   ./scripts/all.sh --dev             # Start full stack with Vite hot-reload (:5173)
#   ./scripts/all.sh stop              # Reverse: gracefully stop backend, UI, forwards, and k3s
#   ./scripts/all.sh restart           # Full restart (stop then start)
#   ./scripts/all.sh status            # Comprehensive health status of all components
# ==============================================================================
set -euo pipefail

# Always run from the repository root
cd "$(dirname "$0")/.."

# --- Configuration & Paths ----------------------------------------------------
RUN_DIR=".run"
mkdir -p "$RUN_DIR"

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log_header()  { echo -e "\n${BOLD}${CYAN}=== $* ===${NC}"; }
log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# Helper to run privileged commands with sudo when non-root
run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

check_sudo() {
  if [ "$(id -u)" -ne 0 ]; then
    if ! sudo -n true 2>/dev/null; then
      log_info "Sudo password required for k3s service management."
      sudo -v
    fi
  fi
}

probe_port() {
  (echo > /dev/tcp/127.0.0.1/"$1") 2>/dev/null || curl -sf -m 2 "http://127.0.0.1:$1" >/dev/null 2>&1
}

alive() {
  [ -f "$1" ] && kill -0 "$(cat "$1" 2>/dev/null)" 2>/dev/null
}

# --- Step 1: k3s Service Management -------------------------------------------

ensure_kubeconfig() {
  local k3s_cfg="/etc/rancher/k3s/k3s.yaml"
  local user_cfg="$HOME/.kube/config"

  if [ -f "$k3s_cfg" ]; then
    mkdir -p "$HOME/.kube"
    if [ ! -f "$user_cfg" ] || [ "$k3s_cfg" -nt "$user_cfg" ]; then
      log_info "Synchronizing $user_cfg with $k3s_cfg..."
      check_sudo
      run_sudo cat "$k3s_cfg" > "$user_cfg"
      run_sudo chown "$(id -u):$(id -g)" "$user_cfg" 2>/dev/null || true
      chmod 600 "$user_cfg"
    fi
    export KUBECONFIG="$user_cfg"
  fi
}

start_k3s() {
  log_header "Step 1/5: Starting k3s Kubernetes Cluster"

  if ! command -v k3s >/dev/null 2>&1; then
    log_error "k3s binary not found. Please run ./scripts/setup-phase1.sh first."
    exit 1
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet k3s; then
      log_success "k3s systemd service is already active."
    else
      check_sudo
      log_info "Starting k3s systemd service..."
      run_sudo systemctl start k3s

      local waited=0
      while ! systemctl is-active --quiet k3s; do
        sleep 1
        waited=$((waited + 1))
        if [ "$waited" -ge 30 ]; then
          log_error "k3s service failed to start within 30s."
          run_sudo systemctl status k3s --no-pager || true
          exit 1
        fi
      done
      log_success "k3s service started."
    fi
  else
    log_warn "systemctl not available; assuming external or containerized cluster."
  fi

  ensure_kubeconfig

  log_info "Waiting for Kubernetes API server to respond..."
  local api_waited=0
  until kubectl get nodes >/dev/null 2>&1; do
    sleep 2
    api_waited=$((api_waited + 2))
    if [ "$api_waited" -ge 45 ]; then
      log_error "Timed out waiting for Kubernetes API server at 127.0.0.1:6443."
      exit 1
    fi
  done
  log_success "Kubernetes API server is responding."

  log_info "Waiting for cluster node(s) to become Ready..."
  if kubectl wait --for=condition=Ready node --all --timeout=60s >/dev/null 2>&1; then
    log_success "Cluster node(s) are Ready."
  else
    log_warn "Node wait timed out, continuing anyway."
  fi
}

stop_k3s() {
  log_header "Stopping k3s Kubernetes Cluster"

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet k3s; then
      check_sudo
      log_info "Stopping k3s systemd service..."
      run_sudo systemctl stop k3s

      local waited=0
      while systemctl is-active --quiet k3s; do
        sleep 1
        waited=$((waited + 1))
        if [ "$waited" -ge 30 ]; then
          log_warn "k3s took longer than 30s to stop."
          break
        fi
      done
      log_success "k3s service stopped."
    else
      log_info "k3s systemd service was already inactive."
    fi
  fi

  # In k3s, containerd-shims and pod containers can remain running in the background
  # even after systemctl stop k3s (due to containerd live-restore).
  # Run k3s-killall.sh to ensure all remaining shims and container processes are terminated.
  local shims
  shims="$(ps -e -o pid= -o args= | grep -E "containerd-shim" | grep -v grep | cut -f1 || true)"

  if [ -n "$shims" ] || [ -x /usr/local/bin/k3s-killall.sh ]; then
    if [ -x /usr/local/bin/k3s-killall.sh ]; then
      log_info "Running k3s-killall.sh to terminate all lingering containerd shims and containers..."
      check_sudo
      run_sudo /usr/local/bin/k3s-killall.sh >/dev/null 2>&1 || true
    else
      log_info "Terminating lingering containerd-shim processes..."
      check_sudo
      run_sudo pkill -9 -f "containerd-shim" 2>/dev/null || true
    fi
    log_success "All container processes terminated."
  fi
}

stop_pods() {
  log_header "Stopping Kubernetes Workload Pods"

  if kubectl get nodes >/dev/null 2>&1; then
    # 1. Scale down boutique demo app
    if kubectl get namespace boutique >/dev/null 2>&1; then
      log_info "Scaling down boutique demo workloads to 0 replicas..."
      kubectl -n boutique scale deploy --all --replicas=0 2>/dev/null || true
    fi

    # 2. Pause monitoring stack
    if kubectl get namespace monitoring >/dev/null 2>&1; then
      log_info "Pausing monitoring stack (scaling stores to 0, removing DaemonSets)..."
      ./scripts/stack.sh pause 2>/dev/null || true
    fi

    log_info "Waiting for workload pods to terminate..."
    for _ in $(seq 1 15); do
      local remaining
      remaining="$(kubectl get pods -A --field-selector=metadata.namespace!=kube-system --no-headers 2>/dev/null | grep -cE "Running|Terminating" || true)"
      if [ "$remaining" -eq 0 ]; then
        break
      fi
      sleep 1
    done
    log_success "Workload pods stopped."
  else
    log_info "Kubernetes cluster is not reachable; skipping in-cluster pod scale down."
  fi
}

# --- Step 2: Ensure and Wait for All Pods --------------------------------------

ensure_and_wait_pods() {
  log_header "Step 2/5: Verifying & Waiting for All Pods"

  # 1. Monitoring Namespace
  if kubectl get namespace monitoring >/dev/null 2>&1; then
    log_info "Checking monitoring stack workloads..."

    # Check if stack stores were paused (e.g. via stack.sh pause)
    local tempo_replicas loki_replicas prom_replicas
    tempo_replicas="$(kubectl -n monitoring get deploy tempo -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
    loki_replicas="$(kubectl -n monitoring get sts loki -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
    prom_replicas="$(kubectl -n monitoring get sts prometheus-prometheus-kube-prometheus-prometheus -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
    if [ "$tempo_replicas" -eq 0 ] || [ "$loki_replicas" -eq 0 ] || [ "$prom_replicas" -eq 0 ]; then
      log_info "Monitoring stack stores are paused (replicas=0). Resuming workloads via stack.sh..."
      ./scripts/stack.sh resume
    fi

    log_info "Waiting for monitoring pods to be Ready..."
    echo "  > Waiting for Tempo deployment..."
    kubectl -n monitoring rollout status deploy/tempo --timeout=120s
    echo "  > Waiting for Loki statefulset (sts/loki)..."
    kubectl -n monitoring rollout status sts/loki --timeout=180s
    echo "  > Waiting for Prometheus statefulset..."
    kubectl -n monitoring rollout status sts/prometheus-prometheus-kube-prometheus-prometheus --timeout=180s

    if kubectl -n monitoring get ds fluent-bit >/dev/null 2>&1; then
      echo "  > Waiting for Fluent Bit DaemonSet..."
      kubectl -n monitoring rollout status ds/fluent-bit --timeout=120s
    fi
    if kubectl -n monitoring get ds beyla >/dev/null 2>&1; then
      echo "  > Waiting for Beyla DaemonSet..."
      kubectl -n monitoring rollout status ds/beyla --timeout=120s
    fi
    log_success "All monitoring pods (Loki, Prometheus, Tempo, Fluent Bit, Beyla) are active."
  else
    log_warn "Namespace 'monitoring' not found. Run ./scripts/setup-phase2.sh to deploy it."
  fi

  # 2. Observed Demo App (Boutique)
  if [ "$SKIP_DEMO" = false ] && kubectl get namespace boutique >/dev/null 2>&1; then
    log_info "Checking demo app workloads (ns/boutique)..."
    local frontend_replicas
    frontend_replicas="$(kubectl -n boutique get deploy frontend -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "1")"
    if [ "$frontend_replicas" -eq 0 ]; then
      log_info "Demo app was scaled to 0. Rescaling boutique microservices to 1..."
      kubectl -n boutique scale deploy --all --replicas=1
    fi

    log_info "Waiting for boutique storefront deployment..."
    kubectl -n boutique rollout status deploy/frontend --timeout=120s 2>/dev/null || true
    log_success "Demo app pods are active."
  fi

  # Compact pods status
  echo ""
  log_info "Workload pods summary:"
  kubectl get pods -A --field-selector=metadata.namespace!=kube-system --no-headers 2>/dev/null | \
    awk '{printf "  [%-12s] %-52s %s\n", $1, $2, $4}' || true
}

# --- Step 3: Port-Forwards Management -----------------------------------------

stop_forwards() {
  log_info "Stopping all port-forwards..."
  
  # Clean up tracked PID files
  for pidfile in "$RUN_DIR"/port-forward-*.pid; do
    if [ -f "$pidfile" ]; then
      local pid
      pid="$(cat "$pidfile" 2>/dev/null || true)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
      fi
      rm -f "$pidfile"
    fi
  done

  # Blanket kill any remaining kubectl port-forward processes
  pkill -f "kubectl.*port-forward.*(9090|3100|3200|8080)" 2>/dev/null || true
  sleep 1
  log_success "Port-forwards stopped."
}

start_forwards() {
  log_header "Step 3/5: Establishing Port-Forwards"

  # Clean any stale forwards first
  stop_forwards

  local forwards=(
    "monitoring:svc/prometheus-kube-prometheus-prometheus:9090:9090:Prometheus"
    "monitoring:svc/loki-gateway:3100:80:Loki"
    "monitoring:svc/tempo:3200:3200:Tempo"
  )

  if [ "$SKIP_DEMO" = false ] && kubectl -n boutique get svc frontend >/dev/null 2>&1; then
    forwards+=("boutique:svc/frontend:8080:80:Boutique Demo")
  fi

  for item in "${forwards[@]}"; do
    IFS=: read -r ns svc lport rport label <<< "$item"

    log_info "Forwarding :$lport -> $ns/$svc ($label)..."
    nohup kubectl -n "$ns" port-forward "$svc" "$lport:$rport" > "$RUN_DIR/port-forward-$lport.log" 2>&1 &
    echo $! > "$RUN_DIR/port-forward-$lport.pid"
  done

  log_info "Waiting for port-forwards to establish..."
  local required_ports=(9090 3100 3200)
  if [ "$SKIP_DEMO" = false ] && kubectl -n boutique get svc frontend >/dev/null 2>&1; then
    required_ports+=(8080)
  fi

  for port in "${required_ports[@]}"; do
    local ready=false
    for _ in $(seq 1 20); do
      if probe_port "$port"; then
        ready=true
        break
      fi
      sleep 0.5
    done
    if [ "$ready" = true ]; then
      log_success "Port :$port is open and accepting traffic."
    else
      log_warn "Port :$port did not respond to probe yet; check $RUN_DIR/port-forward-$port.log."
    fi
  done
}

# --- Step 4: Backend Management -----------------------------------------------

build_backend() {
  log_info "Building backend binary (bin/kubevision-backend)..."
  mkdir -p bin
  (cd backend && GOMODCACHE="$PWD/../.gomodcache" GOCACHE="$PWD/../.gocache" \
    GOTOOLCHAIN=auto GOSUMDB=off go build -o ../bin/kubevision-backend ./cmd/server)
  log_success "Backend build complete."
}

stop_backend() {
  log_info "Stopping backend..."
  local pid=""
  if [ -f "$RUN_DIR/backend.pid" ]; then
    pid="$(cat "$RUN_DIR/backend.pid" 2>/dev/null || true)"
  fi

  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    # Send SIGTERM for graceful shutdown (flushes BadgerDB and releases file lock)
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$pid" 2>/dev/null; then
      log_warn "Backend did not exit on SIGTERM; forcing SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    else
      log_success "Backend (pid $pid) stopped gracefully."
    fi
  else
    pkill -f "bin/kubevision-backend" 2>/dev/null && log_success "Backend stopped." || log_info "Backend was not running."
  fi
  rm -f "$RUN_DIR/backend.pid"
}

start_backend() {
  log_header "Step 4/5: Starting Go Backend"

  # Stop any running backend first to ensure Badger lock is free
  stop_backend

  if [ ! -x bin/kubevision-backend ] || [ "$REBUILD" = true ]; then
    build_backend
  fi

  local port="${PORT:-8090}"
  local db_path="${DB_PATH:-./data/kubevision-dev}"

  if [ "$FOREGROUND" = true ]; then
    log_info "Starting backend on :$port in foreground..."
    PORT="$port" \
    DB_PATH="$db_path" \
    PROMETHEUS_URL="http://localhost:9090" \
    LOKI_URL="http://localhost:3100" \
    TEMPO_URL="http://localhost:3200" \
    OBSERVED_NAMESPACE="${OBSERVED_NAMESPACE:-boutique}" \
    FRONTEND_DIR="${FRONTEND_DIR:-frontend/dist}" \
      exec ./bin/kubevision-backend
  fi

  log_info "Starting backend on :$port (logs: $RUN_DIR/backend.log)..."
  PORT="$port" \
  DB_PATH="$db_path" \
  PROMETHEUS_URL="http://localhost:9090" \
  LOKI_URL="http://localhost:3100" \
  TEMPO_URL="http://localhost:3200" \
  OBSERVED_NAMESPACE="${OBSERVED_NAMESPACE:-boutique}" \
  FRONTEND_DIR="${FRONTEND_DIR:-frontend/dist}" \
    nohup ./bin/kubevision-backend > "$RUN_DIR/backend.log" 2>&1 &
  echo $! > "$RUN_DIR/backend.pid"

  # Poll health endpoint
  log_info "Waiting for backend health check..."
  local healthy=false
  for _ in $(seq 1 30); do
    if curl -sf -m 2 "http://localhost:$port/api/v1/health" >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 0.5
  done

  if [ "$healthy" = true ] && alive "$RUN_DIR/backend.pid"; then
    log_success "Backend is healthy at http://localhost:$port (pid $(cat "$RUN_DIR/backend.pid"))."
  else
    log_error "Backend failed to start or health check timed out."
    if [ -f "$RUN_DIR/backend.log" ]; then
      echo "  Last lines of $RUN_DIR/backend.log:"
      tail -n 10 "$RUN_DIR/backend.log" | sed 's/^/    /'
    fi
    exit 1
  fi
}

# --- Step 5: Frontend Management ----------------------------------------------

stop_frontend() {
  log_info "Stopping frontend dev server..."
  if [ -f "$RUN_DIR/frontend.pid" ] && kill -0 "$(cat "$RUN_DIR/frontend.pid" 2>/dev/null)" 2>/dev/null; then
    kill "$(cat "$RUN_DIR/frontend.pid")" 2>/dev/null || true
    log_success "Frontend dev server stopped."
  fi
  pkill -f "vite" 2>/dev/null || true
  rm -f "$RUN_DIR/frontend.pid"
}

build_frontend() {
  if [ ! -d frontend/node_modules ]; then
    log_info "Installing frontend dependencies..."
    npm --prefix frontend install
  fi
  log_info "Building frontend production bundle..."
  npm --prefix frontend run build
  log_success "Frontend build complete."
}

start_frontend() {
  log_header "Step 5/5: Configuring Frontend UI"

  if [ "$DEV_MODE" = true ]; then
    stop_frontend

    if [ ! -d frontend/node_modules ]; then
      log_info "Installing frontend dependencies..."
      npm --prefix frontend install
    fi

    log_info "Starting Vite dev server on :5173 (logs: $RUN_DIR/frontend.log)..."
    VITE_API_TARGET=http://localhost:8090 nohup npm --prefix frontend run dev \
      > "$RUN_DIR/frontend.log" 2>&1 &
    echo $! > "$RUN_DIR/frontend.pid"

    sleep 2
    local ui_port="5173"
    probe_port 5174 && ui_port="5174"
    log_success "Vite dev server running on http://localhost:$ui_port (Hot Module Replacement enabled)."
  else
    # Production static mode: served directly by the backend on :8090
    if [ ! -f frontend/dist/index.html ] || [ "$REBUILD" = true ]; then
      build_frontend
    fi
    log_success "Frontend assets ready in frontend/dist (served directly by backend on :8090)."
  fi
}

# --- Status & Reporting -------------------------------------------------------

show_status() {
  log_header "KubeVision AI — System Status"

  # k3s
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet k3s; then
    echo -e "  k3s Service:     ${GREEN}ACTIVE${NC}"
  else
    echo -e "  k3s Service:     ${RED}INACTIVE${NC}"
  fi

  # Node
  if kubectl get nodes >/dev/null 2>&1; then
    local node_status
    node_status="$(kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}' | head -1)"
    echo -e "  Cluster Node:    ${GREEN}$node_status${NC}"
  else
    echo -e "  Cluster Node:    ${RED}UNREACHABLE${NC}"
  fi

  # Backend
  if curl -sf -m 2 localhost:8090/api/v1/health >/dev/null 2>&1; then
    echo -e "  Backend API:     ${GREEN}HEALTHY${NC} (http://localhost:8090)"
  else
    echo -e "  Backend API:     ${RED}DOWN${NC}"
  fi

  # Frontend Dev
  if probe_port 5173 || probe_port 5174; then
    local vport="5173"
    probe_port 5174 && vport="5174"
    echo -e "  Frontend Dev:    ${GREEN}RUNNING${NC} (http://localhost:$vport)"
  else
    echo -e "  Frontend Dev:    ${YELLOW}NOT RUNNING${NC} (using :8090 backend build)"
  fi

  # Port forwards
  echo ""
  echo "  Port-Forwards:"
  for port_info in "9090:Prometheus" "3100:Loki" "3200:Tempo" "8080:Boutique Demo"; do
    IFS=: read -r port label <<< "$port_info"
    if probe_port "$port"; then
      echo -e "    - :$port ($label): ${GREEN}UP${NC}"
    else
      echo -e "    - :$port ($label): ${RED}DOWN${NC}"
    fi
  done

  # Workload pods
  echo ""
  echo "  Kubernetes Workload Pods:"
  kubectl get pods -A --field-selector=metadata.namespace!=kube-system --no-headers 2>/dev/null | \
    awk '{printf "    %-14s %-48s %s\n", $1, $2, $4}' || echo "    (Cluster unreachable)"
}

show_summary() {
  local ui_url="http://localhost:8090"
  if [ "$DEV_MODE" = true ]; then
    local vport="5173"
    probe_port 5174 && vport="5174"
    ui_url="http://localhost:$vport"
  fi

  echo ""
  echo -e "${BOLD}${GREEN}================================================================================${NC}"
  echo -e "${BOLD}${GREEN}       KubeVision AI — Full Environment is Up and Operational!                 ${NC}"
  echo -e "${BOLD}${GREEN}================================================================================${NC}"
  echo -e "  ${BOLD}Web UI:${NC}            $ui_url"
  echo -e "  ${BOLD}Backend API:${NC}       http://localhost:8090/api/v1/health"
  echo -e "  ${BOLD}Prometheus:${NC}        http://localhost:9090"
  echo -e "  ${BOLD}Loki Gateway:${NC}      http://localhost:3100"
  echo -e "  ${BOLD}Tempo Traces:${NC}      http://localhost:3200"
  if probe_port 8080; then
    echo -e "  ${BOLD}Demo Storefront:${NC}   http://localhost:8080"
  fi
  echo ""
  echo -e "  To stop everything (reverse): ${BOLD}./scripts/all.sh stop${NC}"
  echo -e "${BOLD}${GREEN}================================================================================${NC}"
}

show_help() {
  cat << EOF
Usage: $0 [ACTION] [OPTIONS]

Actions:
  (none) | start | up Start k3s, wait for pods, start forwards, backend & frontend (default)
  stop | down         Reverse: stop frontend, backend, port-forwards, and k3s
  restart             Restart entire environment (stop followed by start)
  status              Check status of k3s, pods, port-forwards, backend, and frontend

Options:
  --dev               Run Vite dev server (:5173) with hot reload instead of built UI
  --rebuild           Force rebuild Go backend and React frontend
  --keep-k3s          On stop: keep k3s service running (stop host processes only)
                      On start: assume k3s is already running
  --skip-demo         Do not wait for or port-forward the boutique demo app
  --foreground        Run backend in foreground (interactive debugging)
  -h, --help          Show this help message
EOF
}

# --- Argument Parsing ---------------------------------------------------------
ACTION="start"
DEV_MODE=false
REBUILD=false
KEEP_K3S=false
SKIP_DEMO=false
FOREGROUND=false

for arg in "$@"; do
  case "$arg" in
    start|up) ACTION="start" ;;
    stop|down|reverse) ACTION="stop" ;;
    restart) ACTION="restart" ;;
    status) ACTION="status" ;;
    --dev) DEV_MODE=true ;;
    --rebuild) REBUILD=true ;;
    --keep-k3s|--no-k3s) KEEP_K3S=true ;;
    --skip-demo) SKIP_DEMO=true ;;
    --foreground) FOREGROUND=true ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      log_error "Unknown option or argument: $arg"
      show_help
      exit 1
      ;;
  esac
done

# --- Main Dispatch ------------------------------------------------------------

case "$ACTION" in
  start)
    if [ "$KEEP_K3S" = false ]; then
      start_k3s
    else
      ensure_kubeconfig
    fi
    ensure_and_wait_pods
    start_forwards
    start_backend
    start_frontend
    show_summary
    ;;

  stop)
    log_header "Stopping KubeVision AI Environment (Reverse Teardown)"
    stop_frontend
    stop_backend
    stop_forwards
    stop_pods
    if [ "$KEEP_K3S" = false ]; then
      stop_k3s
    else
      log_info "Keeping k3s service running (--keep-k3s specified)."
    fi

    echo ""
    echo -e "${BOLD}${GREEN}================================================================================${NC}"
    echo -e "${BOLD}${GREEN}  Teardown Complete: Backend, UI, port-forwards, pods$( [ "$KEEP_K3S" = false ] && echo " & k3s" ) stopped.${NC}"
    echo -e "${BOLD}${GREEN}================================================================================${NC}"
    ;;

  restart)
    log_info "Restarting KubeVision environment..."
    "$0" stop "$@"
    sleep 2
    "$0" start "$@"
    ;;

  status)
    show_status
    ;;
esac
