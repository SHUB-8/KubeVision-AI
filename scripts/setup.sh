#!/usr/bin/env bash
# ==============================================================================
# KubeVision AI — One-time Setup (cluster + observability stack)
#
# Merges the old setup-phase1.sh and setup-phase2.sh into a single script.
#
# Usage:
#   ./scripts/setup.sh                    # cluster prerequisites + k3s + stack (default)
#   ./scripts/setup.sh cluster            # only the k3s cluster bootstrap
#   ./scripts/setup.sh stack              # only the observability stack (Prometheus/Loki/Tempo/OBI/Fluent Bit)
#   ./scripts/setup.sh --with-demo        # setup everything, then install the boutique demo app
#
# Cluster target:
#   - Verifies kernel/eBPF/BTF/debugfs/Secure Boot prerequisites (Linux & WSL2)
#   - Installs (or starts) single-node k3s and configures kubeconfig safely
#   - Skips cleanly if you already have a Kubernetes cluster (use `stack` only)
#
# Stack target:
#   - kube-prometheus-stack, Loki, Fluent Bit (Helm) + Tempo and OBI (raw manifests)
#   - eBPF-only collection: no SDK injection, no sidecars, observed apps never modified
#
# Reproducibility: chart versions are unpinned by default (matching the old
# behaviour) but can be pinned explicitly:
#   K3S_VERSION=v1.37.2+k3s1
#   CHART_KUBE_PROMETHEUS_VERSION=93.2.0
#   CHART_LOKI_VERSION=7.6.0
#   CHART_FLUENT_BIT_VERSION=0.58.3
#
# Idempotent: safe to run multiple times without disrupting existing state.
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# ANSI color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

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

require_bin() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log_error "$1 is required but not installed."
    exit 1
  fi
}

# --- Cluster bootstrap (old setup-phase1.sh) ----------------------------------

detect_environment() {
  OS="$(uname -s)"
  if [ "$OS" != "Linux" ]; then
    log_error "This script is designed for Linux and Windows (via WSL2)."
    log_error "Detected OS: $OS"
    log_error "For macOS, use a Linux VM (OrbStack, Colima, or Lima) or k3d with Docker."
    exit 1
  fi

  IS_WSL=false
  if grep -qi "microsoft" /proc/version 2>/dev/null || [ -n "${WSL_DISTRO_NAME:-}" ]; then
    IS_WSL=true
    log_info "Environment: ${BOLD}Windows Subsystem for Linux (WSL2)${NC}"
  else
    log_info "Environment: ${BOLD}Native Linux ($OS)${NC}"
  fi
}

check_prerequisites() {
  log_info "--- Checking system prerequisites for KubeVision (eBPF) ---"

  KERNEL_VER="$(uname -r)"
  log_info "Kernel version: ${BOLD}$KERNEL_VER${NC}"

  KERNEL_MAJOR="$(echo "$KERNEL_VER" | cut -d. -f1)"
  KERNEL_MINOR="$(echo "$KERNEL_VER" | cut -d. -f2)"
  if [ "$KERNEL_MAJOR" -lt 5 ] || { [ "$KERNEL_MAJOR" -eq 5 ] && [ "$KERNEL_MINOR" -lt 4 ]; }; then
    log_warn "Kernel is older than 5.4. OBI/eBPF works best on modern kernels (>= 5.8)."
  else
    log_success "Kernel version satisfies eBPF requirements."
  fi

  if [ -d "/sys/fs/bpf" ]; then
    log_success "eBPF filesystem (/sys/fs/bpf) is mounted."
  else
    log_warn "eBPF filesystem (/sys/fs/bpf) not detected. The OBI DaemonSet will mount it dynamically."
  fi

  if run_sudo test -d "/sys/kernel/debug/tracing" 2>/dev/null; then
    log_success "Kernel tracing (/sys/kernel/debug/tracing) is accessible."
  else
    run_sudo mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null || true
    if run_sudo test -d "/sys/kernel/debug/tracing" 2>/dev/null; then
      log_success "Mounted debugfs at /sys/kernel/debug."
    else
      log_warn "debugfs could not be mounted. Tracepoint probes may require manual setup."
    fi
  fi

  if [ -f "/sys/kernel/btf/vmlinux" ]; then
    log_success "BTF (BPF Type Format) available at /sys/kernel/btf/vmlinux."
  elif zcat /proc/config.gz 2>/dev/null | grep -q "CONFIG_DEBUG_INFO_BTF=y"; then
    log_success "Kernel compiled with CONFIG_DEBUG_INFO_BTF=y."
  else
    log_info "BTF not detected in sysfs; OBI will use runtime probe fallbacks."
  fi

  if [ -f /sys/firmware/efi/efivars ] && command -v mokutil >/dev/null 2>&1; then
    if mokutil --sb-state 2>/dev/null | grep -qi "enabled"; then
      log_warn "Secure Boot is enabled. eBPF programs may require signed modules."
    else
      log_success "Secure Boot is not blocking eBPF."
    fi
  else
    log_success "Secure Boot is disabled or not present."
  fi
}

