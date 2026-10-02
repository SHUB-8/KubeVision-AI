package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/services"
	"github.com/kubevision/backend/internal/storage"
	"github.com/kubevision/backend/models"
)

type Handlers struct {
	store *storage.Store
	// defaultNamespace is used when a request omits ?namespace= - the
	// namespace of the observed application (OBSERVED_NAMESPACE env).
	defaultNamespace string
	k8sClient        *k8s.Client
	promClient       *prometheus.Client
	lokiClient       *loki.Client
	tempoClient      *tempo.Client
	topologySvc      *services.TopologyService
	baseliner        *services.Baseliner
}

func NewHandlers(store *storage.Store, k8sClient *k8s.Client, promClient *prometheus.Client,
	lokiClient *loki.Client, tempoClient *tempo.Client, defaultNamespace string) *Handlers {
	if defaultNamespace == "" {
		defaultNamespace = "boutique"
	}
	return &Handlers{
		store:            store,
		defaultNamespace: defaultNamespace,
		k8sClient:        k8sClient,
		promClient:       promClient,
		lokiClient:       lokiClient,
		tempoClient:      tempoClient,
		topologySvc:      services.NewTopologyService(k8sClient, promClient, tempoClient),
		baseliner:        services.NewBaseliner(store, promClient),
	}
}

func (h *Handlers) GetHealth(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
	defer cancel()

	health := models.HealthResponse{Status: "ok"}

	if _, err := h.promClient.Query(ctx, "up"); err != nil {
		health.Prometheus = "error"
	} else {
		health.Prometheus = "ok"
	}

	if err := h.lokiClient.Health(ctx); err != nil {
		health.Loki = "error: " + err.Error()
	} else {
		health.Loki = "ok"
	}

	if err := h.tempoClient.Health(ctx); err != nil {
		health.Tempo = "error: " + err.Error()
	} else {
		health.Tempo = "ok"
	}

	if h.k8sClient != nil {
		info, err := h.k8sClient.GetClusterInfo()
		if err != nil {
			health.K8s = "error: " + err.Error()
		} else {
			health.K8s = info.Name + " " + info.Version
		}
	} else {
		health.K8s = "not connected"
	}

	c.JSON(http.StatusOK, health)
}

func (h *Handlers) GetTopology(c *gin.Context) {
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	window := c.DefaultQuery("window", "5m")

	if h.k8sClient == nil {
		c.JSON(http.StatusOK, models.Topology{Nodes: []models.Node{}, Edges: []models.Edge{}})
		return
	}

	topology, err := h.topologySvc.GetTopology(c.Request.Context(), namespace, window)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, topology)
}

