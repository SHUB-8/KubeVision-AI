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

**Collection** → **Evidence Storage** → **ML Detection** → **Gateway** → **RCA Agents** → **Backend** → **Dashboard**

### Collection Layer
| Collector | What | How |
|-----------|------|-----|
| Grafana Beyla | Endpoint metrics, protocol stats, service graph, distributed traces | eBPF DaemonSet, ~50MB |
| Fluent Bit | Pod logs with namespace/workload labels | DaemonSet |
| K8s API Watcher | Pods, PVCs, rollouts, restarts, events | Go client-go |

### Evidence Layer
| Store | Data |
|-------|------|
| Prometheus | Metrics from Beyla (latency, error rate, CPU, memory, PVC, service graph) |
| Loki | Searchable pod logs |
| BadgerDB | Anomaly records, RCA reports, forecasts (embedded in Go backend) |

### ML Detection (Python)
- **Stage 1:** Isolation Forest — fast anomaly screening (score > 0.75)
- **Confidence gate:** Score > 0.92 fast-tracks past LSTM
- **Stage 2:** LSTM Autoencoder — temporal verification (reconstruction error z-score)
- **Parallel:** Prophet forecasting (CronJob, every 5–15 min)

### Go Anomaly Gateway
Validate → Deduplicate (Redis TTL) → Rate-limit → Prioritize → Push to Redis Stream

### LangGraph Agents (Hybrid Supervisor)
- Orchestrator fans out to 4 parallel subagents (Metrics, Log, K8s Event, Network)
- Reflection gate checks evidence sufficiency (3/4 types → proceed)
- RCA Generator with self-validation
- LLM: Multi-provider, user-configurable (OpenAI/Gemini/Groq/Ollama)

### Dashboard (Next.js)
Cluster overview, service list, service detail, dependency graph, anomaly timeline, RCA reports, forecasts, settings

---

## 4. Technology Stack

| Layer | Technology | Language |
|-------|-----------|----------|
| Collection | Grafana Beyla (eBPF) | Go |
| Logs | Fluent Bit → Loki | C / Go |
| Metrics | Prometheus | Go |
| ML | scikit-learn (IF) + PyTorch (LSTM) + Prophet | Python |
| Gateway | Custom Go service | Go |
| Queue | Redis Streams + KEDA | C / Go |
| Agents | LangGraph (Hybrid Supervisor) | Python |
| Backend | Go + embedded BadgerDB | Go |
| Dashboard | Next.js (React) | TypeScript |

---

## 5. Distributed Tracing
Beyla auto-injects W3C `traceparent` headers at kernel level. Complete request traces across services with zero code changes. Latency attribution per hop.

## 6. Dependency Graph
Built from: Beyla service graph metrics (L7 eBPF) + K8s API topology + OTel traces.

## 7. Resource Budget
~10 pods, ~1.1GB RAM at baseline (single node).

## 8. Non-Goals
- Does NOT modify observed applications
- Does NOT auto-remediate (recommends actions only)
- Does NOT replace Grafana/Datadog
- Does NOT require specific CNI, service mesh, or cloud provider

## 9. Compatibility
K3s, Kind, Minikube, GKE, EKS, AKS, OpenShift, any conformant K8s. Linux kernel 4.18+.
