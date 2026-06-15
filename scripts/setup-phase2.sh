#!/bin/bash
set -e

echo "--- Creating monitoring namespace ---"
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

echo "--- Adding Helm Repositories ---"
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo add fluent https://fluent.github.io/helm-charts
helm repo update

echo "--- Installing kube-prometheus-stack ---"
# Alertmanager and Grafana are disabled to save resources (handled by KubeVision directly)
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false

echo "--- Installing Loki ---"
# Configured in Single Binary mode with local filesystem storage
helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  --set deploymentMode=SingleBinary \
  --set loki.auth_enabled=false \
  --set loki.commonConfig.replication_factor=1 \
  --set loki.storage.type=filesystem \
  --set singleBinary.replicas=1 \
  --set read.replicas=0 \
  --set write.replicas=0 \
  --set backend.replicas=0

echo "--- Installing Fluent Bit ---"
# Deployed with custom values to ship logs to Loki
helm upgrade --install fluent-bit fluent/fluent-bit \
  --namespace monitoring \
  -f deploy/k8s/collection/fluent-bit-values.yaml

echo "--- Deploying Grafana Beyla ---"
kubectl apply -f deploy/k8s/collection/beyla.yaml
