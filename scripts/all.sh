#!/usr/bin/env bash
# ==============================================================================
# KubeVision AI — Lifecycle Controller (single entry point)
#
# Owns the full local environment:
#   1. k3s service & cluster readiness
#   2. Observability stack (monitoring) + demo app (boutique) lifecycle
#   3. Port-forwards (Prometheus 9090, Loki 3100, Tempo 3200, Demo 8080)
#   4. Go backend API (:8090, or $PORT)
#   5. Frontend UI (built assets served by the backend, or Vite :5173 with --dev)
#
# It also owns the in-cluster stack operations that used to live in stack.sh and
# cleanup-monitoring.sh, so there is one script to reason about:
#
# Usage:
#   ./scripts/all.sh                     # start everything
#   ./scripts/all.sh --dev               # start with Vite hot-reload (:5173)
#   ./scripts/all.sh stop                # stop host processes, then k3s
#   ./scripts/all.sh stop --keep-k3s     # stop host processes only
#   ./scripts/all.sh restart             # stop then start (safe, no recursion)
#   ./scripts/all.sh status              # health of k3s, pods, forwards, backend, UI
#
#   ./scripts/all.sh stack pause         # free RAM (WARNING: discards Prometheus/Tempo history)
#   ./scripts/all.sh stack resume        # restore stores + DaemonSets
#   ./scripts/all.sh stack status        # pods/daemonsets/statefulsets in ns/monitoring
#   ./scripts/all.sh stack disk          # disk usage + retention settings
#   ./scripts/all.sh stack nuke          # delete Prometheus/Tempo pods (wipes emptyDir)
#   ./scripts/all.sh stack nuke-loki     # wipe the Loki PVC (fresh PVC on restart)
#   ./scripts/all.sh purge --yes         # total purge: ns/monitoring, PVCs, node disk
#
# Options:
#   --dev              Vite dev server (:5173) instead of the built UI
#   --rebuild          Force rebuild of the Go backend and React bundle
#   --keep-k3s         Do not stop k3s (start: assume it is already running)
#   --skip-demo        Do not wait for / port-forward the boutique demo app
#   --foreground       Run the backend in the foreground (interactive debugging)
#   --pause-stack      With stop --keep-k3s: also pause in-cluster stores (data loss!)
#   --yes, -y, --force Skip purge confirmation (required on non-interactive stdin)
#   -h, --help         Show this help
# ==============================================================================
set -euo pipefail

# Always run from the repository root
cd "$(dirname "$0")/.."

# --- Configuration & Paths ----------------------------------------------------
RUN_DIR=".run"
mkdir -p "$RUN_DIR"

export PATH="${PATH:+$PATH:}/usr/local/bin:/usr/bin:/bin"

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

backend_port() { echo "${PORT:-8090}"; }

# --- k3s Service Management ---------------------------------------------------

ensure_kubeconfig() {
  local k3s_cfg="/etc/rancher/k3s/k3s.yaml"
  local user_cfg="$HOME/.kube/config"

  if [ ! -f "$k3s_cfg" ]; then
    return 0
  fi

  mkdir -p "$HOME/.kube"
  chmod 700 "$HOME/.kube" 2>/dev/null || true

  # Never silently destroy an existing kubeconfig (EKS/GKE/lab contexts).
  if [ -f "$user_cfg" ] && ! diff -q <(run_sudo cat "$k3s_cfg") "$user_cfg" >/dev/null 2>&1; then
    local backup="$user_cfg.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$user_cfg" "$backup" 2>/dev/null || true
    log_warn "Existing kubeconfig differs; backed up to $backup"
  fi

  log_info "Synchronizing $user_cfg with $k3s_cfg..."
  check_sudo
  local tmp
  tmp="$(mktemp)"
  if ! run_sudo cat "$k3s_cfg" > "$tmp"; then
    rm -f "$tmp"
    log_error "Could not read $k3s_cfg; leaving $user_cfg untouched."
    exit 1
  fi
  install -m 600 "$tmp" "$user_cfg"
  rm -f "$tmp"
  run_sudo chown "$(id -u):$(id -g)" "$user_cfg" 2>/dev/null || true
  export KUBECONFIG="$user_cfg"
}