func (h *Handlers) GetServices(c *gin.Context) {
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)

	if h.k8sClient == nil {
		c.JSON(http.StatusOK, []models.Service{})
		return
	}

	pods, err := h.k8sClient.GetPods(namespace)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	serviceMap := make(map[string]*models.Service)
	for _, pod := range pods {
		svcName := pod.WorkloadName
		if svcName == "" {
			svcName = extractServiceName(pod.Name)
		}
		if _, exists := serviceMap[svcName]; !exists {
			serviceMap[svcName] = &models.Service{
				Name:      svcName,
				Namespace: namespace,
				Status:    "Running",
				Labels:    make(map[string]string),
			}
		}
		svc := serviceMap[svcName]
		svc.Replicas++
		if pod.Status == "Running" {
			svc.Ready++
		}
	}

	// Enrich the K8s inventory with RED metrics from Beyla (via Prometheus).
	// A missing series (service with no traffic in the window) just leaves
	// the zero value; a Prometheus error degrades the enrichment only.
	if h.promClient != nil {
		window := c.DefaultQuery("window", "5m")
		if data, err := h.promClient.GetServiceRates(namespace, window); err == nil {
			for _, r := range parseMetricEntries(data) {
				if svc, ok := serviceMap[r.Metric["service_name"]]; ok {
					svc.Rate = entryValue(r)
				}
			}
		}
		if data, err := h.promClient.GetServiceErrors(namespace, window); err == nil {
			for _, r := range parseMetricEntries(data) {
				if svc, ok := serviceMap[r.Metric["service_name"]]; ok {
					svc.ErrorRate = entryValue(r)
				}
			}
		}
		// gRPC services have no HTTP series; their error rate and latency come
		// from the rpc_server_call_* families.
		if data, err := h.promClient.GetServiceRPCErrors(namespace, window); err == nil {
			for _, r := range parseMetricEntries(data) {
				if svc, ok := serviceMap[r.Metric["service_name"]]; ok {
					svc.ErrorRate += entryValue(r)
				}
			}
		}
		if data, err := h.promClient.GetServiceLatency(namespace, window, "0.95"); err == nil {
			for _, r := range parseMetricEntries(data) {
				if svc, ok := serviceMap[r.Metric["service_name"]]; ok {
					svc.LatencyP95 = entryValue(r)
				}
			}
		}
		if data, err := h.promClient.GetServiceRPCLatency(namespace, window, "0.95"); err == nil {
			for _, r := range parseMetricEntries(data) {
				if svc, ok := serviceMap[r.Metric["service_name"]]; ok && svc.LatencyP95 == 0 {
					svc.LatencyP95 = entryValue(r)
				}
			}
		}
		// For polyglot services whose server-side uprobes are not captured natively,
		// use the client-observed latency targeting their service address.
		if data, err := h.promClient.GetClientLatencyByServer(namespace, window, "0.95"); err == nil {
			for _, r := range parseMetricEntries(data) {
				serverAddr := r.Metric["server_address"]
				if svc, ok := serviceMap[serverAddr]; ok && svc.LatencyP95 == 0 {
					svc.LatencyP95 = entryValue(r)
				}
			}
		}
	}

	// Enrich services that have 0 inbound server metrics with their observed operational rates
	// (e.g. client workloads generating outbound requests or databases handling queries)
	if h.topologySvc != nil {
		window := c.DefaultQuery("window", "5m")
		if topo, err := h.topologySvc.GetTopology(c.Request.Context(), namespace, window); err == nil {
			for _, edge := range topo.Edges {
				if edge.Rate > 0 {
					if tgt, ok := serviceMap[edge.Target]; ok && tgt.Rate == 0 {
						tgt.Rate = edge.Rate
					}
					if src, ok := serviceMap[edge.Source]; ok && src.Rate == 0 {
						src.Rate = edge.Rate
					}
				}
			}
		}
	}

	services := make([]models.Service, 0, len(serviceMap))
	for _, svc := range serviceMap {
		services = append(services, *svc)
	}
	c.JSON(http.StatusOK, services)
}

