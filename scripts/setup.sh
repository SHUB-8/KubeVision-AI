#!/bin/bash
# ==============================================================================
# KubeVision AI — Unified Cluster & Observability Setup Script
#
# Bootstraps a single-node k3s cluster (Linux/WSL2) and installs the complete
# observability stack: Prometheus, Loki, Fluent Bit, Grafana Tempo, and Beyla (eBPF).
#
# Usage:
#   ./scripts/setup.sh          # Full bootstrap: k3s cluster + observability stack
#   ./scripts/setup.sh --stack  # Observability stack only (Prometheus, Loki, Tempo, Beyla)
#
# Fully idempotent: safe to run multiple times without disrupting existing state.
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

detect_environment() {
  OS="$(uname -s)"
  if [ "$OS" != "Linux" ]; then
    log_error "This script is designed for Linux and Windows (via WSL2)."
    log_error "Detected OS: $OS"
    log_error "For macOS, please use a Linux VM (OrbStack, Colima, or Lima) or k3d with Docker."
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
  log_info "--- Checking system prerequisites for KubeVision & eBPF (Beyla) ---"

  KERNEL_VER="$(uname -r)"
  log_info "Kernel version: ${BOLD}$KERNEL_VER${NC}"

  KERNEL_MAJOR="$(echo "$KERNEL_VER" | cut -d. -f1)"
  KERNEL_MINOR="$(echo "$KERNEL_VER" | cut -d. -f2)"
  if [ "$KERNEL_MAJOR" -lt 5 ] || { [ "$KERNEL_MAJOR" -eq 5 ] && [ "$KERNEL_MINOR" -lt 4 ]; }; then
    log_warn "Kernel is older than 5.4. Grafana Beyla (eBPF) works best on modern kernels (>= 5.8)."
  else
    log_success "Kernel version satisfies eBPF requirements."
  fi

  # Check eBPF / BPF filesystem
  if [ -d "/sys/fs/bpf" ]; then
    log_success "eBPF filesystem (/sys/fs/bpf) is mounted."
  else
    log_warn "eBPF filesystem (/sys/fs/bpf) not detected. Beyla daemonset will mount it dynamically."
  fi

  # Check debugfs / tracing
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

  # Check BTF (BPF Type Format)
  if [ -f "/sys/kernel/btf/vmlinux" ]; then
    log_success "BTF (BPF Type Format) available at /sys/kernel/btf/vmlinux."
  elif zcat /proc/config.gz 2>/dev/null | grep -q "CONFIG_DEBUG_INFO_BTF=y"; then
    log_success "Kernel compiled with CONFIG_DEBUG_INFO_BTF=y."
  else
    log_info "BTF not detected in sysfs; Beyla will utilize runtime probe fallbacks."
  fi

  # Check Secure Boot
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
      log_info "Unmounting Docker Desktop host mount (/Docker/host) to prevent Kubelet cAdvisor crashes..."
      run_sudo umount /Docker/host 2>/dev/null || true
    fi

    # Persistent systemd drop-in override for k3s
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
    NODE_IP="$(ip addr show eth0 2>/dev/null | grep -Po 'inet \K[\d.]+' || true)"
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
    curl -sfL https://get.k3s.io | run_sudo sh -s - server \
      --write-kubeconfig-mode 644 \
      --disable traefik \
      --disable servicelb
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
    node_ip="$(ip addr show eth0 2>/dev/null | grep -Po 'inet \K[\d.]+' || true)"
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
  if [ -f "$HOME/.kube/config" ]; then
    if ! grep -q "127.0.0.1:6443" "$HOME/.kube/config" 2>/dev/null && ! grep -q "default" "$HOME/.kube/config" 2>/dev/null; then
      cp "$HOME/.kube/config" "$HOME/.kube/config.bak.$(date +%s)" 2>/dev/null || true
    fi
  fi

  run_sudo cat /etc/rancher/k3s/k3s.yaml > "$HOME/.kube/config"
  run_sudo chown "$(id -u):$(id -g)" "$HOME/.kube/config" 2>/dev/null || true
  chmod 600 "$HOME/.kube/config"
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
}

