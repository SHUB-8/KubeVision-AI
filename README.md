# KubeVision AI

Kubernetes-native observability with root-cause analysis: eBPF collection →
polyglot storage (Prometheus / Loki / Tempo) → ML anomaly detection → Go hub
serving a React UI.

## Run it

```bash
./scripts/setup-phase1.sh        # 1. k3s cluster            (once per machine)
./scripts/setup-phase2.sh        # 2. observability stack    (Prometheus/Loki/Tempo/Beyla/FluentBit)
./scripts/demo-app.sh install    # 3. boutique demo app      (the observed workload)
./scripts/dev-up.sh              # 4. port-forwards + backend + UI
```

Open **http://localhost:8090**. That's the whole product — backend, API and
UI in one process.

## Everyday

| Command | What |
|---|---|
| `./scripts/dev-up.sh` | bring the dev environment back (idempotent) |
| `./scripts/dev-up.sh --dev` | vite hot-reload instead of the built UI |
| `./scripts/pause.sh stop` / `start` | free / restore cluster RAM (monitoring stack only) |
| `./scripts/demo-app.sh scale 0` / `status` | pause / inspect the demo app |
| `./scripts/cleanup.sh` | disk usage + retention report |

After `pause.sh start`, re-run `dev-up.sh` — pausing kills the port-forwards.

Full runbook with the ownership map of every script:
[scripts/README.md](scripts/README.md)