type metricEntry struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`
}

func parseMetricEntries(data json.RawMessage) []metricEntry {
	var results []metricEntry
	if err := json.Unmarshal(data, &results); err != nil {
		return nil
	}
	return results
}

func entryValue(r metricEntry) float64 {
	if len(r.Value) >= 2 {
		switch v := r.Value[1].(type) {
		case float64:
			return v
		case string:
			var f float64
			fmt.Sscanf(v, "%f", &f)
			return f
		}
	}
	return 0
}

func (h *Handlers) GetServiceEndpoints(c *gin.Context) {
	name := c.Param("name")
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	window := c.DefaultQuery("window", "5m")

	endpointMap := make(map[string]*models.Endpoint)
	getEndpoint := func(r metricEntry) *models.Endpoint {
		// HTTP endpoints are keyed by route+verb; gRPC methods carry
		// rpc_method ("/pkg.Service/Method") instead.
		path := r.Metric["http_route"]
		method := r.Metric["http_request_method"]
		if path == "" {
			path = r.Metric["rpc_method"]
		}
		if method == "" {
			method = "RPC"
		}
		key := path + ":" + method
		ep, exists := endpointMap[key]
		if !exists {
			ep = &models.Endpoint{Service: name, Path: path, Method: method}
			endpointMap[key] = ep
		}
		return ep
	}

	// 1. HTTP request rate from Prometheus (server or client calling this service)
	if rateData, err := h.promClient.GetEndpointMetrics(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(rateData) {
			getEndpoint(r).Rate += entryValue(r)
		}
	}

	// 2. gRPC call rate from Prometheus (server or client calling this service)
	if data, err := h.promClient.GetEndpointRPCMetrics(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			getEndpoint(r).Rate += entryValue(r)
		}
	}

	// 3. Error rates
	if data, err := h.promClient.GetEndpointErrors(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			getEndpoint(r).ErrorRate = entryValue(r)
		}
	}
	if data, err := h.promClient.GetEndpointRPCErrors(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			getEndpoint(r).ErrorRate += entryValue(r)
		}
	}

	// 4. Latency quantiles
	quantiles := []struct {
		q     string
		get   func(ep *models.Endpoint) float64
		field func(ep *models.Endpoint, v float64)
	}{
		{"0.5", func(ep *models.Endpoint) float64 { return ep.LatencyP50 }, func(ep *models.Endpoint, v float64) { ep.LatencyP50 = v }},
		{"0.95", func(ep *models.Endpoint) float64 { return ep.LatencyP95 }, func(ep *models.Endpoint, v float64) { ep.LatencyP95 = v }},
		{"0.99", func(ep *models.Endpoint) float64 { return ep.LatencyP99 }, func(ep *models.Endpoint, v float64) { ep.LatencyP99 = v }},
	}
	for _, q := range quantiles {
		if data, err := h.promClient.GetEndpointLatency(namespace, name, window, q.q); err == nil {
			for _, r := range parseMetricEntries(data) {
				q.field(getEndpoint(r), entryValue(r))
			}
		}
		if data, err := h.promClient.GetEndpointRPCLatency(namespace, name, window, q.q); err == nil {
			for _, r := range parseMetricEntries(data) {
				ep := getEndpoint(r)
				if q.get(ep) == 0 {
					q.field(ep, entryValue(r))
				}
			}
		}
	}

	// 5. Supplement endpoints and latencies discovered via Tempo distributed tracing
	if tempoEndpoints, err := h.tempoClient.GetEndpointsForService(c.Request.Context(), name); err == nil {
		for _, tep := range tempoEndpoints {
			key := tep.Path + ":" + tep.Method
			ep, exists := endpointMap[key]
			if !exists {
				tepCopy := tep
				endpointMap[key] = &tepCopy
			} else {
				if ep.LatencyP95 == 0 && tep.LatencyP95 > 0 {
					ep.LatencyP50 = tep.LatencyP50
					ep.LatencyP95 = tep.LatencyP95
					ep.LatencyP99 = tep.LatencyP99
				}
				if ep.Rate == 0 && tep.Rate > 0 {
					ep.Rate = tep.Rate
				}
			}
		}
	}

	// 6. Strict filter: drop any residual health check or trace export operations
	endpoints := make([]models.Endpoint, 0, len(endpointMap))
	for _, ep := range endpointMap {
		lowerPath := strings.ToLower(ep.Path)
		if strings.Contains(lowerPath, "health") || strings.Contains(lowerPath, "_healthz") || strings.Contains(lowerPath, "traceservice/export") {
			continue
		}
		endpoints = append(endpoints, *ep)
	}

	// 7. If no active traffic observed in window, dynamically query Kubernetes service ports
	if len(endpoints) == 0 && h.k8sClient != nil {
		if declared, err := h.k8sClient.GetDeclaredServiceEndpoints(namespace, name); err == nil && len(declared) > 0 {
			endpoints = declared
		}
	}

	c.JSON(http.StatusOK, endpoints)
}

func (h *Handlers) GetTraces(c *gin.Context) {
	traceID := c.Param("trace_id")
	spans, err := h.tempoClient.GetTrace(c.Request.Context(), traceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, models.Trace{TraceID: traceID, Spans: spans})
}

func (h *Handlers) SearchTraces(c *gin.Context) {
	serviceName := c.Query("serviceName")
	if serviceName == "" {
		serviceName = c.Query("service")
	}
	limit := 20
	if l := c.Query("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}
	traces, err := h.tempoClient.SearchTraces(c.Request.Context(), serviceName, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, traces)
}

func (h *Handlers) GetLogs(c *gin.Context) {
	pod := c.Query("pod")
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	filter := c.Query("filter")
	limit := 100
	if l := c.Query("limit"); l != "" {
		fmt.Sscanf(l, "%d", &limit)
	}

	logQL := loki.BuildLogQL(namespace, pod, filter)
	now := time.Now()
	start := fmt.Sprintf("%d", now.Add(-1*time.Hour).UnixNano())
	end := fmt.Sprintf("%d", now.UnixNano())
	if s := c.Query("start"); s != "" {
		start = s
	}
	if e := c.Query("end"); e != "" {
		end = e
	}

	entries, err := h.lokiClient.QueryRange(c.Request.Context(), logQL, start, end, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, entries)
}

func (h *Handlers) GetConfig(c *gin.Context) {
	var settings models.UISettings
	err := h.store.Get("config:ui_settings", &settings)
	if err != nil {
		settings = defaultSettings(h.defaultNamespace)
	}
	c.JSON(http.StatusOK, settings)
}

func (h *Handlers) UpdateConfig(c *gin.Context) {
	var settings models.UISettings
	if err := c.ShouldBindJSON(&settings); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.store.Set("config:ui_settings", settings); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}

func (h *Handlers) GetClusterInfo(c *gin.Context) {
	if h.k8sClient == nil {
		c.JSON(http.StatusOK, models.ClusterInfo{Name: "unknown", Status: "k8s not connected"})
		return
	}

	info, err := h.k8sClient.GetClusterInfo()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	pods, err := h.k8sClient.GetPods(namespace)
	if err == nil {
		info.Pods = pods
	}
	c.JSON(http.StatusOK, info)
}

func (h *Handlers) GetNamespaces(c *gin.Context) {
	if h.k8sClient == nil {
		c.JSON(http.StatusOK, []string{h.defaultNamespace})
		return
	}
	list, err := h.k8sClient.GetNamespaces()
	if err != nil {
		c.JSON(http.StatusOK, []string{h.defaultNamespace})
		return
	}
	c.JSON(http.StatusOK, list)
}

func (h *Handlers) GetBaselines(c *gin.Context) {
	service := c.Param("name")
	window := c.Query("window")
	baselines, err := h.baseliner.GetBaselines(service, window)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, baselines)
}

func (h *Handlers) RecalculateBaselines(c *gin.Context) {
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	window := c.DefaultQuery("window", "5m")
	if err := h.baseliner.CalculateBaselines(c.Request.Context(), namespace, window); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "message": "baselines recalculated"})
}

func defaultSettings(namespace string) models.UISettings {
	return models.UISettings{
		Theme:           "dark",
		RefreshInterval: 15,
		TimeWindow:      "5m",
		Namespace:       namespace,
		Thresholds: models.ThresholdSettings{
			ErrorRateWarning: 0.01, ErrorRateCritical: 0.05,
			LatencyWarning: 0.5, LatencyCritical: 1.0,
			CPUWarning: 0.7, CPUCritical: 0.9,
			MemoryWarning: 0.7, MemoryCritical: 0.9,
		},
		Display: models.DisplaySettings{
			ShowAnnotations: true, ShowProtocolStats: true, ShowK8sMetadata: true,
		},
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
