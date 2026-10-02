#!/bin/bash
# ==============================================================================
# KubeVision AI — Total Monitoring Stack & Disk Storage Cleanup
#
# Thoroughly purges the observability & evidence collection system:
#   1. Kills orphaned host port-forwards (9090, 3100, 3200, 8999)
#   2. Removes admission webhooks (prevents namespace termination deadlock)
#   3. Uninstalls all Helm releases (Prometheus, Loki, Fluent Bit, OTel Operator)
#   4. Deletes raw manifests (Beyla, Tempo, OTel Collector) & ClusterRoles
#   5. Deletes all Persistent Volume Claims (PVCs) in monitoring
#   6. Deletes the 'monitoring' namespace entirely
#   7. Purges all host disk storage (k3s local-path PVC directories on node)
#
# Safe to run anytime. Reinstall fresh with:
#   ./scripts/setup-phase2.sh
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NS="monitoring"
FORCE=false

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

for arg in "$@"; do
  case "$arg" in
    -y|--yes|--force|-f)
      FORCE=true
      ;;
    -h|--help)
      cat << EOF
Usage: $0 [-y|--yes|--force]

Purges all observability workloads, PVCs, namespaces, and node disk data.

Options:
  -y, --yes, --force   Skip confirmation prompt
  -h, --help           Show this help message
EOF
      exit 0
      ;;
  esac
done

if [ "$FORCE" = false ] && [ -t 0 ]; then
  echo -e "${YELLOW}${BOLD}WARNING: This will permanently delete:${NC}"
  echo "  - All Prometheus metrics, Loki logs, and Tempo traces"
  echo "  - The '$NS' namespace and all workloads (Beyla, Fluent Bit, OTel, etc.)"
  echo "  - All PVCs (storage-loki-0, etc.) and underlying disk storage on the node"
  echo ""
  read -rp "Are you sure you want to proceed? [y/N]: " confirm
  if [[ ! "$confirm" =~ ^[yY]([eE][sS])?$ ]]; then
    echo "Aborted."
    exit 0
  fi
fi

log_info "=== Starting KubeVision Monitoring Stack Cleanup ==="

# 1. Stop host port-forwards for monitoring services
log_info "1/7 Stopping local port-forwards to monitoring stores..."
pkill -f "kubectl.*port-forward.*(9090|3100|3200|8999)" 2>/dev/null || true

# 2. Delete admission webhooks to prevent pod deletion deadlocks
log_info "2/7 Cleaning up admission webhook configurations..."
kubectl delete mutatingwebhookconfiguration \
  opentelemetry-operator-mutation \
  prometheus-kube-prometheus-admission \
  --ignore-not-found 2>/dev/null || true

kubectl delete validatingwebhookconfiguration \
  opentelemetry-operator-validation \
  prometheus-kube-prometheus-admission \
  --ignore-not-found 2>/dev/null || true

# 3. Uninstall Helm releases in monitoring namespace
log_info "3/7 Uninstalling Helm releases in ns/$NS..."
if command -v helm >/dev/null 2>&1; then
  RELEASES=$(helm list -n "$NS" -q 2>/dev/null || true)
  if [ -n "$RELEASES" ]; then
    for rel in $RELEASES; do
      echo "  Uninstalling Helm release: $rel"
      helm uninstall "$rel" -n "$NS" --timeout=60s 2>/dev/null || true
    done
  else
    echo "  No Helm releases found in ns/$NS."
  fi
fi

# 4. Delete raw manifests, orphaned workloads, and cluster-scoped RBAC
log_info "4/7 Deleting raw collection manifests & RBAC..."
kubectl delete -f deploy/k8s/collection/beyla.yaml --ignore-not-found 2>/dev/null || true
kubectl delete -f deploy/k8s/collection/tempo.yaml --ignore-not-found 2>/dev/null || true
kubectl delete deploy,svc,cm -l app=otel-collector -n "$NS" --ignore-not-found 2>/dev/null || true
kubectl delete deploy/otel-collector cm/otel-collector-config svc/otel-collector -n "$NS" --ignore-not-found 2>/dev/null || true
kubectl delete clusterrole beyla --ignore-not-found 2>/dev/null || true
kubectl delete clusterrolebinding beyla --ignore-not-found 2>/dev/null || true

# 5. Delete all Persistent Volume Claims (PVCs) in monitoring
log_info "5/7 Deleting all PVCs in ns/$NS..."
if kubectl get ns "$NS" >/dev/null 2>&1; then
  PVCS=$(kubectl -n "$NS" get pvc -o jsonpath='{.items[*].metadata.name}' 2>/dev/null || true)
  if [ -n "$PVCS" ]; then
    for pvc in $PVCS; do
      echo "  Removing finalizers and deleting PVC: $pvc"
      kubectl -n "$NS" patch pvc "$pvc" -p '{"metadata":{"finalizers":null}}' --type=merge 2>/dev/null || true
      kubectl -n "$NS" delete pvc "$pvc" --ignore-not-found 2>/dev/null || true
    done
  else
    echo "  No PVCs found in ns/$NS."
  fi
fi

# 6. Delete the monitoring namespace
log_info "6/7 Deleting namespace '$NS'..."
if kubectl get ns "$NS" >/dev/null 2>&1; then
  kubectl delete namespace "$NS" --ignore-not-found --timeout=60s 2>/dev/null || true

  # If namespace is stuck terminating due to remaining resources or finalizers, clear finalizers
  if kubectl get ns "$NS" >/dev/null 2>&1; then
    log_warn "Namespace '$NS' still finalizing. Stripping namespace finalizers..."
    kubectl get namespace "$NS" -o json 2>/dev/null \
      | jq '.spec.finalizers = []' 2>/dev/null \
      | kubectl replace --raw "/api/v1/namespaces/$NS/finalize" -f - >/dev/null 2>&1 || true
    sleep 2
  fi
  log_success "Namespace '$NS' deleted."
else
  echo "  Namespace '$NS' does not exist."
fi

# 7. Purge node local-path disk storage
log_info "7/7 Reclaiming node disk storage (k3s local-path storage)..."
STORAGE_DIRS=(/var/lib/rancher/k3s/storage/pvc-*_monitoring_*)

wipe_storage_cmd="rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_* 2>/dev/null || true"

cleaned=false
if [ "$(id -u)" -eq 0 ]; then
  eval "$wipe_storage_cmd"
  cleaned=true
elif sudo -n true 2>/dev/null; then
  sudo bash -c "$wipe_storage_cmd"
  cleaned=true
elif [ -t 0 ]; then
  echo "  Root privileges required to purge /var/lib/rancher/k3s/storage/pvc-*_monitoring_* on host:"
  sudo bash -c "$wipe_storage_cmd" && cleaned=true || true
fi

if [ "$cleaned" = true ]; then
  log_success "Host local-path storage directories purged."
else
  log_warn "Could not clean host storage automatically (requires sudo)."
  log_warn "To finish wiping host disk manually, run:"
  echo -e "    ${BOLD}sudo rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_*${NC}"
fi

echo ""
log_success "=========================================================="
log_success " Cleanup complete! Observability stack & disk are purged."
log_success "=========================================================="
echo ""
echo "Remaining PVCs across cluster:"
kubectl get pvc -A 2>/dev/null || echo "None"
echo ""
echo "Current Node Disk Usage:"
df -h / | tail -1
echo ""
echo "To reinstall the fresh observability stack anytime:"
echo "  ./scripts/setup-phase2.sh"
echo ""
