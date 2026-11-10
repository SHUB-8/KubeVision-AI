# KubeVision dev scripts — runbook

Cluster + stack lifecycle for the single-node k3s dev box. Run from repo root.

**Four scripts, one job each** (this replaced the old seven: `stack.sh`,
`cleanup-monitoring.sh`, `setup-phase1.sh` and `setup-phase2.sh` are gone —
their features now live in `setup.sh` and `all.sh`).

| Script | Owns | When to run |
|---|---|---|
| `setup.sh` | One-time: host prereqs, k3s cluster, observability stack | Once per machine (or `setup.sh stack` on an existing cluster) |
| `all.sh` | Everything daily: lifecycle, port-forwards, backend, UI, in-cluster stack operations, purge | Every session |
| `dev-up.sh` | Host dev processes only: port-forwards, backend, Vite, reload | While coding |
| `demo-app.sh` | The observed demo app (`ns/boutique`) | Demo setup / pause / cleanup |

## Quickstart — fresh machine

```bash
./scripts/setup.sh            # 1. k3s + observability stack (Prometheus/Loki/Tempo/OBI/Fluent Bit)
./scripts/demo-app.sh install # 2. boutique demo app (deployed unmodified — no SDK, no sidecars)
./scripts/all.sh              # 3. port-forwards + backend + UI
```

Then open **http://localhost:8090** — that's the whole product.

Already have a cluster? Skip the k3s bootstrap:

```bash
./scripts/setup.sh stack
```

Reproducibility: chart/k3s versions are unpinned by default. Pin them with env
vars before running `setup.sh`:

```bash
K3S_VERSION=v1.31.5+k3s1 \
CHART_KUBE_PROMETHEUS_VERSION=91.8.2 \
CHART_LOKI_VERSION=7.3.0 \
CHART_FLUENT_BIT_VERSION=0.49.1 \
./scripts/setup.sh
```

## Day-to-day

```bash
./scripts/all.sh                  # Start everything (k3s, pods, forwards, backend, UI)
./scripts/all.sh --dev            # Same, with Vite hot-reload on :5173
./scripts/all.sh stop             # Stop host processes, then k3s
./scripts/all.sh stop --keep-k3s  # Stop host processes, keep cluster + stack running
./scripts/all.sh restart          # Stop then start (safe; no recursion)
./scripts/all.sh status           # Health of k3s, stack, forwards, backend, UI

./scripts/dev-up.sh               # Bring up host processes only (idempotent)
./scripts/dev-up.sh --dev         # Vite hot-reload instead of the built UI
./scripts/dev-up.sh reload        # Rebuild & restart backend + frontend
./scripts/dev-up.sh reload --all  # Reload host AND re-apply in-cluster manifests
./scripts/dev-up.sh stop          # Stop backend, vite, port-forwards
./scripts/dev-up.sh status        # Backend/forward/pod status

./scripts/demo-app.sh status      # Demo app pods
./scripts/demo-app.sh scale 0     # Pause the demo (stops loadgen traffic)
./scripts/demo-app.sh scale 1     # Resume the demo
```

### In-cluster stack operations (formerly `stack.sh` / `cleanup-monitoring.sh`)

```bash
./scripts/all.sh stack status      # Pods, DaemonSets, StatefulSets in ns/monitoring
./scripts/all.sh stack disk        # Disk usage, PVCs, retention settings
./scripts/all.sh stack pause       # Free RAM: scale stores to 0, remove DaemonSets
./scripts/all.sh stack resume      # Restore stores and DaemonSets
./scripts/all.sh stack nuke        # Delete Prometheus/Tempo pods (wipes their emptyDir)
./scripts/all.sh stack nuke-loki   # Wipe the Loki PVC (fresh PVC on restart)
./scripts/all.sh purge --yes       # Total purge: namespace, all PVCs, node disk
```

⚠️ **`stack pause` discards data.** Prometheus and Tempo run on `emptyDir` in
this dev setup, so scaling their pods to 0 deletes their history. Loki uses a
PVC and is unaffected. `pause` prints this warning; use it deliberately.

