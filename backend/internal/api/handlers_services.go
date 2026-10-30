package api

import (
	"encoding/json"
	"github.com/gin-gonic/gin"
	prometheus "github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/models"
	"log/slog"
	"net/http"
	"time"
)

func (h *Handlers) GetServices(c *gin.Context) {
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	window, ok := h.requestWindow(c)
	if !ok {
		return
	}

	if h.k8sClient == nil {
		c.JSON(http.StatusOK, []models.Service{})
		return
	}

	serveCachedJSON(c, "services:"+namespace+":"+window, 5*time.Second, func() (any, error) {
		pods, err := h.k8sClient.GetPods(namespace)
		if err != nil {
			return nil, err
		}

		serviceMap := make(map[string]*models.Service)
		// Per-service pod phase counts: [running, pending, failed]. Other phases
		// (Succeeded, Unknown) count toward none of them.
		phaseCounts := make(map[string][3]int)
		for _, pod := range pods {
			svcName := pod.WorkloadName
			if svcName == "" {
				svcName = extractServiceName(pod.Name)
			}
			counts := phaseCounts[svcName]
			switch pod.Status {
			case "Running":
				counts[0]++
			case "Pending":
				counts[1]++
			case "Failed":
				counts[2]++
			}
			phaseCounts[svcName] = counts
			if _, exists := serviceMap[svcName]; !exists {
				serviceMap[svcName] = &models.Service{
					Name:      svcName,
					Namespace: namespace,
					Labels:    make(map[string]string),
				}
			}
			svc := serviceMap[svcName]
			svc.Replicas++
			if pod.Status == "Running" {
				svc.Ready++
			}
		}
		for name, counts := range phaseCounts {
			serviceMap[name].Status = deriveServiceStatus(counts[0], counts[1], counts[2])
		}

		// Enrich the K8s inventory with RED metrics from OBI (via Prometheus).
		// All queries run CONCURRENTLY (they are independent) — sequential they
		// summed to seconds per request. A missing series (service with no traffic
		// in the window) just leaves the zero value; a Prometheus error degrades
		// the enrichment only.
		if h.promClient != nil {
			results := prometheus.FetchParallel(
				func() (json.RawMessage, error) { return h.promClient.GetServiceRates(namespace, window) },
				func() (json.RawMessage, error) { return h.promClient.GetServiceErrors(namespace, window) },
				func() (json.RawMessage, error) { return h.promClient.GetServiceRPCErrors(namespace, window) },
				func() (json.RawMessage, error) { return h.promClient.GetServiceLatency(namespace, window, "0.95") },
				func() (json.RawMessage, error) { return h.promClient.GetServiceRPCLatency(namespace, window, "0.95") },
				func() (json.RawMessage, error) {
					return h.promClient.GetClientLatencyByServer(namespace, window, "0.95")
				},
				func() (json.RawMessage, error) { return h.promClient.GetClientErrorsByServer(namespace, window) },
			)
			for _, r := range parseMetricEntries(results[0]) {
				if svc, ok := serviceMap[prometheus.MetricServiceName(r.Metric)]; ok {
					setServiceRate(svc, entryValue(r), models.SourceMetrics)
				}
			}
			for _, r := range parseMetricEntries(results[1]) {
				if svc, ok := serviceMap[prometheus.MetricServiceName(r.Metric)]; ok {
					svc.ErrorRate = entryValue(r)
				}
			}
			// gRPC services have no HTTP series; their error rate and latency come
			// from the rpc_server_call_* families.
			for _, r := range parseMetricEntries(results[2]) {
				if svc, ok := serviceMap[prometheus.MetricServiceName(r.Metric)]; ok {
					svc.ErrorRate += entryValue(r)
				}
			}
			for _, r := range parseMetricEntries(results[3]) {
				if svc, ok := serviceMap[prometheus.MetricServiceName(r.Metric)]; ok {
					setServiceLatency(svc, entryValue(r), models.SourceMetrics)
				}
			}
			for _, r := range parseMetricEntries(results[4]) {
				if svc, ok := serviceMap[prometheus.MetricServiceName(r.Metric)]; ok && svc.LatencyP95 == 0 {
					setServiceLatency(svc, entryValue(r), models.SourceMetrics)
				}
			}
			// For polyglot services and datastores whose server-side series carry
			// no usable latency (HTTP-only uprobes; the db_server histogram's
			// persistent-connection mis-pairing), use the latency their CALLERS
			// observe (rpc_client_*/db_client_*/messaging_client_* families).
			for _, r := range parseMetricEntries(results[5]) {
				serverAddr := r.Metric["server_address"]
				if svc, ok := serviceMap[serverAddr]; ok && svc.LatencyP95 == 0 {
					setServiceLatency(svc, entryValue(r), models.SourceClientObserved)
				}
			}
			// Datastore error rate: fraction of caller-observed failed operations
			// (gRPC non-OK status, DB error_type) targeting the service. Only fills
			// services with no server-side error signal of their own.
			for _, r := range parseMetricEntries(results[6]) {
				serverAddr := r.Metric["server_address"]
				if svc, ok := serviceMap[serverAddr]; ok && svc.ErrorRate == 0 {
					if v := entryValue(r); v > 0 {
						svc.ErrorRate = v
					}
				}
			}
		}

		// Enrich services that have 0 inbound server metrics with their observed operational rates
		// (e.g. client workloads generating outbound requests or databases handling queries)
		if h.topologySvc != nil {
			if topo, err := h.topologySvc.GetTopology(c.Request.Context(), namespace, window); err == nil {
				enrichMissingServiceRatesFromTopology(serviceMap, topo.Edges)
			} else {
				slog.Warn("service response topology enrichment failed", "namespace", namespace, "window", window, "error", err)
			}
		}

		services := make([]models.Service, 0, len(serviceMap))
		for _, svc := range serviceMap {
			services = append(services, *svc)
		}
		return services, nil
	})
}

