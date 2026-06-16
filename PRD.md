# KubeVision AI — Product Requirements Document

## 1. Overview

**KubeVision AI** is a Kubernetes-native observability and Root Cause Analysis platform. It watches any containerized application on any Kubernetes cluster, detects anomalies via a two-stage ML pipeline, and generates evidence-backed incident reports using LLM-powered agents.

**Key Principle:** Completely independent of the observed application. Zero code changes. Works with any K8s distribution.

---

## 2. Problem Statement

| # | Problem | Detail |
|---|---------|--------|
| 1 | Raw metrics don't explain cause | CPU, memory, network, storage, logs, events available separately but need manual correlation |
| 2 | Pods influence each other | Dependency mapping essential before RCA is meaningful |
| 3 | Bursts hide in short windows | Static thresholds are noisy or incomplete for transient spikes |
| 4 | Alert storms hide root cause | One failure creates downstream anomalies flooding operators |

---

## 3. Architecture (7 Phases)

**Collection** → **Evidence Storage** → **ML Detection** → **Gateway** → **RCA Agents** → **Backend Hub** → **Visualization**

### Collection Layer
| Collector | What | How |
|-----------|------|-----|
| Grafana Beyla | Endpoint metrics, protocol stats, service graph, distributed traces (OTLP) | eBPF DaemonSet |
| Fluent Bit | Pod logs with K8s metadata labels | DaemonSet |
| Kube-state-metrics | K8s object states (Pods, PV/PVC, Nodes, Events) | Deployment |

### Evidence Layer (Polyglot Storage)
| Store | Data |
|-------|------|
| Prometheus | Metrics from Beyla (latency, error rate, throughput), K8s objects (PV/PVC, Pods), and protocol stats. |
| Loki | Searchable pod logs with indexed K8s metadata. |
| Grafana Tempo | Distributed traces (OTLP), spans, per-hop latency, and protocol details. |
| BadgerDB | System configuration, anomaly events, RCA reports,  forecasts and historical baseline stats (embedded in Go backend). |

### ML Detection (Python)
- **Stage 1:** Isolation Forest — fast anomaly screening (score > 0.75)
- **Confidence gate:** Score > 0.92 fast-tracks past LSTM
- **Stage 2:** LSTM Autoencoder — temporal verification (reconstruction error z-score)
- **Parallel:** Prophet forecasting (CronJob, every 5–15 min)

### Go Backend Hub
- **Aggregation:** Consolidates data from Prometheus, Loki, Tempo, and K8s API.
- **Persistence:** Uses embedded BadgerDB for state, configuration, and incident history.
- **Service Logic:** Manages historical baselines and proxies tracing/metric queries to the UI.

### Go Anomaly Gateway
Validate → Deduplicate (Redis TTL) → Rate-limit → Prioritize → Push to Redis Stream.

### LangGraph Agents (Hybrid Supervisor)
- Orchestrator fans out to 4 parallel subagents (Metrics, Log, K8s Event, Network).
- Reflection gate checks evidence sufficiency (3/4 types → proceed).
- RCA Generator with self-validation.
- LLM: Multi-provider, user-configurable (OpenAI/Gemini/Groq/Ollama).

### Dashboard (React + Tailwind)
- **Configuration Management:** UI for user settings and system flexibility.
- **Live Dependency Graph:** Real-time visualization of service relationships with request rates, error rates, and throughput.
- **Service & Endpoint Explorer:** Detailed stats and performance history per endpoint.
- **Trace Waterfall Viewer:** Deep-dive into specific request paths with per-hop protocol stats and historical comparison.
- **Infrastructure View:** Real-time status for K8s objects (PV/PVC, Nodes, Cluster Info).

---

## 4. Technology Stack

| Layer | Technology | Language |
|-------|-----------|----------|
| Collection | Grafana Beyla (eBPF) | Go |
| Logs | Fluent Bit → Loki | C / Go |
| Metrics | Prometheus | Go |
| Traces | Grafana Tempo | Go |
| ML | scikit-learn (IF) + PyTorch (LSTM) + Prophet | Python |
| Gateway | Custom Go service | Go |
| Queue | Redis Streams + KEDA | C / Go |
| Agents | LangGraph (Hybrid Supervisor) | Python |
| Backend | Go + embedded BadgerDB | Go |
| Dashboard | React + Tailwind + React Flow | TypeScript |

---

## 5. Non-Goals
- Does NOT modify observed applications.
- Does NOT auto-remediate (recommends actions only).
- Does NOT require specific CNI or service mesh.
- Does NOT require sidecar injection.