⚠️ **`purge` is destructive and non-interactive-safe.** It refuses to run when
stdin is not a TTY unless you pass `--yes`; with a TTY it asks first. It deletes
the `monitoring` namespace, all PVCs, and the k3s local-path directories.

## Who owns what (boundaries)

- **`all.sh`** is the single entry point. `start` = k3s + pods + forwards +
  backend + UI; `stop` = host processes then k3s (add `--keep-k3s` to leave the
  cluster running). It does **not** install the stack — that is `setup.sh`.
- **`dev-up.sh`** is the only script that assumes the cluster is already up. It
  never installs or deletes in-cluster resources except via `reload --all`,
  which delegates to `setup.sh stack`.
- **`demo-app.sh`** only touches `ns/boutique`; it never touches `monitoring`.
- **`setup.sh`** is the only script that installs/upgrades Helm charts,
  cluster-scoped CRDs, or k3s itself.

Common questions:

- **Does `all.sh stop` wipe data?** No, it stops host processes and k3s; pods
  keep their `emptyDir` dirs across a k3s restart. Only `stack pause/nuke` and
  `purge` delete pods or volumes, which does wipe data.
- **Does `stack pause` stop the backend/UI?** No. Those are host processes; use
  `all.sh stop` or `dev-up.sh stop`.
- **Does `stack pause` touch the demo app?** No. Use `demo-app.sh scale 0`.
- **Code change vs manifest change?** Go/React → `dev-up.sh reload`. Helm values
  or collection YAML → `dev-up.sh reload --all` or `setup.sh stack`.

## Where configuration lives

- **Helm values** (charts): `deploy/helm/{prometheus,loki,fluent-bit}-values.yaml`
  — retention, storage mode, caches. Edit + re-run `./scripts/setup.sh stack`.
- **Raw manifests** (no chart): `deploy/k8s/collection/{beyla,tempo}-*.yaml` —
  one Kubernetes resource per file (`<app>-<kind>.yaml`: tempo
  configmap/deployment/service; beyla
  serviceaccount/clusterrole/clusterrolebinding/configmap/service/servicemonitor/daemonset).
  Edit + `kubectl apply -f <file>` (or `./scripts/setup.sh stack`).
- **Backend env vars** (when running locally): `PORT`, `PROMETHEUS_URL`,
  `LOKI_URL`, `TEMPO_URL`, `DB_PATH`, `OBSERVED_NAMESPACE` (default `boutique`),
  `OBSERVED_NAMESPACES` (comma-separated namespace allowlist; the selected
  default must be included), `FRONTEND_DIR`. The scripts forward `PORT` and
  `DB_PATH` from your shell if set.
- `KUBEVISION_MODE=development` is used by the local scripts. In-cluster mode
  defaults to `production`, requires `API_TOKEN` (at least 32 characters), and
  binds to `0.0.0.0`; local development binds to `127.0.0.1`. `LISTEN_HOST` can
  override the bind host.
- `CORS_ALLOWED_ORIGINS` is a comma-separated exact-origin allowlist for a
  separately hosted UI. Same-origin hosting needs no CORS entry. Mutation
  requests require the configured bearer token.
- The Warning Events informer upserts on both add and update, retaining the
  latest event state for seven days. An in-cluster Helm deployment must grant
  the backend ServiceAccount `get`, `list`, and `watch` on core `events` in each
  configured observed namespace.

The local scripts remain demo/development tooling. A future Helm chart should
own production defaults, Secret wiring, namespace selection, and scoped Event
RBAC rather than relying on the scripts.

## Conventions

- All scripts use `set -euo pipefail`, run from the repo root, and log to
  stderr on failure.
- Process state is tracked in `.run/` (gitignored): `backend.pid`,
  `frontend.pid`, `port-forward-<port>.pid`, `*.log`.
- `all.sh` and `dev-up.sh` only kill processes they own (PID files) or the exact
  port-forward/vite patterns for this repo; they do not `pkill` unrelated
  processes.

## When you're done for the day

```bash
./scripts/all.sh stop          # full teardown (host processes + k3s)
# or
sudo systemctl stop k3s        # frees everything; PVCs + manifests survive
sudo systemctl start k3s       # pods come back on their own
```
