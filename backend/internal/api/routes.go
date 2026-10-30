package api

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
	"time"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/storage"
)

type RouteConfig struct {
	DefaultNamespace   string
	ObservedNamespaces []string
	APIToken           string
	AllowedOrigins     []string
}

func SetupRoutes(store *storage.Store, k8sClient *k8s.Client, promClient *prometheus.Client,
	lokiClient *loki.Client, tempoClient *tempo.Client, config RouteConfig) *gin.Engine {

	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Logger())
	router.Use(gin.Recovery())
	router.Use(corsMiddleware(config.AllowedOrigins))
	// Compress everything: static assets AND API JSON. Trace responses alone
	// are ~560 kB per 25 traces and compress ~8x; over any real network this
	// is the difference between a 750 kB and a ~250 kB first load.
	router.Use(gzip.Gzip(gzip.DefaultCompression))

	handlers := NewHandlers(store, k8sClient, promClient, lokiClient, tempoClient, config.DefaultNamespace, config.ObservedNamespaces)
	// Baselines are stored only when calculated; without this every Baselines
	// view is empty after a backend restart until someone clicks recalculate.
	handlers.StartBaselineAutoRecalc(context.Background(), 5*time.Minute)

	api := router.Group("/api/v1")
	api.Use(mutationAuth(config.APIToken))
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
		api.GET("/namespaces", handlers.GetNamespaces)
		api.GET("/events", handlers.GetK8sEvents)
	}

	return router
}

func corsMiddleware(origins []string) gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			allowed[origin] = struct{}{}
		}
	}

	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")
		_, originAllowed := allowed[origin]
		if origin != "" && originAllowed {
			c.Writer.Header().Set("Access-Control-Allow-Origin", origin)
			c.Writer.Header().Add("Vary", "Origin")
			c.Writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			c.Writer.Header().Set("Access-Control-Max-Age", "86400")
		}
		if c.Request.Method == "OPTIONS" {
			if origin == "" || !originAllowed {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	}
}

func mutationAuth(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead || c.Request.Method == http.MethodOptions || token == "" {
			c.Next()
			return
		}

		scheme, provided, ok := strings.Cut(c.GetHeader("Authorization"), " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			c.Header("WWW-Authenticate", "Bearer")
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "a valid bearer token is required for this operation"})
			return
		}
		c.Next()
	}
}
