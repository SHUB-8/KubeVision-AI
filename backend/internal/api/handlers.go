package api

import (
	"encoding/json"
	"fmt"
	"net/http"
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
	store       *storage.Store
	k8sClient   *k8s.Client
	promClient  *prometheus.Client
	lokiClient  *loki.Client
	tempoClient *tempo.Client
	topologySvc *services.TopologyService
	baseliner   *services.Baseliner
}

func NewHandlers(store *storage.Store, k8sClient *k8s.Client, promClient *prometheus.Client,
	lokiClient *loki.Client, tempoClient *tempo.Client) *Handlers {
	return &Handlers{
		store:       store,
		k8sClient:   k8sClient,
		promClient:  promClient,
		lokiClient:  lokiClient,
		tempoClient: tempoClient,
		topologySvc: services.NewTopologyService(k8sClient, promClient),
		baseliner:   services.NewBaseliner(store, promClient),
	}
}

func (h *Handlers) GetHealth(c *gin.Context) {
	health := models.HealthResponse{Status: "ok"}

	_, err := h.promClient.Query(c.Request.Context(), "up")
	if err != nil {
		health.Prometheus = "error"
	} else {
		health.Prometheus = "ok"
	}

	health.Loki = "ok"
	health.Tempo = "ok"

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
	namespace := c.DefaultQuery("namespace", "boutique")
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
	namespace := c.DefaultQuery("namespace", "boutique")

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
		svcName := extractServiceName(pod.Name)
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

	services := make([]models.Service, 0, len(serviceMap))
	for _, svc := range serviceMap {
		services = append(services, *svc)
	}
	c.JSON(http.StatusOK, services)
}

func (h *Handlers) GetServiceEndpoints(c *gin.Context) {
	name := c.Param("name")
	namespace := c.DefaultQuery("namespace", "boutique")
	window := c.DefaultQuery("window", "5m")

	data, err := h.promClient.GetEndpointMetrics(namespace, name, window)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	type metricEntry struct {
		Metric map[string]string `json:"metric"`
		Value  []interface{}     `json:"value"`
	}

	var results []metricEntry
	if err := json.Unmarshal(data, &results); err != nil {
		c.JSON(http.StatusOK, []models.Endpoint{})
		return
	}

	endpointMap := make(map[string]*models.Endpoint)
	for _, r := range results {
		path := r.Metric["http_route"]
		method := r.Metric["http_request_method"]
		key := path + ":" + method
		if _, exists := endpointMap[key]; !exists {
			endpointMap[key] = &models.Endpoint{Service: name, Path: path, Method: method}
		}
		if len(r.Value) >= 2 {
			switch v := r.Value[1].(type) {
			case float64:
				endpointMap[key].Rate = v
			case string:
				fmt.Sscanf(v, "%f", &endpointMap[key].Rate)
			}
		}
	}

	endpoints := make([]models.Endpoint, 0, len(endpointMap))
	for _, ep := range endpointMap {
		endpoints = append(endpoints, *ep)
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
	namespace := c.DefaultQuery("namespace", "boutique")
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
		settings = defaultSettings()
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
	pods, err := h.k8sClient.GetPods("boutique")
	if err == nil {
		info.Pods = pods
	}
	c.JSON(http.StatusOK, info)
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
	namespace := c.DefaultQuery("namespace", "boutique")
	window := c.DefaultQuery("window", "5m")
	if err := h.baseliner.CalculateBaselines(c.Request.Context(), namespace, window); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "message": "baselines recalculated"})
}

func defaultSettings() models.UISettings {
	return models.UISettings{
		Theme:           "dark",
		RefreshInterval: 15,
		TimeWindow:      "5m",
		Namespace:       "boutique",
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
