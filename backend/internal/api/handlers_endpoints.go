package api

import (
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/models"
	"log/slog"
	"net/http"
	"strings"
)

func (h *Handlers) GetServiceEndpoints(c *gin.Context) {
	name := c.Param("name")
	if !validNamespace(name) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "service name must be a valid Kubernetes name"})
		return
	}
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	window, ok := h.requestWindow(c)
	if !ok {
		return
	}

	endpointMap := make(map[string]*models.Endpoint)
	getEndpoint := func(r metricEntry) *models.Endpoint {
		// HTTP endpoints are keyed by route+verb; gRPC methods carry
		// rpc_method ("/pkg.Service/Method"); datastore operations carry
		// db_operation_name ("GET", "SET", "CLIENT", ...).
		path := r.Metric["http_route"]
		method := r.Metric["http_request_method"]
		if path == "" {
			path = r.Metric["rpc_method"]
		}
		if method == "" {
			method = "RPC"
		}
		if op := r.Metric["db_operation_name"]; op != "" {
			path = op
			method = "DB"
		}
		// Non-Go gRPC clients export the semconv placeholder method.
		if path == "_OTHER" {
			path = "(method not captured)"
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
			ep := getEndpoint(r)
			ep.Rate += entryValue(r)
			if ep.Rate > 0 {
				ep.RateSource = models.SourceMetrics
			}
		}
	}

	// 2. gRPC call rate from Prometheus (server or client calling this service)
	if data, err := h.promClient.GetEndpointRPCMetrics(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			ep := getEndpoint(r)
			ep.Rate += entryValue(r)
			if ep.Rate > 0 {
				ep.RateSource = models.SourceMetrics
			}
		}
	}

	// 3. Error rates
	if data, err := h.promClient.GetEndpointErrors(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			ep := getEndpoint(r)
			ep.ErrorRate = entryValue(r)
			ep.ErrorRateSource = models.SourceMetrics
		}
	}
	if data, err := h.promClient.GetEndpointRPCErrors(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			ep := getEndpoint(r)
			ep.ErrorRate += entryValue(r)
			ep.ErrorRateSource = models.SourceMetrics
		}
	}

	// 3b. Datastore operations (Redis RESP, SQL, Mongo) as observed by the
	// callers targeting this datastore. All values are client-observed: the
	// db_server histogram mis-pairs operations on persistent connections.
	if rateData, err := h.promClient.GetEndpointDBMetrics(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(rateData) {
			ep := getEndpoint(r)
			ep.Rate += entryValue(r)
			if ep.Rate > 0 {
				ep.RateSource = models.SourceClientObserved
			}
		}
	}
	if data, err := h.promClient.GetEndpointDBErrors(namespace, name, window); err == nil {
		for _, r := range parseMetricEntries(data) {
			ep := getEndpoint(r)
			if v := entryValue(r); v > 0 {
				ep.ErrorRate = v
				ep.ErrorRateSource = models.SourceClientObserved
			}
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
				ep := getEndpoint(r)
				if v := entryValue(r); v > 0 {
					q.field(ep, v)
					ep.LatencySource = models.SourceMetrics
				}
			}
		}
		if data, err := h.promClient.GetEndpointRPCLatency(namespace, name, window, q.q); err == nil {
			for _, r := range parseMetricEntries(data) {
				ep := getEndpoint(r)
				if q.get(ep) == 0 {
					if v := entryValue(r); v > 0 {
						q.field(ep, v)
						ep.LatencySource = models.SourceMetrics
					}
				}
			}
		}
		if data, err := h.promClient.GetEndpointDBLatency(namespace, name, window, q.q); err == nil {
			for _, r := range parseMetricEntries(data) {
				ep := getEndpoint(r)
				if q.get(ep) == 0 {
					if v := entryValue(r); v > 0 {
						q.field(ep, v)
						ep.LatencySource = models.SourceClientObserved
					}
				}
			}
		}
	}

	// 5. Strict filter: drop any residual health check or trace export operations
	endpoints := make([]models.Endpoint, 0, len(endpointMap))
	for _, ep := range endpointMap {
		lowerPath := strings.ToLower(ep.Path)
		if strings.Contains(lowerPath, "health") || strings.Contains(lowerPath, "_healthz") || strings.Contains(lowerPath, "traceservice/export") {
			continue
		}
		endpoints = append(endpoints, *ep)
	}

	// 6. If no active traffic observed in window, dynamically query Kubernetes service ports
	if len(endpoints) == 0 && h.k8sClient != nil {
		if declared, err := h.k8sClient.GetDeclaredServiceEndpoints(namespace, name); err == nil && len(declared) > 0 {
			endpoints = declared
		} else if err != nil {
			slog.Warn("endpoint response could not load Kubernetes Service ports", "namespace", namespace, "service", name, "error", err)
		}
	}

	c.JSON(http.StatusOK, endpoints)
}