start_k3s() {
  log_header "Step 1/5: Starting k3s Kubernetes Cluster"

  if ! command -v k3s >/dev/null 2>&1; then
    log_error "k3s binary not found. Run ./scripts/setup.sh first."
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

  # containerd live-restore can leave shims behind after `systemctl stop k3s`.
  # Prefer k3s's own killall script; fall back to a scoped pattern that only
  # matches Kubernetes containerd shims (never Docker/moby shims).
  if [ -x /usr/local/bin/k3s-killall.sh ]; then
    log_info "Running k3s-killall.sh to terminate lingering containers..."
    check_sudo
    run_sudo /usr/local/bin/k3s-killall.sh >/dev/null 2>&1 || true
  elif run_sudo pkill -0 -f "containerd-shim.*k8s\.io" 2>/dev/null; then
    log_warn "k3s-killall.sh missing; terminating Kubernetes containerd shims only."
    check_sudo
    run_sudo pkill -9 -f "containerd-shim.*k8s\.io" 2>/dev/null || true
  fi
}

# --- In-Cluster Stack Lifecycle (absorbs the old stack.sh) --------------------

STACK_NS="monitoring"
STACK_STS="loki prometheus-prometheus-kube-prometheus-prometheus"
STACK_DEPLOY="tempo prometheus-kube-state-metrics"
STACK_DS="beyla fluent-bit"

stack_reachable() {
  kubectl get ns "$STACK_NS" >/dev/null 2>&1
}

pause_stack() {
  log_header "Pausing In-Cluster Observability Stack"

  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found; nothing to pause."
    return 0
  fi

  # The stores are intentionally emptyDir in the dev configuration. Scaling a
  # StatefulSet/Deployment to 0 deletes its pod, and deleting the pod deletes
  # its emptyDir. This is real data loss, not a sleep.
  log_warn "Prometheus and Tempo use emptyDir in this dev setup."
  log_warn "Pausing DISCARDS their metrics/trace history. Loki (PVC) is unaffected."
  log_warn "Resume with: ./scripts/all.sh stack resume"

  local sts dep
  for sts in $STACK_STS; do
    kubectl -n "$STACK_NS" scale "sts/$sts" --replicas=0 2>/dev/null || log_warn "sts/$sts not found"
  done
  for dep in $STACK_DEPLOY; do
    kubectl -n "$STACK_NS" scale "deploy/$dep" --replicas=0 2>/dev/null || log_warn "deploy/$dep not found"
  done
  log_info "Removing DaemonSets (they cannot scale to 0)..."
  kubectl -n "$STACK_NS" delete ds $STACK_DS --ignore-not-found
  log_success "Stack paused. Host processes were not touched (see dev-up.sh / all.sh stop)."
}

resume_stack() {
  log_header "Resuming In-Cluster Observability Stack"

  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found. Deploy it with ./scripts/setup.sh stack"
    return 0
  fi

  log_info "Re-applying Tempo + Beyla manifests..."
  kubectl apply -f deploy/k8s/collection/tempo-configmap.yaml \
                -f deploy/k8s/collection/tempo-deployment.yaml \
                -f deploy/k8s/collection/tempo-service.yaml
  kubectl apply -f deploy/k8s/collection/beyla-serviceaccount.yaml \
                -f deploy/k8s/collection/beyla-clusterrole.yaml \
                -f deploy/k8s/collection/beyla-clusterrolebinding.yaml \
                -f deploy/k8s/collection/beyla-configmap.yaml \
                -f deploy/k8s/collection/beyla-service.yaml \
                -f deploy/k8s/collection/beyla-servicemonitor.yaml \
                -f deploy/k8s/collection/beyla-daemonset.yaml

  log_info "Scaling stores back up..."
  local sts dep
  for sts in $STACK_STS; do
    kubectl -n "$STACK_NS" scale "sts/$sts" --replicas=1 2>/dev/null || log_warn "sts/$sts not found"
  done
  for dep in $STACK_DEPLOY; do
    kubectl -n "$STACK_NS" scale "deploy/$dep" --replicas=1 2>/dev/null || log_warn "deploy/$dep not found"
  done

  if command -v helm >/dev/null 2>&1; then
    log_info "Re-installing Fluent Bit..."
    helm upgrade --install fluent-bit fluent/fluent-bit \
      --namespace "$STACK_NS" \
      -f deploy/helm/fluent-bit-values.yaml
  fi

  log_info "Waiting for rollouts..."
  kubectl -n "$STACK_NS" rollout status sts/loki --timeout=180s
  kubectl -n "$STACK_NS" rollout status sts/prometheus-prometheus-kube-prometheus-prometheus --timeout=180s
  kubectl -n "$STACK_NS" rollout status deploy/tempo --timeout=180s
  kubectl -n "$STACK_NS" rollout status ds/fluent-bit --timeout=180s || true
  kubectl -n "$STACK_NS" rollout status ds/beyla --timeout=180s
  log_success "Stack resumed."
}

