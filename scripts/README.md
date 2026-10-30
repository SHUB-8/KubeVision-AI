# KubeVision dev scripts — runbook

Cluster + stack lifecycle for the single-node k3s dev box. Run from repo root.

## Quickstart — running everything

Fresh machine, four commands, in order:

```bash
./scripts/setup-phase1.sh     # 1. k3s cluster bootstrap (skip if you already have a cluster)
./scripts/setup-phase2.sh     # 2. observability stack (Prometheus/Loki/Tempo/Beyla/FluentBit) — eBPF-only
./scripts/demo-app.sh install # 3. boutique demo app (deployed unmodified — no SDK, no sidecars)
./scripts/dev-up.sh           # 4. port-forwards + backend + UI
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

./scripts/stack.sh pause         # End of day: free ~2-4GB RAM (scales stores to 0, removes DSes)
./scripts/stack.sh resume        # Resume monitoring stores and DaemonSets
./scripts/stack.sh status        # Inspect workloads in ns/monitoring
./scripts/stack.sh nuke          # Emergency: restart stores and wipe emptyDir data
./scripts/stack.sh nuke-loki     # Wipe Loki PVC data (restarts with fresh PVC)
./scripts/stack.sh purge         # Total purge: delete namespace, all PVCs, and node disk
./scripts/cleanup-monitoring.sh  # Standalone total purge script (-y to skip prompt)

./scripts/demo-app.sh scale 0    # Pause the demo app itself (loadgen traffic stops)
./scripts/demo-app.sh scale 1    # Resume demo app
./scripts/demo-app.sh status     # Check demo app pods
```

## Who owns what (boundaries)

| Layer | Script | Description |
|---|---|---|
| Cluster Infrastructure | `setup-phase1.sh` | Bootstraps k3s cluster (run once per machine; skip if you already have a cluster) |
| Observability Stack & Telemetry | `setup-phase2.sh` | Deploys stores (Prometheus/Loki/Tempo/Beyla/FluentBit); eBPF-only collection — no SDK injection, no sidecars |
| Observed Sample App | `demo-app.sh` | Manages ns/boutique workload; deployed unmodified (Beyla observes it from the node) |
| In-cluster Stack Lifecycle | `stack.sh` | Pause/resume RAM, disk usage, and data cleanup for ns/monitoring |
| Host Dev Processes | `dev-up.sh` | **The only script that runs host processes** (port-forwards, Go backend, Vite/UI) |

Common questions, answered explicitly:

- **`stack.sh pause` does not run the backend or the UI.** It only scales the
  monitoring stores in-cluster. Your local backend, port-forwards and vite
  are host processes — only `dev-up.sh` starts/stops those.
- **`stack.sh pause` does not touch boutique** (the observed app). Pause that
  separately with `scripts/demo-app.sh scale 0`.
- `dev-up.sh` checks if in-cluster stores are running; if missing, it delegates
  to `setup-phase2.sh`.
- **Reloading code vs pods**:
  - Code changes in Go or React? Run `./scripts/dev-up.sh reload` (or use `./scripts/dev-up.sh --dev` for Vite live HMR).
  - Helm values or collection YAML changes? Run `./scripts/dev-up.sh reload --all` or `./scripts/setup-phase2.sh`.

## Where configuration lives

- **Helm values** (charts): `deploy/helm/{prometheus,loki,fluent-bit}-values.yaml` — retention, storage mode, caches. Edit + re-run `./scripts/setup-phase2.sh`.
- **Raw manifests** (no chart): `deploy/k8s/collection/{tempo,beyla}.yaml` — Tempo config, Beyla privileges/env. Edit + `kubectl apply -f` (or `./scripts/setup-phase2.sh`).
- **Backend env vars** (when running locally): `PORT`, `PROMETHEUS_URL`, `LOKI_URL`, `TEMPO_URL`, `DB_PATH`, `OBSERVED_NAMESPACE` (default `boutique`), `OBSERVED_NAMESPACES` (comma-separated namespace allowlist; the selected default must be included), `FRONTEND_DIR`.
- `KUBEVISION_MODE=development` is used by the local scripts. In-cluster mode defaults to `production`, requires `API_TOKEN` (at least 32 characters), and binds to `0.0.0.0`; local development binds to `127.0.0.1`. `LISTEN_HOST` can override the bind host.
- `CORS_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist for a separately hosted UI. Same-origin hosting needs no CORS entry. Mutation requests require the configured bearer token.
- The Warning Events informer upserts on both add and update, retaining the latest event state for seven days. An in-cluster Helm deployment must grant the backend ServiceAccount `get`, `list`, and `watch` on core `events` in each configured observed namespace.

The local scripts remain demo/development tooling. A future Helm chart should
own production defaults, Secret wiring, namespace selection, and scoped Event
RBAC rather than relying on the scripts.

## When you're done for the day

```bash
sudo systemctl stop k3s      # frees everything; PVCs + manifests survive
sudo systemctl start k3s     # pods come back on their own
```
