#!/bin/bash
# The OBSERVED APPLICATION (Google microservices-demo, "boutique" namespace).
#
# This is the app KubeVision watches - NOT part of the observability stack.
# setup-phase1/2, pause.sh and cleanup.sh never touch it. This script is the
# only place that manages it.
#
#   scripts/demo-app.sh install   apply the demo (pinned upstream release)
#   scripts/demo-app.sh status    pod summary
#   scripts/demo-app.sh scale 0   pause the demo (frees RAM; loadgen stops)
#   scripts/demo-app.sh scale 1   resume
#   scripts/demo-app.sh delete    remove the namespace entirely
#
# PIN to a release; a floating "main" ref made this drift once already.
set -euo pipefail
cd "$(dirname "$0")/.."

NS=boutique
MANIFEST_URL="${BOUTIQUE_MANIFEST_URL:-https://raw.githubusercontent.com/GoogleCloudPlatform/microservices-demo/v2.8.0/release/google-store.yaml}"

case "${1:-}" in
  install)
    echo "--- Applying microservices-demo (observed app) to ns/$NS ---"
    kubectl apply -f "$MANIFEST_URL"
    kubectl -n "$NS" rollout status deploy/frontend --timeout=300s
    echo "Demo app up. Loadgenerator is driving traffic."
    ;;
  status)
    kubectl -n "$NS" get deploy,pods 2>/dev/null || echo "namespace $NS not found - run: $0 install"
    ;;
  scale)
    [ "${2:-}" ] || { echo "usage: $0 scale {0|1}"; exit 1; }
    kubectl -n "$NS" scale deploy --all --replicas="$2"
    ;;
  delete)
    kubectl delete namespace "$NS" --ignore-not-found
    ;;
  *)
    echo "usage: $0 {install|status|scale 0|1|delete}"
    exit 1
    ;;
esac
