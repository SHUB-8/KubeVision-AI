package api

import (
	"encoding/json"
	"fmt"
	"github.com/gin-gonic/gin"
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

	info, err := h.k8sClient.GetClusterInfo()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	pods, err := h.k8sClient.GetPods(namespace)
	if err == nil {
		info.Pods = pods
	} else {
		slog.Warn("cluster response could not load namespace pods", "namespace", namespace, "error", err)
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

	items, err := h.store.List(fmt.Sprintf("event:k8s:%s:", namespace))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	events := make([]models.KubernetesEvent, 0, len(items))
	for _, raw := range items {
		var event models.KubernetesEvent
		if err := json.Unmarshal(raw, &event); err != nil {
			continue
		}
		if event.Namespace == namespace {
			events = append(events, event)
		}
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
