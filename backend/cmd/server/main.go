package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/api"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/storage"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	promURL := os.Getenv("PROMETHEUS_URL")
	if promURL == "" {
		promURL = "http://prometheus-kube-prometheus-prometheus.monitoring.svc:9090"
	}

	lokiURL := os.Getenv("LOKI_URL")
	if lokiURL == "" {
		lokiURL = "http://loki-gateway.monitoring.svc"
	}

	tempoURL := os.Getenv("TEMPO_URL")
	if tempoURL == "" {
		tempoURL = "http://tempo.monitoring.svc:3200"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "./data/kubevision"
	}

	log.Println("KubeVision Backend starting...")
	log.Printf("Prometheus: %s", promURL)
	log.Printf("Loki:       %s", lokiURL)
	log.Printf("Tempo:      %s", tempoURL)

	if err := os.MkdirAll(dbPath, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	store, err := storage.NewStore(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer store.Close()
	log.Println("BadgerDB initialized")

	promClient := prometheus.NewClient(promURL)
	lokiClient := loki.NewClient(lokiURL)
	tempoClient := tempo.NewClient(tempoURL)

	k8sClient, err := k8s.NewClient()
	if err != nil {
		log.Printf("Warning: K8s client failed: %v", err)
		log.Println("Running in limited mode - K8s endpoints will be unavailable")
	}

	router := api.SetupRoutes(store, k8sClient, promClient, lokiClient, tempoClient)

	frontendDist := os.Getenv("FRONTEND_DIR")
	if frontendDist == "" {
		frontendDist = "../frontend/dist"
	}
	if _, err := os.Stat(frontendDist); err == nil {
		router.Static("/assets", frontendDist+"/assets")
		router.StaticFile("/", frontendDist+"/index.html")
		router.StaticFile("/favicon.ico", frontendDist+"/favicon.ico")
		router.NoRoute(func(c *gin.Context) {
			c.File(frontendDist + "/index.html")
		})
		log.Printf("Serving frontend from %s", frontendDist)
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("Server listening on :%s", port)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server failed: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}
	fmt.Println("Server exited gracefully")
}
