#!/bin/bash
# Phase 1 — bootstrap a single-node k3s cluster for KubeVision development.
# Afterwards run scripts/setup-phase2.sh to install the observability stack.
set -euo pipefail

# k3s install options:
#   --write-kubeconfig-mode 644 : use kubectl/helm without sudo
#   --disable traefik           : ingress not needed (port-forward for dev)
#   --disable servicelb         : no LoadBalancer services in this setup, saves RAM
if ! command -v k3s >/dev/null 2>&1; then
  echo "--- Installing k3s ---"
  curl -sfL https://get.k3s.io | sh -s - server \
    --write-kubeconfig-mode 644 \
    --disable traefik \
    --disable servicelb
else
  echo "--- k3s already installed, skipping ---"
fi

echo "--- Making kubeconfig available to kubectl/helm ---"
if [ ! -f "$HOME/.kube/config" ]; then
  mkdir -p "$HOME/.kube"
  sudo cat /etc/rancher/k3s/k3s.yaml > "$HOME/.kube/config"
  chmod 600 "$HOME/.kube/config"
fi
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"

echo "--- Waiting for node to become Ready ---"
sudo -E kubectl wait --for=condition=Ready node --all --timeout=300s

echo "--- eBPF (Beyla) prerequisites check ---"
echo "Kernel: $(uname -r) (Beyla needs a recent kernel with BPF enabled)"
if [ -f /sys/firmware/efi/efivars ] && mokutil --sb-state 2>/dev/null | grep -qi "enabled"; then
  echo "WARNING: Secure Boot is enabled - eBPF will fail unless the programs are signed"
fi

kubectl get nodes
echo "Cluster ready. Now run: ./scripts/setup-phase2.sh"