stack_status() {
  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found (or cluster unreachable)."
    return 0
  fi
  kubectl -n "$STACK_NS" get pods,ds,sts,deploy
}

stack_disk() {
  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found (or cluster unreachable)."
    return 0
  fi

  echo "--- Node Disk ---"
  df -h / | tail -1
  echo ""
  echo "--- Persistent Storage (PVCs) ---"
  kubectl -n "$STACK_NS" get pvc 2>/dev/null || echo "No PVCs found"
  echo ""
  echo "--- In-Cluster Resource Consumption (CPU & RAM) ---"
  kubectl -n "$STACK_NS" top pods 2>/dev/null || echo "Metrics unavailable"
  echo ""
  echo "--- Loki PVC on Node (k3s local-path) ---"
  if [ "$(id -u)" -eq 0 ]; then
    du -sh /var/lib/rancher/k3s/storage/pvc-*_monitoring_storage-loki-0-* 2>/dev/null || echo "not found"
  elif sudo -n true 2>/dev/null; then
    sudo -n du -sh /var/lib/rancher/k3s/storage/pvc-*_monitoring_storage-loki-0-* 2>/dev/null || echo "not found"
  else
    echo "(requires sudo to inspect /var/lib/rancher/k3s/storage)"
  fi
  echo ""
  echo "--- Retention Policies Currently Applied ---"
  echo "Prometheus retention:"
  helm -n "$STACK_NS" get values prometheus 2>/dev/null | grep -E "retention" | sed 's/^/  /' || echo "  default retention"
  echo "Loki retention:"
  grep -E "retention_period" deploy/helm/loki-values.yaml | sed 's/^/  /' || echo "  default retention"
  echo "Tempo retention:"
  grep block_retention deploy/k8s/collection/tempo-configmap.yaml | head -1 | sed 's/^/  /' || echo "  default retention"
}

nuke_stores() {
  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found (or cluster unreachable)."
    return 0
  fi
  log_warn "Deleting Prometheus/Tempo pods; their emptyDir data is wiped."
  kubectl -n "$STACK_NS" delete pod -l app.kubernetes.io/name=prometheus --ignore-not-found
  kubectl -n "$STACK_NS" delete pod -l app=tempo --ignore-not-found
  kubectl -n "$STACK_NS" rollout status deploy/tempo --timeout=120s || true
}

nuke_loki() {
  if ! stack_reachable; then
    log_warn "Namespace '$STACK_NS' not found (or cluster unreachable)."
    return 0
  fi
  log_warn "Wiping the Loki PVC; all logs are lost."
  kubectl -n "$STACK_NS" scale sts loki --replicas=0
  kubectl -n "$STACK_NS" wait --for=delete pod/loki-0 --timeout=60s 2>/dev/null || true
  kubectl -n "$STACK_NS" delete pvc storage-loki-0 --ignore-not-found
  kubectl -n "$STACK_NS" scale sts loki --replicas=1
  kubectl -n "$STACK_NS" rollout status sts/loki --timeout=120s
}

