#!/bin/bash
# ==============================================================================
# KubeVision AI — In-Cluster Observability Stack Management
#
# Manages the monitoring namespace lifecycle and data hygiene:
#   - Pause/resume cluster stores (saves 2-4GB RAM when not developing)
#   - Inspect disk usage and retention policies across stores
#   - Emergency data reclamation (wipe emptyDir / PVC data)
#
# Usage:
#   scripts/stack.sh pause      # Free RAM: scale stores to 0, remove DaemonSets
#   scripts/stack.sh resume     # Restore all monitoring stores & DaemonSets
#   scripts/stack.sh status     # Inspect workloads in ns/monitoring
#   scripts/stack.sh disk       # View disk consumption & retention config
#   scripts/stack.sh nuke       # Delete Prometheus/Tempo pods to wipe emptyDir data
#   scripts/stack.sh nuke-loki  # Wipe Loki PVC data (dev only!)
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NS=monitoring
STORES_STS="loki prometheus-prometheus-kube-prometheus-prometheus"
STORES_DEPLOY="tempo prometheus-kube-state-metrics"
DSES="beyla fluent-bit"

usage_in_pod() { # <pod> <container> <dir>
  kubectl -n "$NS" exec "$1" -c "$2" -- du -sh "$3" 2>/dev/null | awk '{print $1 "\t" $3}'
}

pause_stack() {
  echo "--- Scaling stores to 0 (freeing RAM) ---"
  for sts in $STORES_STS; do
    kubectl -n "$NS" scale "sts/$sts" --replicas=0 2>/dev/null || echo "  WARNING: sts/$sts not found"
  done
  for dep in $STORES_DEPLOY; do
    kubectl -n "$NS" scale "deploy/$dep" --replicas=0 2>/dev/null || echo "  WARNING: deploy/$dep not found"
  done
  echo "--- Removing DaemonSets (DSes cannot scale to 0) ---"
  kubectl -n "$NS" delete ds $DSES --ignore-not-found
  echo "Stack paused. Manifests and Loki PVC data are untouched."
  echo "Resume with: ./scripts/stack.sh resume"
}

resume_stack() {
  echo "--- Re-applying Tempo + Beyla manifests ---"
  kubectl apply -f deploy/k8s/collection/tempo.yaml
  kubectl apply -f deploy/k8s/collection/beyla.yaml
  echo "--- Scaling stores back up ---"
  for sts in $STORES_STS; do
    kubectl -n "$NS" scale "sts/$sts" --replicas=1 2>/dev/null || echo "  WARNING: sts/$sts not found"
  done
  for dep in $STORES_DEPLOY; do
    kubectl -n "$NS" scale "deploy/$dep" --replicas=1 2>/dev/null || echo "  WARNING: deploy/$dep not found"
  done
  echo "--- Re-installing Fluent Bit ---"
  helm upgrade --install fluent-bit fluent/fluent-bit \
    --namespace "$NS" \
    -f deploy/helm/fluent-bit-values.yaml
  echo "--- Waiting for rollouts ---"
  kubectl -n "$NS" rollout status deploy/tempo --timeout=180s
  kubectl -n "$NS" rollout status ds/fluent-bit --timeout=180s
  kubectl -n "$NS" rollout status ds/beyla --timeout=180s
  echo "Stack resumed."
}

status_stack() {
  kubectl -n "$NS" get pods,ds,sts,deploy 2>/dev/null || echo "cluster unreachable"
}

disk_usage() {
  echo "--- Node Disk ---"
  df -h / | tail -1
  echo ""
  echo "--- Persistent Storage (PVCs) ---"
  kubectl -n "$NS" get pvc 2>/dev/null || echo "No PVCs found"
  echo ""
  echo "--- In-Cluster Resource Consumption (CPU & RAM) ---"
  kubectl -n "$NS" top pods 2>/dev/null || echo "Metrics unavailable"
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
  helm -n "$NS" get values prometheus 2>/dev/null | grep -E "retention" | sed 's/^/  /' || echo "  default retention"
  echo "Loki retention:"
  grep -E "retention_period" deploy/helm/loki-values.yaml | sed 's/^/  /' || echo "  default retention"
  echo "Tempo retention:"
  grep block_retention deploy/k8s/collection/tempo.yaml | head -1 | sed 's/^/  /' || echo "  default retention"
}

nuke_stores() {
  echo "--- Deleting store pods (emptyDir data wiped, pods restart fresh) ---"
  kubectl -n "$NS" delete pod -l app.kubernetes.io/name=prometheus --ignore-not-found
  kubectl -n "$NS" delete pod -l app=tempo --ignore-not-found
  echo "Prometheus + Tempo wiped. Waiting for restart..."
  kubectl -n "$NS" rollout status deploy/tempo --timeout=120s || true
}

nuke_loki() {
  echo "--- Wiping Loki PVC data (dev only! all logs are lost) ---"
  kubectl -n "$NS" scale sts loki --replicas=0
  kubectl -n "$NS" wait --for=delete pod/loki-0 --timeout=60s || true
  kubectl -n "$NS" exec loki-0 -c loki -- sh -c 'rm -rf /var/loki/*' 2>/dev/null \
    || echo "(loki-0 stopped; PVC dir on node: sudo rm -rf /var/lib/rancher/k3s/storage/pvc-*_monitoring_storage-loki-0-*)"
  kubectl -n "$NS" scale sts loki --replicas=1
  kubectl -n "$NS" rollout status sts/loki --timeout=120s
}

case "${1:-}" in
  pause|stop)
    pause_stack
    ;;
  resume|start)
    resume_stack
    ;;
  status)
    status_stack
    ;;
  disk|cleanup)
    disk_usage
    ;;
  nuke)
    nuke_stores
    ;;
  nuke-loki)
    nuke_loki
    ;;
  -h|--help)
    cat << EOF
Usage: $0 {pause|resume|status|disk|nuke|nuke-loki}

Commands:
  pause       Scale stores to 0, remove DaemonSets to free ~2-4GB RAM
  resume      Scale stores back up and restore DaemonSets
  status      Show current pods, daemonsets, and statefulsets in ns/monitoring
  disk        Show disk usage in pods and node local-path PVCs
  nuke        Emergency emptyDir wipe (restarts Prometheus & Tempo fresh)
  nuke-loki   Wipe Loki PVC data (dev only!)
EOF
    ;;
  *)
    echo "Usage: $0 {pause|resume|status|disk|nuke|nuke-loki}"
    exit 1
    ;;
esac
