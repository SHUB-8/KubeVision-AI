#!/bin/bash
# ==============================================================================
# KubeVision AI — Observed Demo Application (Google microservices-demo)
#
# Manages the boutique demo workload in ns/boutique, including OpenTelemetry
# auto-instrumentation and context propagation.
#
# Usage:
#   scripts/demo-app.sh install        # deploy boutique + configure OpenTelemetry
#   scripts/demo-app.sh otel           # re-apply OpenTelemetry instrumentation only
#   scripts/demo-app.sh status         # inspect running demo pods
#   scripts/demo-app.sh scale 0        # pause demo (frees ~1.5GB RAM; stops loadgen)
#   scripts/demo-app.sh scale 1        # resume all 11 microservices + loadgen
#   scripts/demo-app.sh port-forward   # access storefront on http://localhost:8080
#   scripts/demo-app.sh delete         # remove ns/boutique completely
# ==============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

NS=boutique
MANIFEST_URL="${BOUTIQUE_MANIFEST_URL:-https://raw.githubusercontent.com/GoogleCloudPlatform/microservices-demo/v0.10.7/release/kubernetes-manifests.yaml}"

configure_otel() {
  echo ""
  echo "=== Configuring OpenTelemetry Auto-Instrumentation for ns/$NS ==="

  # 1. Ensure OpenTelemetry Operator is installed in monitoring namespace
  if ! kubectl get deployment -n monitoring opentelemetry-operator >/dev/null 2>&1; then
    echo "--- Installing OpenTelemetry Operator via Helm ---"
    helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
    helm repo update
    helm upgrade --install opentelemetry-operator open-telemetry/opentelemetry-operator \
      --namespace monitoring \
      --set admissionWebhooks.certManager.enabled=false \
      --set admissionWebhooks.autoGenerateCert.enabled=true
    kubectl rollout status deploy/opentelemetry-operator -n monitoring --timeout=120s
  fi

  # 2. Deploy Instrumentation CR into target namespace pointing to Tempo
  cat <<EOF | kubectl apply -n "$NS" -f -
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: kubevision-instrumentation
  namespace: $NS
spec:
  exporter:
    endpoint: http://tempo.monitoring.svc.cluster.local:4318
  propagators:
    - tracecontext
    - baggage
    - b3
  sampler:
    type: parentbased_always_on
EOF

  # 3. Patch Pod template annotations for non-Go polyglot services
  echo "--- Patching pod templates with language-specific OTel annotations ---"

  patch_otel() {
    local deploy="$1"
    local lang="$2"
    if kubectl get deploy -n "$NS" "$deploy" >/dev/null 2>&1; then
      echo "  Configuring $deploy -> $lang"
      kubectl patch deploy -n "$NS" "$deploy" --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"instrumentation.opentelemetry.io/inject-${lang}\":\"true\"}}}}}"
    fi
  }

  patch_otel "adservice" "java"
  patch_otel "cartservice" "dotnet"
  patch_otel "paymentservice" "nodejs"
  patch_otel "currencyservice" "nodejs"
  patch_otel "emailservice" "python"
  patch_otel "recommendationservice" "python"

  # 4. Enable OTel context propagation on Go services
  echo "--- Enabling native OpenTelemetry context propagation on Go services ---"
  for deploy in frontend checkoutservice productcatalogservice shippingservice; do
    if kubectl get deploy -n "$NS" "$deploy" >/dev/null 2>&1; then
      kubectl set env deploy/"$deploy" -n "$NS" \
        ENABLE_TRACING=1 \
        OTEL_SERVICE_NAME="$deploy" \
        COLLECTOR_SERVICE_ADDR="tempo.monitoring.svc.cluster.local:4317" >/dev/null 2>&1 || true
    fi
  done

  echo ""
  echo "=== OpenTelemetry Auto-Instrumentation successfully configured! ==="
  echo "Watching rollout of instrumented services..."
  kubectl rollout status deploy/adservice -n "$NS" --timeout=180s || true
  kubectl rollout status deploy/paymentservice -n "$NS" --timeout=180s || true
  kubectl rollout status deploy/currencyservice -n "$NS" --timeout=180s || true
  kubectl rollout status deploy/frontend -n "$NS" --timeout=180s || true
}

case "${1:-}" in
  install)
    echo "--- Ensuring namespace ns/$NS exists ---"
    kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

    echo "--- Applying microservices-demo to ns/$NS ---"
    kubectl apply -n "$NS" -f "$MANIFEST_URL"

    echo "--- Waiting for frontend service to be ready ---"
    kubectl -n "$NS" rollout status deploy/frontend --timeout=300s

    # Automatically apply OTel instrumentation
    configure_otel

    echo ""
    echo "Demo app is up! Loadgenerator is generating traffic."
    echo "View pods with:        ./scripts/demo-app.sh status"
    echo "Open in browser with:  ./scripts/demo-app.sh port-forward"
    ;;

  otel|instrument)
    if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
      echo "Namespace '$NS' not found. Run: $0 install"
      exit 1
    fi
    configure_otel
    ;;

  status)
    if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
      echo "Namespace '$NS' not found. Run: $0 install"
      exit 0
    fi
    echo "--- Pods in ns/$NS ---"
    kubectl -n "$NS" get pods -o wide
    ;;

  scale)
    REPLICAS="${2:-}"
    if [ -z "$REPLICAS" ] || ! [[ "$REPLICAS" =~ ^[0-9]+$ ]]; then
      echo "usage: $0 scale {0|1|<number>}"
      exit 1
    fi
    if ! kubectl get namespace "$NS" >/dev/null 2>&1; then
      echo "Namespace '$NS' not found. Run: $0 install"
      exit 1
    fi
    echo "--- Scaling all deployments in ns/$NS to $REPLICAS replicas ---"
    kubectl -n "$NS" scale deploy --all --replicas="$REPLICAS"
    ;;

  port-forward)
    echo "Forwarding frontend to http://localhost:8080 (Ctrl+C to stop)..."
    kubectl -n "$NS" port-forward svc/frontend 8080:80
    ;;

  delete)
    echo "--- Deleting namespace ns/$NS ---"
    kubectl delete namespace "$NS" --ignore-not-found
    echo "Namespace '$NS' removed."
    ;;

  -h|--help|help)
    cat << EOF
Usage: $0 {install|otel|status|scale 0|1|port-forward|delete}

Commands:
  install        Deploy boutique demo app and apply OpenTelemetry auto-instrumentation
  otel           Re-apply OpenTelemetry instrumentation and context propagation
  status         Show running microservice pods in ns/boutique
  scale <n>      Scale all boutique deployments to <n> replicas (e.g., scale 0 to pause)
  port-forward   Forward boutique storefront to http://localhost:8080
  delete         Delete ns/boutique completely
EOF
    exit 0
    ;;

  *)
    echo "Usage: $0 {install|otel|status|scale 0|1|port-forward|delete}"
    exit 1
    ;;
esac
