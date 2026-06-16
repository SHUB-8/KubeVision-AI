package api

import (
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/storage"
)

func SetupRoutes(store *storage.Store, k8sClient *k8s.Client, promClient *prometheus.Client,
	lokiClient *loki.Client, tempoClient *tempo.Client) *gin.Engine {

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Logger())
	router.Use(gin.Recovery())
	router.Use(corsMiddleware())

	handlers := NewHandlers(store, k8sClient, promClient, lokiClient, tempoClient)

	api := router.Group("/api/v1")
	{
		api.GET("/health", handlers.GetHealth)
		api.GET("/topology", handlers.GetTopology)
		api.GET("/services", handlers.GetServices)
		api.GET("/services/:name/endpoints", handlers.GetServiceEndpoints)
		api.GET("/services/:name/baselines", handlers.GetBaselines)
		api.POST("/baselines/recalculate", handlers.RecalculateBaselines)
		api.GET("/traces/:trace_id", handlers.GetTraces)
		api.GET("/traces", handlers.SearchTraces)
		api.GET("/logs", handlers.GetLogs)
		api.GET("/config", handlers.GetConfig)
		api.PUT("/config", handlers.UpdateConfig)
		api.GET("/cluster", handlers.GetClusterInfo)
	}

	return router
}

func corsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		c.Writer.Header().Set("Access-Control-Max-Age", "86400")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}
