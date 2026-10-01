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
  env:
    - name: OTEL_PYTHON_EXCLUDED_URLS
      value: ".*health.*"
    - name: OTEL_NODEJS_EXCLUDED_URLS
      value: ".*health.*"
    - name: OTEL_DOTNET_AUTO_EXCLUDED_URLS
      value: ".*health.*"
EOF

# 3. Dynamic runtime detection and OpenTelemetry instrumentation
echo "--- Inspecting deployments in ns/$NS for automatic instrumentation ---"

detect_runtime() {
  local deploy="$1"
  local json="$2"

  # Convert inspectable json to lowercase
  local lower
  lower=$(echo "$json" | tr '[:upper:]' '[:lower:]')

  # Skip load generators / locust to avoid gevent monkeypatch conflicts
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
  if echo "$lower" | grep -Eq 'golang|go '; then
    echo "go"
    return
  fi

  echo "unknown"
}

TARGET_DEPLOYS=()
if [ -n "${2:-}" ]; then
  # User specified single deployment: ./enable-otel.sh <namespace> <deployment> [runtime]
  TARGET_DEPLOYS=("$2")
else
  # Inspect all deployments in namespace
  mapfile -t TARGET_DEPLOYS < <(kubectl get deploy -n "$NS" -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n')
fi

PATCHED_DEPLOYS=()

for deploy in "${TARGET_DEPLOYS[@]}"; do
  [ -z "$deploy" ] && continue

  deploy_json=$(kubectl get deploy -n "$NS" "$deploy" -o jsonpath='{.spec.template.spec.containers[*].image} {.spec.template.spec.containers[*].command} {.spec.template.spec.containers[*].args} {.spec.template.spec.containers[*].env}' 2>/dev/null || echo "")

  runtime="${3:-}"
  if [ -z "$runtime" ]; then
    runtime=$(detect_runtime "$deploy" "$deploy_json")
  fi

  case "$runtime" in
    java|dotnet|nodejs|python)
      echo "  [Auto-detected $runtime] Injecting OTel instrumentation into deploy/$deploy..."
      kubectl patch deploy -n "$NS" "$deploy" --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"instrumentation.opentelemetry.io/inject-${runtime}\":\"true\"}}}}}"
      PATCHED_DEPLOYS+=("$deploy")
      ;;
    go)
      echo "  [Auto-detected Go] Configuring standard OpenTelemetry endpoints for deploy/$deploy..."
      kubectl set env deploy/"$deploy" -n "$NS" \
        ENABLE_TRACING=1 \
        OTEL_SERVICE_NAME="$deploy" \
        COLLECTOR_SERVICE_ADDR="tempo.monitoring.svc.cluster.local:4317" \
        OTEL_EXPORTER_OTLP_ENDPOINT="http://tempo.monitoring.svc.cluster.local:4318" >/dev/null 2>&1 || true
      PATCHED_DEPLOYS+=("$deploy")
      ;;
    skip_loadgenerator)
      echo "  [Traffic Generator] Preserving native client engine for deploy/$deploy (traced via server & eBPF network flows)."
      ;;
    *)
      echo "  [Generic/Native] Service deploy/$deploy (traced automatically via Beyla eBPF)."
      ;;
  esac
done

echo ""
echo "=== OpenTelemetry Auto-Instrumentation successfully configured! ==="
if [ ${#PATCHED_DEPLOYS[@]} -gt 0 ]; then
  echo "Watching rollout of instrumented services..."
  for deploy in "${PATCHED_DEPLOYS[@]}"; do
    kubectl rollout status deploy/"$deploy" -n "$NS" --timeout=60s || true
  done
fi
