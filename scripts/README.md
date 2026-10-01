# KubeVision dev scripts — runbook

Cluster + stack lifecycle for the single-node k3s dev box. Run from repo root.

| Order | Script | What it does |
|---|---|---|
| 1 | `./scripts/setup-phase1.sh` | Bootstrap k3s (once per machine) |
| 2 | `./scripts/setup-phase2.sh` | Install/upgrade the observability stack (Prometheus, Loki, Fluent Bit via Helm values files in `deploy/helm/`; Tempo + Beyla via raw manifests in `deploy/k8s/collection/`) |

## Day-to-day

```bash
./scripts/pause.sh stop      # free ~2-4GB RAM: scale stores to 0, remove DaemonSets
./scripts/pause.sh start     # bring the stack back
./scripts/pause.sh status    # what's running

./scripts/cleanup.sh         # disk usage per store + retention audit
./scripts/cleanup.sh --nuke  # emergency: restart stores, wipes emptyDir data
```

## Where configuration lives

- **Helm values** (charts): `deploy/helm/{prometheus,loki,fluent-bit}-values.yaml` — retention, storage mode, caches. Edit + re-run `setup-phase2.sh`.
- **Raw manifests** (no chart): `deploy/k8s/collection/{tempo,beyla}.yaml` — Tempo config, Beyla privileges/env. Edit + `kubectl apply -f`.
- **Backend env vars** (when running locally): `PORT`, `PROMETHEUS_URL`, `LOKI_URL`, `TEMPO_URL`, `DB_PATH`, `OBSERVED_NAMESPACE` (namespace of the observed app; default `boutique`), `FRONTEND_DIR`.

## When you're done for the day

```bash
sudo systemctl stop k3s      # frees everything; PVCs + manifests survive
sudo systemctl start k3s     # pods come back on their own
```

## Dev port-forwards (local backend only)

The Go backend running on your machine reaches the stores through localhost
port-forwards. `pause.sh stop` kills them with the pods; `start` does NOT
bring them back. After resuming, re-run:

```bash
kubectl -n monitoring port-forward svc/prometheus-kube-prometheus-prometheus 9090:9090 &
kubectl -n monitoring port-forward svc/loki-gateway 3100:80 &
kubectl -n monitoring port-forward svc/tempo 3200:3200 &
```

Symptom when forgotten: the status bar shows Prometheus/Loki/Tempo as
disconnected. Verify with `curl localhost:8090/api/v1/health`.
