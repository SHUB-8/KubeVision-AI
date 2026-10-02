# KubeVision AI

Kubernetes-native observability with root-cause analysis: eBPF collection →
polyglot storage (Prometheus / Loki / Tempo) → ML anomaly detection → Go hub
serving a React UI.

## Run it

```bash
./scripts/setup.sh            # 1. k3s cluster + observability stack + OTel operator (idempotent)
./scripts/demo-app.sh install  # 2. boutique demo app + auto-instrumentation
./scripts/dev-up.sh           # 3. port-forwards + backend + UI
```

Open **http://localhost:8090**. That's the whole product — backend, API and
UI in one process.

## Everyday

| Command | What |
|---|---|
| `./scripts/dev-up.sh` | Bring the dev environment back (idempotent) |
| `./scripts/dev-up.sh --dev` | Vite hot-reload instead of built UI (`:5173`) |
| `./scripts/dev-up.sh reload` | Rebuild & restart backend + frontend (reloads code changes) |
| `./scripts/dev-up.sh reload --all` | Reload backend/frontend AND re-apply in-cluster configs to update pods |
| `./scripts/dev-up.sh status` | Health status of backend, forwards, and cluster pods |
| `./scripts/dev-up.sh stop` | Stop host dev processes |
| `./scripts/setup.sh --instrument <ns>` | Auto-instrument any namespace with OpenTelemetry |
| `./scripts/stack.sh pause` / `resume` | Free (~2-4GB RAM) / restore in-cluster monitoring stack |
| `./scripts/stack.sh disk` | View PVC usage, pod CPU/RAM, and retention settings |
| `./scripts/demo-app.sh scale 0` / `status` | Pause / inspect the observed demo app |

After `./scripts/stack.sh resume`, run `./scripts/dev-up.sh` to restore port-forwards.

Full runbook:
[scripts/README.md](scripts/README.md)
