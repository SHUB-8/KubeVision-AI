#!/bin/bash
# ==============================================================================
# KubeVision AI — Observed Demo Application (Google microservices-demo)
#
# Manages the boutique demo workload in ns/boutique, including OpenTelemetry
# auto-instrumentation and context propagation.
#
# Usage:
#   scripts/demo-app.sh install        # deploy boutique + auto-detect & configure OpenTelemetry
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

  local target_deploys=()
  mapfile -t target_deploys < <(kubectl get deploy -n "$NS" -o jsonpath='{.items[*].metadata.name}' | tr ' ' '\n')

  local patched_deploys=()

  for deploy in "${target_deploys[@]}"; do
    [ -z "$deploy" ] && continue

    local deploy_json
    deploy_json=$(kubectl get deploy -n "$NS" "$deploy" -o jsonpath='{.spec.template.spec.containers[*].image} {.spec.template.spec.containers[*].command} {.spec.template.spec.containers[*].args} {.spec.template.spec.containers[*].env}' 2>/dev/null || echo "")

    local runtime
    runtime=$(detect_runtime "$deploy" "$deploy_json")

    case "$runtime" in
      java|dotnet|nodejs|python)
        echo "  [Auto-detected $runtime] Injecting OTel instrumentation into deploy/$deploy..."
        kubectl patch deploy -n "$NS" "$deploy" --type=merge -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"instrumentation.opentelemetry.io/inject-${runtime}\":\"true\"}}}}}"
        patched_deploys+=("$deploy")
        ;;
      go)
        echo "  [Auto-detected Go] Configuring standard OpenTelemetry endpoints for deploy/$deploy..."
        kubectl set env deploy/"$deploy" -n "$NS" \
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

  echo ""
  echo "=== OpenTelemetry Auto-Instrumentation successfully configured! ==="
  if [ ${#patched_deploys[@]} -gt 0 ]; then
    echo "Watching rollout of instrumented services..."
    for deploy in "${patched_deploys[@]}"; do
      kubectl rollout status deploy/"$deploy" -n "$NS" --timeout=60s || true
    done
  fi
}

case "${1:-}" in
  install)
    echo "--- Ensuring namespace ns/$NS exists ---"
    kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

    echo "--- Applying microservices-demo to ns/$NS ---"
    kubectl apply -n "$NS" -f "$MANIFEST_URL"

    echo "--- Waiting for frontend service to be ready ---"
    kubectl -n "$NS" rollout status deploy/frontend --timeout=300s

    # Automatically apply dynamic OTel instrumentation
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
