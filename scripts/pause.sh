#!/bin/bash
# Pause/resume the KubeVision observability stack when not working on it.
#
# Usage:
#   scripts/pause.sh stop     free the RAM: scale stores to 0, remove DaemonSets
#   scripts/pause.sh start    bring everything back (same as re-running phase2)
#   scripts/pause.sh status   what is running right now
#
# NOT touched: the observed application (boutique) - pause it separately with
#   kubectl -n boutique scale deploy --all --replicas=0
#
# When even the cluster shouldn't run (end of day on a laptop):
#   sudo systemctl stop k3s    # frees everything; PVCs and manifests persist
#   sudo systemctl start k3s   # pods come back automatically
# (emptyDir telemetry - Prometheus, Tempo - is wiped by restarts; Loki's PVC
# and all manifests survive.)
set -euo pipefail

NS=monitoring
STORES_STS="loki prometheus-kube-prometheus-prometheus"
STORES_DEPLOY="tempo prometheus-kube-prometheus-kube-state-metrics"
DSES="beyla fluent-bit"

stop_stack() {
  echo "--- Scaling stores to 0 ---"
  for sts in $STORES_STS; do
    kubectl -n "$NS" scale "sts/$sts" --replicas=0 2>/dev/null || echo "  (sts/$sts not found, skipping)"
  done
  for dep in $STORES_DEPLOY; do
    kubectl -n "$NS" scale "deploy/$dep" --replicas=0 2>/dev/null || echo "  (deploy/$dep not found, skipping)"
  done
  echo "--- Removing DaemonSets (DSes cannot scale to 0) ---"
  kubectl -n "$NS" delete ds $DSES --ignore-not-found
  echo "Stack paused. Manifests and Loki's PVC data are untouched."
  echo "Resume with: scripts/pause.sh start"
}

start_stack() {
  echo "--- Re-applying Tempo + Beyla manifests ---"
  kubectl apply -f deploy/k8s/collection/tempo.yaml
  kubectl apply -f deploy/k8s/collection/beyla.yaml
  echo "--- Scaling stores back up ---"
  for sts in $STORES_STS; do
    kubectl -n "$NS" scale "sts/$sts" --replicas=1 2>/dev/null || echo "  (sts/$sts not found, skipping)"
  done
  for dep in $STORES_DEPLOY; do
    kubectl -n "$NS" scale "deploy/$dep" --replicas=1 2>/dev/null || echo "  (deploy/$dep not found, skipping)"
  done
  echo "--- Re-installing Fluent Bit ---"
  helm upgrade --install fluent-bit fluent/fluent-bit \
    --namespace "$NS" \
    -f deploy/k8s/collection/fluent-bit-values.yaml
  echo "--- Waiting ---"
  kubectl -n "$NS" rollout status deploy/tempo --timeout=180s
  kubectl -n "$NS" rollout status ds/fluent-bit --timeout=180s
  kubectl -n "$NS" rollout status ds/beyla --timeout=180s
  echo "Stack resumed."
}

status_stack() {
  kubectl -n "$NS" get pods,ds,sts,deploy 2>/dev/null || echo "cluster unreachable"
}

case "${1:-}" in
  stop) stop_stack ;;
  start) start_stack ;;
  status) status_stack ;;
  *) echo "usage: $0 {stop|start|status}"; exit 1 ;;
esac
