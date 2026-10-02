# KubeVision dev scripts — runbook

Cluster + stack lifecycle for the single-node k3s dev box. Run from repo root.

## Quickstart — running everything

Fresh machine, three commands, in order:

```bash
./scripts/setup.sh            # 1. k3s cluster + observability stack + OTel operator (idempotent)
./scripts/demo-app.sh install  # 2. boutique demo app + OpenTelemetry auto-instrumentation
./scripts/dev-up.sh           # 3. port-forwards + backend + UI
```

Then open **http://localhost:8090** — that's the whole product.

## Day-to-day

```bash
./scripts/dev-up.sh              # Start dev environment (safe to re-run)
./scripts/dev-up.sh --dev        # Start with Vite hot-reload dev server (:5173)
./scripts/dev-up.sh reload       # Rebuild & restart backend + frontend (reloads code changes)
./scripts/dev-up.sh reload --all # Reload host AND re-apply in-cluster configs to update pods
./scripts/dev-up.sh status       # Status of backend, forwards, and cluster pods
./scripts/dev-up.sh stop         # Stop backend, vite, and port-forwards

./scripts/setup.sh --instrument [ns]    # Auto-instrument ANY namespace with OpenTelemetry
./scripts/setup.sh --instrument ns svc  # Auto-instrument specific deployment

./scripts/stack.sh pause         # End of day: free ~2-4GB RAM (scales stores to 0, removes DSes)
./scripts/stack.sh resume        # Resume monitoring stores and DaemonSets
./scripts/stack.sh status        # Inspect workloads in ns/monitoring
./scripts/stack.sh disk          # Inspect node disk, PVCs, pod CPU/RAM, and retention settings
./scripts/stack.sh nuke          # Emergency: restart stores and wipe emptyDir data

./scripts/demo-app.sh scale 0    # Pause the demo app itself (loadgen traffic stops)
./scripts/demo-app.sh scale 1    # Resume demo app
./scripts/demo-app.sh status     # Check demo app pods
```

## Who owns what (boundaries)

| Layer | Script | Description |
|---|---|---|
| Cluster, Observability & Telemetry | `setup.sh` | Bootstraps k3s, deploys stores (Prometheus/Loki/Tempo/Beyla/FluentBit/OTel), and instruments namespaces |
| Observed Sample App | `demo-app.sh` | Manages ns/boutique workload and delegates OTel setup to `setup.sh --instrument` |
| In-cluster Stack Lifecycle | `stack.sh` | Pause/resume RAM, disk usage, and data cleanup for ns/monitoring |
| Host Dev Processes | `dev-up.sh` | **The only script that runs host processes** (port-forwards, Go backend, Vite/UI) |

Common questions, answered explicitly:

- **`stack.sh pause` does not run the backend or the UI.** It only scales the
  monitoring stores in-cluster. Your local backend, port-forwards and vite
  are host processes — only `dev-up.sh` starts/stops those.
- **`stack.sh pause` does not touch boutique** (the observed app). Pause that
  separately with `scripts/demo-app.sh scale 0`.
- `dev-up.sh` checks if in-cluster stores are running; if missing, it delegates
  to `setup.sh --stack`.
- **Reloading code vs pods**:
  - Code changes in Go or React? Run `./scripts/dev-up.sh reload` (or use `./scripts/dev-up.sh --dev` for Vite live HMR).
  - Helm values or collection YAML changes? Run `./scripts/dev-up.sh reload --all` or `./scripts/setup.sh --stack`.

## Where configuration lives

- **Helm values** (charts): `deploy/helm/{prometheus,loki,fluent-bit}-values.yaml` — retention, storage mode, caches. Edit + re-run `./scripts/setup.sh --stack`.
- **Raw manifests** (no chart): `deploy/k8s/collection/{tempo,beyla}.yaml` — Tempo config, Beyla privileges/env. Edit + `kubectl apply -f` (or `./scripts/setup.sh --stack`).
- **Backend env vars** (when running locally): `PORT`, `PROMETHEUS_URL`, `LOKI_URL`, `TEMPO_URL`, `DB_PATH`, `OBSERVED_NAMESPACE` (default `boutique`), `FRONTEND_DIR`.

## When you're done for the day

```bash
sudo systemctl stop k3s      # frees everything; PVCs + manifests survive
sudo systemctl start k3s     # pods come back on their own
```