purge_stack() {
  log_header "Total Purge: ns/$STACK_NS, PVCs and node disk"

  if [ "$FORCE" = true ]; then
    log_warn "--yes/--force given; skipping confirmation."
  elif [ ! -t 0 ]; then
    log_error "Refusing to purge: stdin is not a TTY and --yes was not passed."
    log_error "Re-run explicitly: ./scripts/all.sh purge --yes"
    exit 1
  else
    echo -e "${YELLOW}${BOLD}WARNING: this permanently deletes:${NC}"
    echo "  - all Prometheus metrics, Loki logs and Tempo traces"
    echo "  - the '$STACK_NS' namespace and every workload in it (Beyla, Fluent Bit, ...)"
    echo "  - all PVCs (storage-loki-0, ...) and the k3s local-path directories on this node"
    echo ""
    read -rp "Are you sure you want to proceed? [y/N]: " confirm
    if [[ ! "$confirm" =~ ^[yY]([eE][sS])?$ ]]; then
      echo "Aborted."
      exit 0
    fi
  fi

  log_info "1/7 Stopping host port-forwards to monitoring stores..."
  stop_forwards

  # Retained for clusters where the retired OTel Operator left webhooks behind
  # (a dangling webhook blocks namespace deletion).
  log_info "2/7 Cleaning up admission webhook configurations..."
  kubectl delete mutatingwebhookconfiguration \
    opentelemetry-operator-mutation \
    prometheus-kube-prometheus-admission \
    --ignore-not-found 2>/dev/null || true
  kubectl delete validatingwebhookconfiguration \
    opentelemetry-operator-validation \
    prometheus-kube-prometheus-admission \
    --ignore-not-found 2>/dev/null || true

  log_info "3/7 Uninstalling Helm releases in ns/$STACK_NS..."
  if command -v helm >/dev/null 2>&1; then
    local releases
    releases="$(helm list -n "$STACK_NS" -q 2>/dev/null || true)"
    if [ -n "$releases" ]; then
      local rel
      for rel in $releases; do
        echo "  Uninstalling Helm release: $rel"
        helm uninstall "$rel" -n "$STACK_NS" --timeout=60s 2>/dev/null || true
      done
    else
      echo "  No Helm releases found in ns/$STACK_NS."
    fi
  fi

  log_info "4/7 Deleting raw collection manifests & RBAC..."
  local f
  for f in deploy/k8s/collection/beyla-*.yaml deploy/k8s/collection/tempo-*.yaml; do
    kubectl delete -f "$f" --ignore-not-found 2>/dev/null || true
  done
  kubectl delete clusterrole beyla --ignore-not-found 2>/dev/null || true
  kubectl delete clusterrolebinding beyla --ignore-not-found 2>/dev/null || true

  log_info "5/7 Deleting all PVCs in ns/$STACK_NS..."
  if kubectl get ns "$STACK_NS" >/dev/null 2>&1; then
    local pvcs pvc
    pvcs="$(kubectl -n "$STACK_NS" get pvc -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)"
    for pvc in $pvcs; do
      echo "  Removing finalizers and deleting PVC: $pvc"
      kubectl -n "$STACK_NS" patch pvc "$pvc" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
      kubectl -n "$STACK_NS" delete pvc "$pvc" --ignore-not-found 2>/dev/null || true
    done
  fi

  log_info "6/7 Deleting namespace '$STACK_NS'..."
  if kubectl get ns "$STACK_NS" >/dev/null 2>&1; then
    kubectl delete namespace "$STACK_NS" --ignore-not-found --timeout=60s 2>/dev/null || true
    if kubectl get ns "$STACK_NS" >/dev/null 2>&1; then
      log_warn "Namespace still finalizing; stripping namespace finalizers."
      kubectl get namespace "$STACK_NS" -o json 2>/dev/null \
        | jq '.spec.finalizers = []' 2>/dev/null \
        | kubectl replace --raw "/api/v1/namespaces/$STACK_NS/finalize" -f - >/dev/null 2>&1 || true
      sleep 2
    fi
  fi

  log_info "7/7 Reclaiming node disk storage (k3s local-path)..."
  if [ "$(id -u)" -eq 0 ]; then
    rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_* 2>/dev/null || true
  elif sudo -n true 2>/dev/null; then
    sudo bash -c 'rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_*' || true
  else
    log_warn "Not purging host storage (sudo unavailable). Run manually:"
    echo "    sudo rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_*"
  fi

  echo ""
  log_success "Purge complete. Reinstall with: ./scripts/setup.sh stack"
  kubectl get pvc -A 2>/dev/null || true
  df -h / | tail -1
}