install_observability_stack() {
  log_info "=== Deploying KubeVision Observability Stack ==="

  log_info "Creating monitoring namespace..."
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

  log_info "Adding and updating Helm Repositories..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo add grafana https://grafana.github.io/helm-charts
  helm repo add fluent https://fluent.github.io/helm-charts
  helm repo update

  log_info "Ensuring Prometheus Operator CRDs (server-side apply)..."
  CRD_DIR=$(mktemp -d)
  trap 'rm -rf "$CRD_DIR"' EXIT
  helm pull prometheus-community/kube-prometheus-stack --untar --untardir="$CRD_DIR"
  CRD_SRC="$CRD_DIR/kube-prometheus-stack/charts/crds/crds"
  [ -d "$CRD_SRC" ] || CRD_SRC="$CRD_DIR/kube-prometheus-stack/crds"
  kubectl apply --server-side --force-conflicts -f "$CRD_SRC"
  rm -rf "$CRD_DIR"
  trap - EXIT

  log_info "Installing / upgrading kube-prometheus-stack..."
  helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    -f deploy/helm/prometheus-values.yaml

  log_info "Installing / upgrading Loki..."
  helm upgrade --install loki grafana/loki \
    --namespace monitoring \
    -f deploy/helm/loki-values.yaml

  log_info "Installing / upgrading Fluent Bit (log collection DaemonSet)..."
  helm upgrade --install fluent-bit fluent/fluent-bit \
    --namespace monitoring \
    -f deploy/helm/fluent-bit-values.yaml

  log_info "Deploying Grafana Tempo (distributed tracing backend)..."
  kubectl apply -f deploy/k8s/collection/tempo.yaml

  log_info "Deploying Grafana Beyla (eBPF telemetry DaemonSet)..."
  kubectl apply -f deploy/k8s/collection/beyla.yaml

  echo ""
  log_info "Waiting for collection stack workloads to become ready..."

  echo "  > Waiting for Tempo deployment..."
  kubectl -n monitoring rollout status deploy/tempo --timeout=180s

  echo "  > Waiting for Prometheus statefulset..."
  kubectl -n monitoring rollout status statefulset/prometheus-prometheus-kube-prometheus-prometheus --timeout=300s

  echo "  > Waiting for Loki statefulset..."
  kubectl -n monitoring rollout status statefulset/loki --timeout=300s

  echo "  > Waiting for Fluent Bit DaemonSet..."
  kubectl -n monitoring rollout status ds/fluent-bit --timeout=180s

  echo "  > Waiting for Beyla eBPF DaemonSet..."
  kubectl -n monitoring rollout status ds/beyla --timeout=180s

  echo ""
  log_success "=========================================================="
  log_success " KubeVision Observability stack is live and operational!"
  log_success "=========================================================="
  echo ""
  echo "Workloads in 'monitoring' namespace:"
  kubectl -n monitoring get pods -o wide
  echo ""
  echo "Telemetry endpoints (in-cluster):"
  echo "  Prometheus:  http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090"
  echo "  Loki:        http://loki-gateway.monitoring.svc:80 (or http://loki.monitoring.svc:3100)"
  echo "  Tempo:       http://tempo.monitoring.svc:3200 (OTLP: :4317/:4318)"
  echo "  Beyla:       http://beyla.monitoring.svc:8999/metrics"
  echo ""
}

# --- Main Dispatcher ----------------------------------------------------------
TARGET="${1:-all}"

case "$TARGET" in
  --stack|--phase2|--phase-2|stack)
    install_observability_stack
    ;;
  all|--all|"")
    detect_environment
    check_prerequisites
    apply_platform_tweaks
    configure_k3s
    install_or_start_k3s
    setup_kubeconfig
    wait_for_cluster
    install_observability_stack
    echo "Next: Deploy demo app and launch dashboard:"
    echo "  ./scripts/demo-app.sh install"
    echo "  ./scripts/dev-up.sh"
    ;;
  -h|--help)
    echo "Usage: $0 [--stack]"
    echo "  (no args)  Full cluster bootstrap + observability stack deployment"
    echo "  --stack    Deploy or update observability stack only (Helm & manifests)"
    exit 0
    ;;
  *)
    log_error "Unknown option: $TARGET"
    echo "Usage: $0 [--stack]"
    exit 1
    ;;
esac
