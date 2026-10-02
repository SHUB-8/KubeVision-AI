#!/bin/bash
# ==============================================================================
# KubeVision AI — Phase 2: Observability & Evidence Stack Setup
#
# Deploys KubeVision's complete telemetry & evidence stack:
#   - Prometheus (metrics collection & alerting)
#   - Loki (log aggregation)
#   - Fluent Bit (log collection DaemonSet)
#   - Grafana Tempo (distributed tracing)
#   - Grafana Beyla (eBPF auto-telemetry DaemonSet)
#   - OpenTelemetry Operator (language-specific auto-instrumentation)
#
# Works across any Kubernetes cluster (k3s, EKS, GKE, AKS, bare-metal).
#
# Usage:
#   ./scripts/setup-phase2.sh                              # Deploy/upgrade complete observability stack
#   ./scripts/setup-phase2.sh --instrument [NS] [DEP] [RT] # Auto-instrument any namespace with OpenTelemetry
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

install_observability_stack() {
  log_info "=== Deploying KubeVision Observability Stack ==="

  log_info "Creating monitoring namespace..."
  kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

  log_info "Adding and updating Helm Repositories..."
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
  helm repo add grafana https://grafana.github.io/helm-charts
  helm repo add fluent https://fluent.github.io/helm-charts
  helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
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

  log_info "Installing / upgrading OpenTelemetry Operator..."
  helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
    --namespace monitoring \
    --set admissionWebhooks.certManager.enabled=false \
    --set admissionWebhooks.autoGenerateCert.enabled=true

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

  echo "  > Waiting for OpenTelemetry Operator deployment..."
  kubectl -n monitoring rollout status deploy/opentelemetry-operator --timeout=120s

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
  echo "  OTel Op:     opentelemetry-operator.monitoring.svc"
  echo ""
  echo "Next steps:"
  echo "  1. Deploy demo app:     ./scripts/demo-app.sh install"
  echo "  2. Launch dashboard:    ./scripts/dev-up.sh"
  echo ""
}

# --- OpenTelemetry Auto-Instrumentation ---------------------------------------

detect_runtime() {
  local deploy="$1"
  local json="$2"

  local lower
  lower=$(echo "$json" | tr '[:upper:]' '[:lower:]')

  if echo "$deploy $lower" | grep -Eq 'loadgenerator|locust|jmeter|k6'; then
    echo "skip_loadgenerator"
    return
  fi

  if echo "$lower" | grep -Eq 'java|openjdk|temurin|corretto|\.jar'; then
    echo "java"
    return
  fi
  if echo "$lower" | grep -Eq 'dotnet|coreclr|aspnet|\.dll'; then
    echo "dotnet"
    return
  fi
  if echo "$lower" | grep -Eq 'node|npm|yarn|express|\.js'; then
    echo "nodejs"
    return
  fi
  if echo "$lower" | grep -Eq 'python|pip|gunicorn|uvicorn|\.py'; then
    echo "python"
    return
  fi
  if echo "$lower" | grep -Eq 'golang|go |microservices-demo/(frontend|checkoutservice|productcatalogservice|shippingservice)'; then
    echo "go"
    return
  fi

  echo "unknown"
}