# --- Workload Pods ------------------------------------------------------------

stack_replicas_paused() {
  local tempo loki prom
  tempo="$(kubectl -n "$STACK_NS" get deploy tempo -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
  loki="$(kubectl -n "$STACK_NS" get sts loki -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
  prom="$(kubectl -n "$STACK_NS" get sts prometheus-prometheus-kube-prometheus-prometheus -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
  [ "${tempo:-1}" -eq 0 ] || [ "${loki:-1}" -eq 0 ] || [ "${prom:-1}" -eq 0 ]
}

ensure_and_wait_pods() {
  log_header "Step 2/5: Verifying & Waiting for All Pods"

  if stack_reachable; then
    if stack_replicas_paused; then
      log_info "Monitoring stack is paused (replicas=0). Resuming..."
      resume_stack
    fi

    log_info "Waiting for monitoring pods to be Ready..."
    kubectl -n "$STACK_NS" rollout status deploy/tempo --timeout=120s
    kubectl -n "$STACK_NS" rollout status sts/loki --timeout=180s
    kubectl -n "$STACK_NS" rollout status sts/prometheus-prometheus-kube-prometheus-prometheus --timeout=180s
    kubectl -n "$STACK_NS" get ds fluent-bit >/dev/null 2>&1 && \
      kubectl -n "$STACK_NS" rollout status ds/fluent-bit --timeout=120s || true
    kubectl -n "$STACK_NS" get ds beyla >/dev/null 2>&1 && \
      kubectl -n "$STACK_NS" rollout status ds/beyla --timeout=120s || true
    log_success "Monitoring stack is ready."
  else
    log_warn "Namespace 'monitoring' not found. Run ./scripts/setup.sh stack to deploy it."
  fi

  if [ "$SKIP_DEMO" = false ] && kubectl get namespace boutique >/dev/null 2>&1; then
    log_info "Checking demo app workloads (ns/boutique)..."
    local frontend_replicas
    frontend_replicas="$(kubectl -n boutique get deploy frontend -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
    if [ "${frontend_replicas:-1}" -eq 0 ]; then
      log_info "Demo app is scaled to 0. Rescaling boutique deployments to 1..."
      kubectl -n boutique scale deploy --all --replicas=1
    fi
    kubectl -n boutique rollout status deploy/frontend --timeout=120s 2>/dev/null || true
    log_success "Demo app pods are active."
  fi

  echo ""
  log_info "Workload pods summary:"
  kubectl get pods -A --field-selector=metadata.namespace!=kube-system --no-headers 2>/dev/null | \
    awk '{printf "  [%-12s] %-52s %s\n", $1, $2, $4}' || true
}

prepare_stop() {
  if [ "$KEEP_K3S" = true ]; then
    log_info "Keeping k3s and the in-cluster stack running (--keep-k3s)."
    if [ "$PAUSE_STACK" = true ]; then
      pause_stack
    else
      log_info "To free RAM manually: ./scripts/all.sh stack pause (discards Prometheus/Tempo history)."
    fi
  fi
}

# --- Port-Forward Management --------------------------------------------------

stop_forwards() {
  log_info "Stopping port-forwards..."
  local pidfile pid
  for pidfile in "$RUN_DIR"/port-forward-*.pid; do
    [ -f "$pidfile" ] || continue
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done

  # Only the ports this project forwards; never touch unrelated kubectl calls.
  pkill -f "kubectl.*port-forward.*(9090|3100|3200|8080)" 2>/dev/null || true
  sleep 1
}

