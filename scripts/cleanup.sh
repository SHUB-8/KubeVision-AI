#!/bin/bash
# Disk hygiene for the KubeVision dev cluster (single-node k3s on a PC).
#
# Usage:
#   scripts/cleanup.sh           show disk usage + retention settings (safe)
#   scripts/cleanup.sh --nuke    emergency reclaim: delete store pods, which
#                                wipes their emptyDir data (Prometheus, Tempo)
#   scripts/cleanup.sh --nuke-loki  ALSO wipe Loki's PVC data (dev only!)
#
# What fills the disk, and what bounds it:
#   Prometheus  emptyDir (kubelet dir)   retention 7d / 8GiB (setup-phase2.sh)
#   Loki        10Gi PVC (local-path)    compactor retention 168h
#   Tempo       emptyDir                 block_retention 72h (tempo.yaml)
#   Beyla       no storage (pull/push)   -
#   BadgerDB    backend ./data dir       KB-MB scale metadata, negligible
# Unused container images are GC'd automatically by the kubelet at ~85% disk.
set -euo pipefail

NS=monitoring

usage_in_pod() { # <pod> <container> <dir>
  kubectl -n "$NS" exec "$1" -c "$2" -- du -sh "$3" 2>/dev/null | awk '{print $1 "\t" $3}'
}

status() {
  echo "--- Node disk ---"
  df -h / | tail -1
  echo
  echo "--- Telemetry stores (in-pod usage) ---"
  PROM_POD=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=prometheus -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  [ -n "$PROM_POD" ] && usage_in_pod "$PROM_POD" prometheus /prometheus || echo "prometheus: not running"
  kubectl -n "$NS" exec loki-0 -c loki -- du -sh /var/loki 2>/dev/null | awk '{print "loki (PVC)\t" $1}' || echo "loki: not running"
  usage_in_pod deploy/tempo tempo /var/tempo || echo "tempo: not running"
  echo
  echo "--- Loki PVC on node (k3s local-path) ---"
  sudo du -sh /var/lib/rancher/k3s/storage/pvc-*_monitoring_storage-loki-0-* 2>/dev/null || echo "not found"
  echo
  echo "--- Retention currently applied ---"
  helm -n "$NS" get values prometheus 2>/dev/null | grep -E "retention" || echo "prometheus: defaults (no retention override!)"
  kubectl -n "$NS" exec loki-0 -c loki -- grep -E "retention_period" /etc/loki/config/config.yaml 2>/dev/null || echo "loki: no retention_period configured!"
  grep block_retention deploy/k8s/collection/tempo.yaml | head -1
}

nuke() {
  echo "--- Deleting store pods (emptyDir data is wiped, pods restart fresh) ---"
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
  "") status ;;
  --nuke) nuke ;;
  --nuke-loki) nuke_loki ;;
  *) echo "usage: $0 [--nuke|--nuke-loki]"; exit 1 ;;
esac
