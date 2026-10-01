#!/bin/bash
# The OBSERVED APPLICATION (Google microservices-demo, "boutique" namespace).
#
# This is the app KubeVision watches - NOT part of the observability stack.
# setup-phase1/2, pause.sh and cleanup.sh never touch it. This script is the
# only place that manages it.
#
#   scripts/demo-app.sh install        apply the demo to ns/boutique
#   scripts/demo-app.sh status         pod summary
#   scripts/demo-app.sh scale 0        pause the demo (frees ~1.5GB RAM; stops loadgen)
#   scripts/demo-app.sh scale 1        resume all 11 microservices + loadgen
#   scripts/demo-app.sh port-forward   access storefront on http://localhost:8080
#   scripts/demo-app.sh delete         remove the namespace entirely
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

    echo ""
    echo "Demo app is up! Loadgenerator is generating traffic."
    echo "View pods with:        ./scripts/demo-app.sh status"
    echo "Open in browser with:  ./scripts/demo-app.sh port-forward"
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

  *)
    echo "usage: $0 {install|status|scale 0|1|port-forward|delete}"
    exit 1
    ;;
esac
