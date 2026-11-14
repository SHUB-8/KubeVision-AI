# KubeVision AI — Frontend

React 19 + TypeScript + Vite 8 + Tailwind 4 dashboard for the KubeVision AI hub.

## Run

The normal path is from the repo root — the scripts build this app and let the Go hub serve it:

```bash
./scripts/all.sh          # build UI + backend, serve on http://localhost:8090
./scripts/all.sh --dev    # Vite hot-reload on http://localhost:5173
```

Standalone (expects the API on `localhost:8090`; override with `VITE_API_TARGET`):

```bash
npm ci
npm run dev     # vite dev server on :5173, proxies /api
npm run build   # tsc -b && vite build -> dist/
npm run lint    # oxlint
```

## Layout

| Path | What |
|---|---|
| `src/components/<feature>/` | One folder per view: topology, services, traces, logs, events, cluster, incidents, settings |
| `src/components/common/`, `layout/` | Shared primitives and the app shell (header, nav, toasts) |
| `src/services/api.ts` | The only module that speaks HTTP |
| `src/context/AppContext.tsx` | Shell state: tab, namespace, window, refresh, toasts |
| `src/types/api.ts` | TypeScript mirror of the backend contract |
| `src/lib/` | Pure helpers (formatting, trace maths) |

Design system: [`design.md`](design.md) plus the tokens in `src/index.css`.

## Status

The Incidents / RCA view is a placeholder; the ML detection and RCA pipeline is planned, not
implemented. See `PRD.md` at the repo root for the target product.