apply_platform_tweaks() {
  if [ "$IS_WSL" = true ]; then
    log_info "Applying WSL2 compatibility configurations..."

    if grep -q "Program Files" /proc/mounts 2>/dev/null; then
      log_info "Unmounting Docker Desktop host mount (/Docker/host) to prevent kubelet cAdvisor crashes..."
      run_sudo umount /Docker/host 2>/dev/null || true
    fi

    if [ -d /etc/systemd/system ]; then
      run_sudo mkdir -p /etc/systemd/system/k3s.service.d
      cat << 'EOF' | run_sudo tee /etc/systemd/system/k3s.service.d/docker-mount-fix.conf >/dev/null
[Service]
ExecStartPre=-/bin/umount /Docker/host
EOF
    fi
  fi
}

configure_k3s() {
  log_info "Verifying k3s server configuration at /etc/rancher/k3s/config.yaml..."
  run_sudo mkdir -p /etc/rancher/k3s

  CONFIG_FILE="/etc/rancher/k3s/config.yaml"
  NODE_IP=""
  if [ "$IS_WSL" = true ]; then
    NODE_IP="$(ip addr show eth0 2>/dev/null | awk '/inet / {sub("/.*", "", $2); print $2}' || true)"
  fi

  if [ ! -f "$CONFIG_FILE" ]; then
    cat << EOF | run_sudo tee "$CONFIG_FILE" >/dev/null
# KubeVision dev cluster configuration
write-kubeconfig-mode: "0644"
disable:
  - traefik
  - servicelb
kubelet-arg:
  - "fail-cgroupv1=false"
tls-san:
  - "127.0.0.1"
  - "localhost"
EOF
    if [ -n "$NODE_IP" ]; then
      echo "  - \"$NODE_IP\"" | run_sudo tee -a "$CONFIG_FILE" >/dev/null
    fi
    log_success "Created /etc/rancher/k3s/config.yaml."
  else
    if ! grep -q "fail-cgroupv1" "$CONFIG_FILE" 2>/dev/null; then
      log_info "Adding fail-cgroupv1=false to /etc/rancher/k3s/config.yaml..."
      if ! grep -q "kubelet-arg:" "$CONFIG_FILE" 2>/dev/null; then
        echo -e 'kubelet-arg:\n  - "fail-cgroupv1=false"' | run_sudo tee -a "$CONFIG_FILE" >/dev/null
      else
        run_sudo sed -i '/kubelet-arg:/a \ \ - "fail-cgroupv1=false"' "$CONFIG_FILE"
      fi
    fi

    if [ -n "$NODE_IP" ] && ! grep -q "$NODE_IP" "$CONFIG_FILE" 2>/dev/null; then
      if ! grep -q "tls-san:" "$CONFIG_FILE" 2>/dev/null; then
        echo -e "tls-san:\n  - \"127.0.0.1\"\n  - \"localhost\"\n  - \"$NODE_IP\"" | run_sudo tee -a "$CONFIG_FILE" >/dev/null
      else
        run_sudo sed -i "/tls-san:/a \ \ - \"$NODE_IP\"" "$CONFIG_FILE"
      fi
    fi
    log_success "k3s configuration verified."
  fi
}