instrument_workloads() {
  local ns="${1:-boutique}"
  local target_deploy="${2:-}"
  local forced_runtime="${3:-}"

  log_info "=== Enabling OpenTelemetry Auto-Instrumentation for ns/$ns ==="

  # Ensure OpenTelemetry Operator is running in monitoring namespace
  if ! kubectl get deployment -n monitoring opentelemetry-operator >/dev/null 2>&1; then
    log_info "OpenTelemetry Operator not found. Installing..."
    helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
    helm repo update
    helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
      --namespace monitoring \
      --set admissionWebhooks.certManager.enabled=false \
      --set admissionWebhooks.autoGenerateCert.enabled=true
    kubectl -n monitoring rollout status deploy/opentelemetry-operator --timeout=120s
  fi

  # Deploy Instrumentation CR into target namespace pointing to Tempo
  log_info "Deploying Instrumentation CR to ns/$ns..."
  cat <<EOF | kubectl apply -n "$ns" -f -
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: kubevision-instrumentation
  namespace: $ns
spec:
  exporter:
    endpoint: http://tempo.monitoring.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
    - b3
  sampler:
    type: parentbased_always_on
  env:
    # The collector intentionally has NO metrics pipeline (Beyla is the single
    # metrics source, scraped by Prometheus). Without this, the Java agent
    # still defaults OTEL_METRICS_EXPORTER=otlp and spams "Failed to export
    # metrics ... 404 page not found" once a minute forever - the data was
    # never collected anyway, so disabling loses nothing.
    - name: OTEL_METRICS_EXPORTER
      value: "none"
    - name: OTEL_PYTHON_EXCLUDED_URLS
      value: ".*health.*"
    - name: OTEL_NODEJS_EXCLUDED_URLS
      value: ".*health.*"
    - name: OTEL_DOTNET_AUTO_EXCLUDED_URLS
      value: ".*health.*"
EOF

  log_info "Inspecting deployments in ns/$ns for automatic instrumentation..."

  local target_deploys=()
  if [ -n "$target_deploy" ]; then
    target_deploys=("$target_deploy")
  else
    mapfile -t target_deploys < <(kubectl get deploy -n "$ns" -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n')
  fi

  local patched_deploys=()

  for deploy in "${target_deploys[@]}"; do
    [ -z "$deploy" ] && continue

    local deploy_json
    deploy_json=$(kubectl get deploy -n "$ns" "$deploy" -o jsonpath='{.spec.template.spec.containers[*].image} {.spec.template.spec.containers[*].command} {.spec.template.spec.containers[*].args} {.spec.template.spec.containers[*].env}' 2>/dev/null || echo "")

    local runtime="$forced_runtime"
    if [ -z "$runtime" ]; then
      runtime=$(detect_runtime "$deploy" "$deploy_json")
    fi

    case "$runtime" in
      java|dotnet|nodejs|python)
        echo "  [Auto-detected $runtime] Injecting OTel instrumentation into deploy/$deploy..."
        kubectl patch deploy -n "$ns" "$deploy" --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"instrumentation.opentelemetry.io/inject-${runtime}\":\"true\"}}}}}"
        patched_deploys+=("$deploy")
        ;;
      go)
        echo "  [Auto-detected Go] Configuring standard OpenTelemetry endpoints for deploy/$deploy..."
        kubectl set env deploy/"$deploy" -n "$ns" \
          ENABLE_TRACING=1 \
          OTEL_SERVICE_NAME="$deploy" \
          COLLECTOR_SERVICE_ADDR="tempo.monitoring.svc.cluster.local:4317" \
          OTEL_EXPORTER_OTLP_ENDPOINT="http://tempo.monitoring.svc.cluster.local:4318" >/dev/null 2>&1 || true
        patched_deploys+=("$deploy")
        ;;
      skip_loadgenerator)
        echo "  [Traffic Generator] Preserving native client engine for deploy/$deploy (traced via server & eBPF network flows)."
        ;;
      *)
        echo "  [Generic/Native] Service deploy/$deploy (traced automatically via Beyla eBPF)."
        ;;
    esac
  done

  if [ ${#patched_deploys[@]} -gt 0 ]; then
    log_info "Watching rollout of instrumented services..."
    for deploy in "${patched_deploys[@]}"; do
      kubectl rollout status deploy/"$deploy" -n "$ns" --timeout=60s || true
    done
  fi

  log_success "OpenTelemetry Auto-Instrumentation complete for ns/$ns!"
}

# --- Main Dispatcher ----------------------------------------------------------
TARGET="${1:-all}"

case "$TARGET" in
  --instrument|--otel|instrument|otel)
    shift
    instrument_workloads "${1:-boutique}" "${2:-}" "${3:-}"
    ;;
  all|--all|"")
    install_observability_stack
    ;;
  -h|--help)
    cat << EOF
Usage: $0 [OPTION]

Options:
  (no args)                        Deploy/upgrade the complete KubeVision observability stack
  --instrument [NS] [DEPLOY] [RT]  Auto-instrument a namespace with OpenTelemetry (default NS: 'boutique')

Examples:
  $0                               # deploy complete observability stack
  $0 --instrument boutique         # instrument boutique namespace
  $0 --instrument my-app           # instrument custom application namespace
EOF
    exit 0
    ;;
  *)
    log_error "Unknown option: $TARGET"
    echo "Usage: $0 [--instrument [namespace]]"
    exit 1
    ;;
esac
