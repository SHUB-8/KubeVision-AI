#!/bin/bash
# Enable OpenTelemetry Auto-Instrumentation on the target namespace.
# Works with zero application code changes and zero manifest changes.
set -euo pipefail
cd "$(dirname "$0")/.."

NS="${1:-boutique}"

echo "=== Enabling OpenTelemetry Auto-Instrumentation for ns/$NS ==="

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

echo ""
echo "=== OpenTelemetry Auto-Instrumentation successfully configured! ==="
echo "Watching rollout of instrumented services..."
kubectl rollout status deploy/adservice -n "$NS" --timeout=180s || true
kubectl rollout status deploy/paymentservice -n "$NS" --timeout=180s || true
kubectl rollout status deploy/currencyservice -n "$NS" --timeout=180s || true