install_or_start_k3s() {
  if ! command -v k3s >/dev/null 2>&1; then
    log_info "Installing k3s server..."
    if [ -n "${K3S_VERSION:-}" ]; then
      log_info "Pinned k3s version: $K3S_VERSION"
      curl -sfL https://get.k3s.io | \
        run_sudo env INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - server \
          --write-kubeconfig-mode 644 \
          --disable traefik \
          --disable servicelb
    else
      log_warn "K3S_VERSION is not set; installing the latest k3s release."
      curl -sfL https://get.k3s.io | run_sudo sh -s - server \
        --write-kubeconfig-mode 644 \
        --disable traefik \
        --disable servicelb
    fi
    log_success "k3s installation complete."
  else
    log_info "k3s binary is already installed."
    if command -v systemctl >/dev/null 2>&1; then
      if ! systemctl is-active --quiet k3s; then
        log_info "k3s service is inactive. Starting..."
        run_sudo systemctl daemon-reload
        run_sudo systemctl restart k3s
      else
        log_success "k3s service is active and running."
      fi
    fi
  fi

  if ! command -v kubectl >/dev/null 2>&1 && [ -f /usr/local/bin/k3s ]; then
    log_info "Creating /usr/local/bin/kubectl symlink to k3s..."
    run_sudo ln -sf /usr/local/bin/k3s /usr/local/bin/kubectl
  fi

  if ! command -v helm >/dev/null 2>&1 && [ -f /snap/bin/helm ]; then
    run_sudo ln -sf /snap/bin/helm /usr/local/bin/helm
  fi
}