start_forwards() {
  log_header "Step 3/5: Establishing Port-Forwards"

  stop_forwards

  local forwards=(
    "monitoring:svc/prometheus-kube-prometheus-prometheus:9090:9090:Prometheus"
    "monitoring:svc/loki-gateway:3100:80:Loki"
    "monitoring:svc/tempo:3200:3200:Tempo"
  )

  if [ "$SKIP_DEMO" = false ] && kubectl -n boutique get svc frontend >/dev/null 2>&1; then
    forwards+=("boutique:svc/frontend:8080:80:Boutique Demo")
  fi

  local item ns svc lport rport label
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

  local port ready
  for port in "${required_ports[@]}"; do
    ready=false
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
      log_warn "Port :$port did not respond yet; check $RUN_DIR/port-forward-$port.log."
    fi
  done
}

# --- Backend ------------------------------------------------------------------

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
    kill "$pid" 2>/dev/null || true  # SIGTERM: flush BadgerDB, release the lock
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
    log_info "Backend was not running (no live PID file)."
  fi
  rm -f "$RUN_DIR/backend.pid"
}

start_backend() {
  log_header "Step 4/5: Starting Go Backend"

  stop_backend

  if [ ! -x bin/kubevision-backend ] || [ "$REBUILD" = true ]; then
    build_backend
  fi

  local port db_path
  port="$(backend_port)"
  db_path="${DB_PATH:-./data/kubevision-dev}"

  local env_args=(
    PORT="$port"
    DB_PATH="$db_path"
    PROMETHEUS_URL="http://localhost:9090"
    LOKI_URL="http://localhost:3100"
    TEMPO_URL="http://localhost:3200"
    OBSERVED_NAMESPACE="${OBSERVED_NAMESPACE:-boutique}"
    KUBEVISION_MODE=development
    CORS_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
    FRONTEND_DIR="${FRONTEND_DIR:-frontend/dist}"
  )

  if [ "$FOREGROUND" = true ]; then
    log_info "Starting backend on :$port in foreground..."
    exec env "${env_args[@]}" ./bin/kubevision-backend
  fi

  log_info "Starting backend on :$port (logs: $RUN_DIR/backend.log)..."
  env "${env_args[@]}" nohup ./bin/kubevision-backend > "$RUN_DIR/backend.log" 2>&1 &
  echo $! > "$RUN_DIR/backend.pid"

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

# --- Frontend -----------------------------------------------------------------

stop_frontend() {
  log_info "Stopping frontend dev server..."
  local pid=""
  [ -f "$RUN_DIR/frontend.pid" ] && pid="$(cat "$RUN_DIR/frontend.pid" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    log_success "Frontend dev server stopped."
  else
    log_info "Frontend dev server was not running."
  fi
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

  local port
  port="$(backend_port)"

  if [ "$DEV_MODE" = true ]; then
    stop_frontend

    if [ ! -d frontend/node_modules ]; then
      log_info "Installing frontend dependencies..."
      npm --prefix frontend install
    fi

    log_info "Starting Vite dev server on :5173 (logs: $RUN_DIR/frontend.log)..."
    VITE_API_TARGET="http://localhost:$port" nohup npm --prefix frontend run dev \
      > "$RUN_DIR/frontend.log" 2>&1 &
    echo $! > "$RUN_DIR/frontend.pid"

    sleep 2
    local ui_port="5173"
    probe_port 5174 && ui_port="5174"
    log_success "Vite dev server running on http://localhost:$ui_port (hot reload)."
  else
    if [ ! -f frontend/dist/index.html ] || [ "$REBUILD" = true ]; then
      build_frontend
    fi
    log_success "Frontend assets ready in frontend/dist (served by the backend on :$port)."
  fi
}

# --- Status & Reporting -------------------------------------------------------

show_status() {
  log_header "KubeVision AI — System Status"

  local api_port
  api_port="$(backend_port)"

  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet k3s; then
    echo -e "  k3s Service:     ${GREEN}ACTIVE${NC}"
  else
    echo -e "  k3s Service:     ${RED}INACTIVE${NC}"
  fi

  if kubectl get nodes >/dev/null 2>&1; then
    local node_status
    node_status="$(kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}' | head -1)"
    echo -e "  Cluster Node:    ${GREEN}$node_status${NC}"
  else
    echo -e "  Cluster Node:    ${RED}UNREACHABLE${NC}"
  fi

  if curl -sf -m 2 "localhost:$api_port/api/v1/health" >/dev/null 2>&1; then
    echo -e "  Backend API:     ${GREEN}HEALTHY${NC} (http://localhost:$api_port)"
  else
    echo -e "  Backend API:     ${RED}DOWN${NC} (http://localhost:$api_port)"
  fi

  if probe_port 5173 || probe_port 5174; then
    local vport="5173"
    probe_port 5174 && vport="5174"
    echo -e "  Frontend Dev:    ${GREEN}RUNNING${NC} (http://localhost:$vport)"
  else
    echo -e "  Frontend Dev:    ${YELLOW}NOT RUNNING${NC} (using built UI on :$api_port)"
  fi

  if stack_reachable; then
    local ready total
    ready="$(kubectl -n "$STACK_NS" get pods --no-headers 2>/dev/null | awk '$2 ~ /^[0-9]+\/[0-9]+$/ && $3=="Running" {split($2,a,"/"); if (a[1]==a[2]) c++} END {print c+0}')"
    total="$(kubectl -n "$STACK_NS" get pods --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    echo -e "  Monitoring:      ${GREEN}${ready}/${total} pods Ready${NC}"
  else
    echo -e "  Monitoring:      ${RED}NOT DEPLOYED${NC}"
  fi

  echo ""
  echo "  Port-Forwards:"
  local port_info port label
  for port_info in "9090:Prometheus" "3100:Loki" "3200:Tempo"; do
    IFS=: read -r port label <<< "$port_info"
    if probe_port "$port"; then
      echo -e "    - :$port ($label): ${GREEN}UP${NC}"
    else
      echo -e "    - :$port ($label): ${RED}DOWN${NC}"
    fi
  done
  if [ "$SKIP_DEMO" = false ] && kubectl -n boutique get svc frontend >/dev/null 2>&1; then
    if probe_port 8080; then
      echo -e "    - :8080 (Boutique Demo): ${GREEN}UP${NC}"
    else
      echo -e "    - :8080 (Boutique Demo): ${RED}DOWN${NC}"
    fi
  fi

  echo ""
  echo "  Kubernetes Workload Pods:"
  kubectl get pods -A --field-selector=metadata.namespace!=kube-system --no-headers 2>/dev/null | \
    awk '{printf "    %-14s %-48s %s\n", $1, $2, $4}' || echo "    (Cluster unreachable)"
}

show_summary() {
  local ui_url="http://localhost:$(backend_port)"
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
  echo -e "  ${BOLD}Backend API:${NC}       http://localhost:$(backend_port)/api/v1/health"
  echo -e "  ${BOLD}Prometheus:${NC}        http://localhost:9090"
  echo -e "  ${BOLD}Loki Gateway:${NC}      http://localhost:3100"
  echo -e "  ${BOLD}Tempo Traces:${NC}      http://localhost:3200"
  if probe_port 8080; then
    echo -e "  ${BOLD}Demo Storefront:${NC}   http://localhost:8080"
  fi
  echo ""
  echo -e "  Stop everything:        ${BOLD}./scripts/all.sh stop${NC}"
  echo -e "  Free RAM (data loss):   ${BOLD}./scripts/all.sh stack pause${NC}"
  echo -e "${BOLD}${GREEN}================================================================================${NC}"
}

show_help() {
  cat << EOF
Usage: $0 [ACTION|COMMAND] [OPTIONS]

Actions:
  (none) | start | up   Start k3s, wait for pods, forwards, backend & UI (default)
  stop | down           Stop host processes, then k3s (use --keep-k3s to keep cluster)
  restart               Stop then start (no recursion)
  status                Status of k3s, pods, port-forwards, backend, and frontend

Stack commands (in-cluster, ns/monitoring):
  stack pause           Scale stores to 0 and remove DaemonSets to free RAM
                        WARNING: Prometheus/Tempo use emptyDir; history is discarded
  stack resume          Scale stores up and restore DaemonSets
  stack status          Show pods, DaemonSets and StatefulSets in monitoring
  stack disk            Disk usage, PVCs and retention settings
  stack nuke            Delete Prometheus/Tempo pods (wipes their emptyDir)
  stack nuke-loki       Wipe the Loki PVC (fresh PVC on restart)

  purge                 Total purge: namespace, all PVCs and node disk storage
                        Requires confirmation; non-interactive runs need --yes

Options:
  --dev               Run Vite dev server (:5173) with hot reload
  --rebuild           Force rebuild Go backend and React frontend
  --keep-k3s          On stop: keep k3s running (stop host processes only)
                      On start: assume k3s is already running
  --skip-demo         Do not wait for or port-forward the boutique demo app
  --foreground        Run backend in foreground (interactive debugging)
  --pause-stack       With stop --keep-k3s: also pause stores (data loss!)
  --yes, -y, --force  Skip purge confirmation (required when stdin is not a TTY)
  -h, --help          Show this help message
EOF
}

# --- Argument Parsing ---------------------------------------------------------
ACTION="start"
SUBCMD=""
DEV_MODE=false
REBUILD=false
KEEP_K3S=false
SKIP_DEMO=false
FOREGROUND=false
PAUSE_STACK=false
FORCE=false
EXPECT_SUB=false

for arg in "$@"; do
  if [ "$EXPECT_SUB" = true ]; then
    if [[ "$arg" != -* ]]; then
      SUBCMD="$arg"
      EXPECT_SUB=false
      continue
    fi
    # A flag right after `stack` means no subcommand was given; parse normally.
    EXPECT_SUB=false
  fi
  case "$arg" in
    start|up) ACTION="start" ;;
    stop|down|reverse) ACTION="stop" ;;
    restart) ACTION="restart" ;;
    status) ACTION="status" ;;
    stack) ACTION="stack"; EXPECT_SUB=true ;;
    purge) ACTION="purge" ;;
    --dev) DEV_MODE=true ;;
    --rebuild) REBUILD=true ;;
    --keep-k3s|--no-k3s) KEEP_K3S=true ;;
    --skip-demo) SKIP_DEMO=true ;;
    --foreground) FOREGROUND=true ;;
    --pause-stack) PAUSE_STACK=true ;;
    -y|--yes|--force) FORCE=true ;;
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

