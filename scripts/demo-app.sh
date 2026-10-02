#!/bin/bash
# ==============================================================================
# KubeVision AI — Observed Demo Application (Google microservices-demo)
#
# Manages the boutique demo workload in ns/boutique.
# Calls scripts/setup.sh --instrument to automatically apply OpenTelemetry instrumentation.
#
# Usage:
#   scripts/demo-app.sh install        # deploy boutique + auto-instrument via setup.sh --instrument
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

case "${1:-}" in
  install)
    echo "--- Ensuring namespace ns/$NS exists ---"
    kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -

    echo "--- Applying microservices-demo to ns/$NS ---"
    kubectl apply -n "$NS" -f "$MANIFEST_URL"

    echo "--- Waiting for frontend service to be ready ---"
    kubectl -n "$NS" rollout status deploy/frontend --timeout=300s

    echo "--- Enabling OpenTelemetry Auto-Instrumentation ---"
    ./scripts/setup.sh --instrument "$NS"

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
    ./scripts/setup.sh --instrument "$NS"
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