sync_windows_kubeconfig() {
  local win_kube_dir=""
  if [ -d "/mnt/c/Users" ]; then
    for udir in /mnt/c/Users/*; do
      local base
      base="$(basename "$udir")"
      case "$base" in
        "All Users"|"Default"|"Default User"|"Public"|"desktop.ini") continue ;;
      esac
      if [ -d "$udir/.kube" ]; then
        win_kube_dir="$udir/.kube"
        break
      fi
    done
  fi

  if [ -n "$win_kube_dir" ] && [ -w "$win_kube_dir" ]; then
    local node_ip
    node_ip="$(ip addr show eth0 2>/dev/null | awk '/inet / {sub("/.*", "", $2); print $2}' || true)"
    if [ -n "$node_ip" ]; then
      local win_k3s_cfg="$win_kube_dir/k3s.yaml"
      sed -e "s|https://127.0.0.1:6443|https://${node_ip}:6443|g" \
          -e 's|name: default|name: k3s|g' \
          -e 's|cluster: default|cluster: k3s|g' \
          -e 's|user: default|user: k3s|g' \
          -e 's|current-context: default|current-context: k3s|g' \
          /etc/rancher/k3s/k3s.yaml > "$win_k3s_cfg" 2>/dev/null || true

      if [ -f "$win_k3s_cfg" ]; then
        log_success "Synced Windows host kubeconfig to $win_k3s_cfg"
      fi
    fi
  fi
}

setup_kubeconfig() {
  log_info "Making cluster credentials available to kubectl/helm..."

  if [ ! -f /etc/rancher/k3s/k3s.yaml ]; then
    log_warn "Waiting for /etc/rancher/k3s/k3s.yaml to be generated..."
    sleep 3
  fi

  mkdir -p "$HOME/.kube"
  chmod 700 "$HOME/.kube" 2>/dev/null || true

  # Back up any existing kubeconfig before replacing it. The old condition
  # almost never fired for a normal kubeconfig, so contexts were lost silently.
  if [ -f "$HOME/.kube/config" ] && \
     ! diff -q <(run_sudo cat /etc/rancher/k3s/k3s.yaml 2>/dev/null) "$HOME/.kube/config" >/dev/null 2>&1; then
    local backup="$HOME/.kube/config.bak.$(date +%Y%m%d%H%M%S)"
    cp -p "$HOME/.kube/config" "$backup" 2>/dev/null || true
    log_warn "Existing kubeconfig backed up to $backup"
  fi

  local tmp
  tmp="$(mktemp)"
  if ! run_sudo cat /etc/rancher/k3s/k3s.yaml > "$tmp"; then
    rm -f "$tmp"
    log_error "Could not read /etc/rancher/k3s/k3s.yaml; leaving $HOME/.kube/config untouched."
    exit 1
  fi
  install -m 600 "$tmp" "$HOME/.kube/config"
  rm -f "$tmp"
  run_sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config" 2>/dev/null || true
  export KUBECONFIG="$HOME/.kube/config"
  log_success "Configured $HOME/.kube/config."

  if [ "$IS_WSL" = true ]; then
    sync_windows_kubeconfig
  fi
}

wait_for_cluster() {
  log_info "Waiting for cluster node to become Ready (timeout: 120s)..."
  if ! kubectl wait --for=condition=Ready node --all --timeout=120s; then
    log_error "Cluster node did not transition to Ready."
    kubectl get nodes
    exit 1
  fi

  log_success "Cluster node is Ready."
  echo ""
  kubectl get nodes -o wide
}

# --- Observability stack (old setup-phase2.sh) --------------------------------

helm_with_version() {
  # helm_with_version <version-var-value> args...
  local version="$1"; shift
  if [ -n "$version" ]; then
    helm "$@" --version "$version"
  else
    helm "$@"
  fi
}

cleanup_legacy_beyla() {
  # The collector shipped under the name "beyla" until the OBI rename. OBI is a
  # different binary, so applying the OBI manifests does NOT replace the legacy
  # DaemonSet: both would run (double eBPF collection, competing BPF maps).
  # Remove the legacy objects once, idempotently, while they still exist.
  local ns="${1:-monitoring}"
  kubectl -n "$ns" get ds beyla >/dev/null 2>&1 || return 0
  log_warn "Legacy 'beyla' collector found in ns/$ns; removing it (superseded by 'obi')."
  kubectl -n "$ns" delete ds beyla --ignore-not-found 2>/dev/null || true
  kubectl -n "$ns" delete svc beyla --ignore-not-found 2>/dev/null || true
  kubectl -n "$ns" delete cm beyla-config --ignore-not-found 2>/dev/null || true
  kubectl -n "$ns" delete sa beyla --ignore-not-found 2>/dev/null || true
  kubectl -n "$ns" delete servicemonitor beyla --ignore-not-found 2>/dev/null || true
  kubectl delete clusterrole beyla --ignore-not-found 2>/dev/null || true
  kubectl delete clusterrolebinding beyla --ignore-not-found 2>/dev/null || true
}

install_observability_stack() {
  log_info "=== Deploying KubeVision Observability Stack ==="

  require_bin kubectl
  require_bin helm

  log_info "Creating monitoring namespace..."
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

  log_info "Adding and updating Helm repositories..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo add grafana https://grafana.github.io/helm-charts
  helm repo add fluent https://fluent.github.io/helm-charts
  helm repo update

  log_info "Ensuring Prometheus Operator CRDs (server-side apply)..."
  CRD_DIR=$(mktemp -d)
  trap 'rm -rf "$CRD_DIR"' EXIT
  if [ -n "${CHART_KUBE_PROMETHEUS_VERSION:-}" ]; then
    helm pull prometheus-community/kube-prometheus-stack \
      --version "$CHART_KUBE_PROMETHEUS_VERSION" --untar --untardir="$CRD_DIR"
  else
    log_warn "CHART_KUBE_PROMETHEUS_VERSION is not set; CRDs come from the latest chart."
    helm pull prometheus-community/kube-prometheus-stack --untar --untardir="$CRD_DIR"
  fi
  CRD_SRC="$CRD_DIR/kube-prometheus-stack/charts/crds/crds"
  [ -d "$CRD_SRC" ] || CRD_SRC="$CRD_DIR/kube-prometheus-stack/crds"
  kubectl apply --server-side --force-conflicts -f "$CRD_SRC"
  rm -rf "$CRD_DIR"
  trap - EXIT

  log_info "Installing / upgrading kube-prometheus-stack..."
  helm_with_version "${CHART_KUBE_PROMETHEUS_VERSION:-}" upgrade --install prometheus \
    prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    -f deploy/helm/prometheus-values.yaml

  log_info "Installing / upgrading Loki..."
  helm_with_version "${CHART_LOKI_VERSION:-}" upgrade --install loki grafana/loki \
    --namespace monitoring \
    -f deploy/helm/loki-values.yaml

  log_info "Installing / upgrading Fluent Bit (log collection DaemonSet)..."
  helm_with_version "${CHART_FLUENT_BIT_VERSION:-}" upgrade --install fluent-bit fluent/fluent-bit \
    --namespace monitoring \
    -f deploy/helm/fluent-bit-values.yaml

  log_info "Deploying Grafana Tempo (distributed tracing backend)..."
  kubectl apply -f deploy/k8s/collection/tempo-configmap.yaml \
                -f deploy/k8s/collection/tempo-deployment.yaml \
                -f deploy/k8s/collection/tempo-service.yaml

  cleanup_legacy_beyla monitoring

  log_info "Deploying OBI (eBPF telemetry DaemonSet)..."
  kubectl apply -f deploy/k8s/collection/obi-serviceaccount.yaml \
                -f deploy/k8s/collection/obi-clusterrole.yaml \
                -f deploy/k8s/collection/obi-clusterrolebinding.yaml \
                -f deploy/k8s/collection/obi-configmap.yaml \
                -f deploy/k8s/collection/obi-service.yaml \
                -f deploy/k8s/collection/obi-servicemonitor.yaml \
                -f deploy/k8s/collection/obi-daemonset.yaml

  echo ""
  log_info "Waiting for collection stack workloads to become ready..."
  kubectl -n monitoring rollout status deploy/tempo --timeout=180s
  kubectl -n monitoring rollout status statefulset/prometheus-prometheus-kube-prometheus-prometheus --timeout=300s
  kubectl -n monitoring rollout status statefulset/loki --timeout=300s
  kubectl -n monitoring rollout status ds/fluent-bit --timeout=180s
  kubectl -n monitoring rollout status ds/obi --timeout=180s

  echo ""
  log_success "=========================================================="
  log_success " Observability stack is live."
  log_success "=========================================================="
  echo ""
  echo "Workloads in 'monitoring' namespace:"
  kubectl -n monitoring get pods -o wide
  echo ""
  echo "Telemetry endpoints (in-cluster):"
  echo "  Prometheus:  http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090"
  echo "  Loki:        http://loki-gateway.monitoring.svc:80 (or http://loki.monitoring.svc:3100)"
  echo "  Tempo:       http://tempo.monitoring.svc:3200 (OTLP: :4317/:4318)"
  echo "  OBI:         http://obi.monitoring.svc:8999/metrics"
  echo ""
  echo "Next steps:"
  echo "  1. Deploy demo app:   ./scripts/demo-app.sh install"
  echo "  2. Launch dashboard:  ./scripts/all.sh        (or ./scripts/dev-up.sh)"
  echo ""
}

show_help() {
  cat << EOF
Usage: $0 [TARGET] [OPTIONS]

Targets:
  (none) | all   Cluster prerequisites + k3s + observability stack (default)
  cluster        Only the single-node k3s bootstrap and kubeconfig
  stack          Only the observability stack (Helm charts + Tempo + OBI)

Options:
  --with-demo    After setup, install the boutique demo app (ns/boutique)
  -h, --help     Show this help message

Pin versions (optional, recommended for reproducibility):
  K3S_VERSION=v1.37.2+k3s1
  CHART_KUBE_PROMETHEUS_VERSION=93.2.0
  CHART_LOKI_VERSION=7.6.0
  CHART_FLUENT_BIT_VERSION=0.58.3

If you already have a Kubernetes cluster, run:  $0 stack
EOF
}

# --- Main ---------------------------------------------------------------------

TARGET="all"
WITH_DEMO=false
for arg in "$@"; do
  case "$arg" in
    all|cluster|stack) TARGET="$arg" ;;
    --with-demo) WITH_DEMO=true ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      log_error "Unknown option: $arg"
      show_help
      exit 1
      ;;
  esac
done

run_cluster_setup() {
  detect_environment
  check_prerequisites
  apply_platform_tweaks
  configure_k3s
  install_or_start_k3s
  setup_kubeconfig
  wait_for_cluster
}

run_stack_setup() {
  install_observability_stack
}

case "$TARGET" in
  cluster)
    run_cluster_setup
    log_success "Cluster setup complete. Next: ./scripts/setup.sh stack"
    ;;
  stack)
    run_stack_setup
    ;;
  all)
    run_cluster_setup
    echo ""
    run_stack_setup
    ;;
esac

if [ "$WITH_DEMO" = true ]; then
  echo ""
  log_info "Installing the demo app (unmodified Online Boutique)..."
  ./scripts/demo-app.sh install
fi