if [ "$ACTION" = "stack" ] && [ -z "$SUBCMD" ]; then
  SUBCMD="status"
fi

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
    log_header "Stopping KubeVision AI Environment"
    stop_frontend
    stop_backend
    stop_forwards
    prepare_stop
    if [ "$KEEP_K3S" = false ]; then
      stop_k3s
    else
      log_info "Keeping k3s service running (--keep-k3s)."
    fi

    echo ""
    echo -e "${BOLD}${GREEN}================================================================================${NC}"
    echo -e "${BOLD}${GREEN}  Teardown complete: host processes and $( [ "$KEEP_K3S" = false ] && echo "k3s" || echo "in-cluster stack left running" ).${NC}"
    echo -e "${BOLD}${GREEN}================================================================================${NC}"
    ;;

  restart)
    log_info "Restarting KubeVision environment (stop, then start)..."
    flags=()
    [ "$DEV_MODE" = true ] && flags+=(--dev)
    [ "$REBUILD" = true ] && flags+=(--rebuild)
    [ "$KEEP_K3S" = true ] && flags+=(--keep-k3s)
    [ "$SKIP_DEMO" = true ] && flags+=(--skip-demo)
    [ "$FOREGROUND" = true ] && flags+=(--foreground)
    "$0" stop "${flags[@]}"
    sleep 2
    "$0" start "${flags[@]}"
    ;;

  status)
    show_status
    ;;

  stack)
    case "$SUBCMD" in
      pause|stop) pause_stack ;;
      resume|start) resume_stack ;;
      status) stack_status ;;
      disk|cleanup) stack_disk ;;
      nuke) nuke_stores ;;
      nuke-loki) nuke_loki ;;
      *)
        log_error "Unknown stack command: $SUBCMD"
        show_help
        exit 1
        ;;
    esac
    ;;

  purge)
    purge_stack
    ;;

  *)
    log_error "Unknown action: $ACTION"
    show_help
    exit 1
    ;;
esac
