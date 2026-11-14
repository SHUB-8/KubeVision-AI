package api

import (
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/models"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"time"
)

func (h *Handlers) GetClusterInfo(c *gin.Context) {
	if h.k8sClient == nil {
		c.JSON(http.StatusOK, models.ClusterInfo{Name: "unknown", Status: "k8s not connected"})
		return
	}

	info, err := h.k8sClient.GetClusterInfo(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	pods, err := h.k8sClient.GetPods(ctx, namespace)
	if err == nil {
		info.Pods = pods
	} else {
		slog.Warn("cluster response could not load namespace pods", "namespace", namespace, "error", err)
	}

	pvcs, err := h.k8sClient.GetPersistentVolumeClaims(ctx, namespace)
	if err == nil {
		info.PVCs = pvcs
	} else {
		slog.Warn("cluster response could not load namespace PVCs", "namespace", namespace, "error", err)
	}

	if h.promClient != nil && len(info.Pods) > 0 {
		results := prometheus.FetchParallel(
			func() (json.RawMessage, error) { return h.promClient.GetPodCPUUsage(ctx, namespace) },
			func() (json.RawMessage, error) { return h.promClient.GetPodMemoryUsage(ctx, namespace) },
			func() (json.RawMessage, error) { return h.promClient.GetPodCPULimits(ctx, namespace) },
			func() (json.RawMessage, error) { return h.promClient.GetPodMemoryLimits(ctx, namespace) },
		)

		cpuUsageMap := make(map[string]float64)
		for _, r := range prometheus.ParseMetricEntries(results[0]) {
			if pod := prometheus.ExtractPodName(r.Metric); pod != "" {
				cpuUsageMap[pod] = r.FloatValue()
			}
		}

		memUsageMap := make(map[string]float64)
		for _, r := range prometheus.ParseMetricEntries(results[1]) {
			if pod := prometheus.ExtractPodName(r.Metric); pod != "" {
				memUsageMap[pod] = r.FloatValue()
			}
		}

		cpuLimitMap := make(map[string]float64)
		for _, r := range prometheus.ParseMetricEntries(results[2]) {
			if pod := prometheus.ExtractPodName(r.Metric); pod != "" {
				cpuLimitMap[pod] = r.FloatValue()
			}
		}

		memLimitMap := make(map[string]float64)
		for _, r := range prometheus.ParseMetricEntries(results[3]) {
			if pod := prometheus.ExtractPodName(r.Metric); pod != "" {
				memLimitMap[pod] = r.FloatValue()
			}
		}

		for i := range info.Pods {
			podName := info.Pods[i].Name
			if val, ok := cpuUsageMap[podName]; ok {
				info.Pods[i].CPUUsageCores = val
			}
			if val, ok := memUsageMap[podName]; ok {
				info.Pods[i].MemoryUsageBytes = val
			}
			if val, ok := cpuLimitMap[podName]; ok {
				info.Pods[i].CPULimitCores = val
			}
			if val, ok := memLimitMap[podName]; ok {
				info.Pods[i].MemoryLimitBytes = val
			}
		}
	}

	if h.promClient != nil {
		if cpuUsage, err := h.promClient.GetClusterCPUUsage(ctx); err == nil {
			info.CPUUsageCores = cpuUsage
		}
		if cpuTotal, err := h.promClient.GetClusterCPUTotal(ctx); err == nil {
			info.CPUTotalCores = cpuTotal
		}
		if memUsage, err := h.promClient.GetClusterMemoryUsage(ctx); err == nil {
			info.MemoryUsageBytes = memUsage
		}
		if memTotal, err := h.promClient.GetClusterMemoryTotal(ctx); err == nil {
			info.MemoryTotalBytes = memTotal
		}
	}

	c.JSON(http.StatusOK, info)
}

func (h *Handlers) GetNamespaces(c *gin.Context) {
	c.JSON(http.StatusOK, h.namespaceList())
}

func (h *Handlers) namespaceList() []string {
	if len(h.observedNamespaces) > 0 {
		return append([]string(nil), h.observedNamespaces...)
	}
	return []string{h.defaultNamespace}
}

func (h *Handlers) GetBaselines(c *gin.Context) {
	service := c.Param("name")
	window := c.Query("window")
	if !validNamespace(service) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "service name must be a valid Kubernetes name"})
		return
	}
	if window != "" && !validWindow(window) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "window must be a valid Prometheus duration"})
		return
	}
	baselines, err := h.baseliner.GetBaselines(service, window)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, baselines)
}

func (h *Handlers) GetK8sEvents(c *gin.Context) {
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	limit := 100
	if raw := c.Query("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be between 1 and 500"})
			return
		}
		limit = parsed
	}

	var events []models.KubernetesEvent
	err := h.store.IterateValues(fmt.Sprintf("event:k8s:%s:", namespace), func(val []byte) error {
		var event models.KubernetesEvent
		if err := json.Unmarshal(val, &event); err != nil {
			return nil
		}
		if event.Namespace == namespace {
			events = append(events, event)
		}
		return nil
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	sort.Slice(events, func(i, j int) bool {
		left, leftErr := time.Parse(time.RFC3339Nano, events[i].LastObservedAt)
		right, rightErr := time.Parse(time.RFC3339Nano, events[j].LastObservedAt)
		if leftErr != nil || rightErr != nil {
			return events[i].LastObservedAt > events[j].LastObservedAt
		}
		return left.After(right)
	})
	if len(events) > limit {
		events = events[:limit]
	}
	c.JSON(http.StatusOK, events)
}

func (h *Handlers) RecalculateBaselines(c *gin.Context) {
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	window, ok := h.requestWindow(c)
	if !ok {
		return
	}
	if err := h.baseliner.CalculateBaselines(c.Request.Context(), namespace, window); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "message": "baselines recalculated"})
}
