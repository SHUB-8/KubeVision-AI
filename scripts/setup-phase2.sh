#!/bin/bash
# Phase 2 — install the KubeVision collection/evidence stack into an existing
# cluster (k3s: run scripts/setup-phase1.sh first).
#
# All chart configuration lives in values files under deploy/helm/ - edit
# those, then re-run this script (helm upgrade --install is idempotent).
set -e

echo "--- Creating monitoring namespace ---"
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

echo "--- Adding Helm Repositories ---"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

echo "--- Ensuring Prometheus Operator CRDs ---"
# kube-prometheus-stack >= 91.x ships CRDs as a subchart (charts/crds/crds/,
# managed by helm via crds.enabled + an upgrade hook job); older charts had a
# top-level crds/ dir that helm applies on INSTALL but never re-applies on
# UPGRADE. Applying them up-front is idempotent and keeps upgrades working
# even if the release was installed by an older chart. --server-side avoids
# kubectl's 256KB last-applied-annotation limit (the Prometheus CRD exceeds
# it).
CRD_DIR=$(mktemp -d)
helm pull prometheus-community/kube-prometheus-stack --untar --untardir "$CRD_DIR"
CRD_SRC="$CRD_DIR/kube-prometheus-stack/charts/crds/crds"
[ -d "$CRD_SRC" ] || CRD_SRC="$CRD_DIR/kube-prometheus-stack/crds"
kubectl apply --server-side --force-conflicts -f "$CRD_SRC"
rm -rf "$CRD_DIR"

echo "--- Installing kube-prometheus-stack ---"
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f deploy/helm/prometheus-values.yaml

echo "--- Installing Loki ---"
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  -f deploy/helm/loki-values.yaml

echo "--- Installing Fluent Bit ---"
helm upgrade --install fluent-bit fluent/fluent-bit \
  --namespace monitoring \
  -f deploy/helm/fluent-bit-values.yaml

echo "--- Deploying Grafana Tempo (raw manifests) ---"
kubectl apply -f deploy/k8s/collection/tempo.yaml

echo "--- Deploying Grafana Beyla (raw manifests) ---"
kubectl apply -f deploy/k8s/collection/beyla.yaml

echo "--- Restarting Beyla to apply trace exporting ---"
kubectl rollout restart ds beyla -n monitoring

echo "--- Waiting for workloads to become ready ---"
kubectl -n monitoring rollout status deploy/tempo --timeout=180s
kubectl -n monitoring rollout status ds/fluent-bit --timeout=180s
kubectl -n monitoring rollout status ds/beyla --timeout=180s

echo "--- Collection stack deployed. Verify: ---"
echo "  kubectl -n monitoring get pods"
echo "  # Beyla metrics with k8s labels (needs traffic on the observed pods):"
echo "  kubectl -n monitoring port-forward svc/beyla 8999:8999"
echo "  curl -s localhost:8999/metrics | grep -E 'k8s_namespace_name' | head -5"
