# KubeVision AI

Kubernetes-native observability with root-cause analysis: eBPF collection →
polyglot storage (Prometheus / Loki / Tempo) → ML anomaly detection → Go hub
serving a React UI.

## Run it

```bash
./scripts/setup.sh            # 1. k3s + observability stack (Prometheus/Loki/Tempo/OBI)
./scripts/demo-app.sh install # 2. boutique demo app (deployed unmodified)
./scripts/all.sh              # 3. port-forwards + backend + UI
```

Already have a cluster? Run `./scripts/setup.sh stack` to install just the stack.

Open **http://localhost:8090**. That's the whole product — backend, API and
UI in one process.

## Everyday

| Command | What |
|---|---|
| `./scripts/all.sh` | Start everything: k3s, pods, forwards, backend & UI |
| `./scripts/all.sh --dev` | Same, with Vite hot-reload (`:5173`) |
| `./scripts/all.sh stop` | Stop host processes, then k3s (`--keep-k3s` keeps the cluster) |
| `./scripts/all.sh restart` | Stop then start (safe; no recursion) |
| `./scripts/all.sh status` | End-to-end status of cluster, stack, forwards, and apps |
| `./scripts/dev-up.sh` | Bring host dev processes back (idempotent) |
| `./scripts/dev-up.sh reload` | Rebuild & restart backend + frontend (reloads code changes) |
| `./scripts/dev-up.sh reload --all` | Reload backend/frontend AND re-apply in-cluster configs |
| `./scripts/setup.sh stack` | Deploy/upgrade the eBPF-only observability stack |
| `./scripts/all.sh stack pause` / `resume` | Free RAM / restore the in-cluster stack (pause discards Prometheus/Tempo history) |
| `./scripts/all.sh stack disk` | View PVC usage, pod CPU/RAM, and retention settings |
| `./scripts/all.sh purge --yes` | Total purge: namespace, PVCs, and node disk (destructive) |
| `./scripts/demo-app.sh scale 0` / `status` | Pause / inspect the observed demo app |

After `./scripts/all.sh stack resume`, run `./scripts/dev-up.sh` to restore port-forwards.

Full runbook:
[scripts/README.md](scripts/README.md)

## In-cluster deployment configuration

The scripts above are for local development and the Boutique demo. An in-cluster
Helm deployment should configure the application with `OBSERVED_NAMESPACES` and
`OBSERVED_NAMESPACE`, provide `API_TOKEN` from a Kubernetes Secret, and grant
the backend service account `get`, `list`, and `watch` access to core Events in
each observed namespace. Production mode binds to `0.0.0.0` and refuses to
start without an API token of at least 32 characters. Cross-origin UI hosting
also requires an explicit `CORS_ALLOWED_ORIGINS` allowlist; same-origin hosting
does not.