func setServiceRate(svc *models.Service, value float64, source string) {
	if value <= 0 || source == "" {
		svc.Rate = 0
		svc.RateSource = ""
		return
	}
	svc.Rate = value
	svc.RateSource = source
}

func setServiceLatency(svc *models.Service, value float64, source string) {
	if value <= 0 || source == "" {
		svc.LatencyP95 = 0
		svc.LatencySource = ""
		return
	}
	svc.LatencyP95 = value
	svc.LatencySource = source
}

func enrichMissingServiceRatesFromTopology(serviceMap map[string]*models.Service, edges []models.Edge) {
	for _, edge := range edges {
		if edge.Rate <= 0 || edge.RateSource == "" {
			continue
		}
		if target, ok := serviceMap[edge.Target]; ok && target.Rate == 0 {
			setServiceRate(target, edge.Rate, edge.RateSource)
		}
		if source, ok := serviceMap[edge.Source]; ok && source.Rate == 0 {
			setServiceRate(source, edge.Rate, edge.RateSource)
		}
	}
}

// deriveServiceStatus collapses per-pod phases into one service status.
// Precedence: any failure wins, then waiting pods, then partial availability.
// Succeeded and Unknown phases count as neither up nor down, so a service whose
// pods are all in those states reports Unknown rather than a healthy state.
func deriveServiceStatus(running, pending, failed int) string {
	switch {
	case failed > 0:
		return "Failed"
	case pending > 0 && running == 0:
		return "Pending"
	case pending > 0:
		return "Degraded"
	case running > 0:
		return "Running"
	default:
		return "Unknown"
	}
}

func extractServiceName(podName string) string {
	parts := []rune(podName)
	lastDash := -1
	secondLastDash := -1
	for i := len(parts) - 1; i >= 0; i-- {
		if parts[i] == '-' {
			if lastDash == -1 {
				lastDash = i
			} else if secondLastDash == -1 {
				secondLastDash = i
				break
			}
		}
	}
	if secondLastDash > 0 {
		return string(parts[:secondLastDash])
	}
	return podName
}
