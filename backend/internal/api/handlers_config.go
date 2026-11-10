package api

import (
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/models"
	"net/http"
)

func (h *Handlers) GetConfig(c *gin.Context) {
	var settings models.UISettings
	err := h.store.Get("config:ui_settings", &settings)
	if err != nil {
		settings = defaultSettings(h.defaultNamespace)
	}
	if !validNamespace(settings.Namespace) || (len(h.observedNamespaces) > 0 && !containsNamespace(h.observedNamespaces, settings.Namespace)) {
		settings.Namespace = h.defaultNamespace
	}
	if !validWindow(settings.TimeWindow) {
		settings.TimeWindow = models.DefaultWindow
	}
	c.JSON(http.StatusOK, settings)
}

func (h *Handlers) UpdateConfig(c *gin.Context) {
	var settings models.UISettings
	if err := c.ShouldBindJSON(&settings); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validNamespace(settings.Namespace) || (len(h.observedNamespaces) > 0 && !containsNamespace(h.observedNamespaces, settings.Namespace)) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace must be one of the configured observed namespaces"})
		return
	}
	if !validWindow(settings.TimeWindow) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "timeWindow must be a valid Prometheus duration"})
		return
	}
	if err := h.store.Set("config:ui_settings", settings); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, settings)
}

func defaultSettings(namespace string) models.UISettings {
	return models.UISettings{
		Theme:           "dark",
		RefreshInterval: 15,
		TimeWindow:      models.DefaultWindow,
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
