#!/bin/bash
# ==============================================================================
# Phase 2 — Install KubeVision Collection & Evidence Stack
# Deploys Prometheus, Loki, Fluent Bit, Grafana Tempo, and Grafana Beyla (eBPF).
# Works across any Kubernetes cluster (k3s, EKS, GKE, AKS, bare-metal)
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# Color helpers
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }

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
log_info "Waiting for all collection stack workloads to become ready..."

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
log_success " KubeVision Phase 2 complete! Observability stack is live."
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
echo "Next: Launch the Go Backend & Dashboard using:"
echo "  ./scripts/dev-up.sh"
