package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/api"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/storage"
	"github.com/kubevision/backend/models"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/util/validation"
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

	defaultNamespace := strings.TrimSpace(os.Getenv("OBSERVED_NAMESPACE"))
	if defaultNamespace == "" {
		defaultNamespace = models.DefaultNamespace
	}
	observedNamespaces, defaultNamespace, err := parseObservedNamespaces(os.Getenv("OBSERVED_NAMESPACES"), defaultNamespace)
	if err != nil {
		log.Fatalf("Invalid observed namespace configuration: %v", err)
	}

	clusterName := os.Getenv("CLUSTER_NAME")
	if clusterName == "" {
		clusterName = models.DefaultCluster
	}

	log.Println("KubeVision Backend starting...")
	log.Printf("Prometheus: %s", promURL)
	log.Printf("Loki:       %s", lokiURL)
	log.Printf("Tempo:      %s", tempoURL)
	log.Printf("Namespaces: %s", strings.Join(observedNamespaces, ","))

	mode := strings.ToLower(strings.TrimSpace(os.Getenv("KUBEVISION_MODE")))
	if mode == "" {
		if os.Getenv("KUBERNETES_SERVICE_HOST") != "" {
			mode = "production"
		} else {
			mode = "development"
		}
	}
	if mode != "development" && mode != "production" {
		log.Fatalf("KUBEVISION_MODE must be development or production")
	}
	apiToken := os.Getenv("API_TOKEN")
	if apiToken != strings.TrimSpace(apiToken) {
		log.Fatal("API_TOKEN must not contain leading or trailing whitespace")
	}
	if mode == "production" && len(apiToken) < 32 {
		log.Fatal("API_TOKEN must contain at least 32 characters when KUBEVISION_MODE=production")
	}
	allowedOrigins := splitNonEmpty(os.Getenv("CORS_ALLOWED_ORIGINS"))
	listenHost := strings.TrimSpace(os.Getenv("LISTEN_HOST"))
	if listenHost == "" {
		if mode == "production" {
			listenHost = "0.0.0.0"
		} else {
			listenHost = "127.0.0.1"
		}
	}

	if err := os.MkdirAll(dbPath, 0755); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	store, err := storage.NewStore(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer store.Close()
	log.Println("BadgerDB initialized")
	runCtx, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	var background sync.WaitGroup
	background.Add(1)
	go func() {
		defer background.Done()
		store.RunValueLogGC(5*time.Minute, 0.5, runCtx.Done())
	}()

	promClient := prometheus.NewClient(promURL)
	lokiClient := loki.NewClient(lokiURL)
	tempoClient := tempo.NewClient(tempoURL)

	k8sClient, err := k8s.NewClient(clusterName)
	if err != nil {
		log.Printf("Warning: K8s client failed: %v", err)
		log.Println("Running in limited mode - K8s endpoints will be unavailable")
	} else {
		background.Add(1)
		go func() {
			defer background.Done()
			err := k8sClient.WatchWarningEvents(runCtx, observedNamespaces, func(event *corev1.Event) {
				record := k8s.EventRecord(event)
				key := fmt.Sprintf("event:k8s:%s:%s", record.Namespace, record.UID)
				if err := store.SetWithTTL(key, record, storage.DefaultRetentionTTL); err != nil {
					log.Printf("WARN failed to persist Kubernetes Warning Event %s/%s: %v", record.Namespace, record.Name, err)
				}
			})
			if err != nil && err != context.Canceled {
				log.Printf("WARN Kubernetes Warning Event informer stopped: %v", err)
			}
		}()
	}

	router := api.SetupRoutes(store, k8sClient, promClient, lokiClient, tempoClient, api.RouteConfig{
		DefaultNamespace:   defaultNamespace,
		ObservedNamespaces: observedNamespaces,
		APIToken:           apiToken,
		AllowedOrigins:     allowedOrigins,
	})

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
		Addr:         net.JoinHostPort(listenHost, port),
		Handler:      router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		log.Printf("Server listening on %s", srv.Addr)
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
	cancelRun()
	background.Wait()
	fmt.Println("Server exited gracefully")
}

func parseObservedNamespaces(raw, preferred string) ([]string, string, error) {
	entries := splitNonEmpty(raw)
	if len(entries) == 0 {
		entries = []string{preferred}
	}

	namespaces := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, namespace := range entries {
		if len(validation.IsDNS1123Label(namespace)) != 0 {
			return nil, "", fmt.Errorf("%q is not a valid Kubernetes namespace", namespace)
		}
		if _, ok := seen[namespace]; ok {
			continue
		}
		seen[namespace] = struct{}{}
		namespaces = append(namespaces, namespace)
	}
	if len(namespaces) == 0 {
		return nil, "", fmt.Errorf("at least one observed namespace is required")
	}

	if preferred == "" || !contains(namespaces, preferred) {
		if raw != "" && preferred != "" && os.Getenv("OBSERVED_NAMESPACE") != "" {
			return nil, "", fmt.Errorf("OBSERVED_NAMESPACE %q must be included in OBSERVED_NAMESPACES", preferred)
		}
		preferred = namespaces[0]
	}
	return namespaces, preferred, nil
}

func splitNonEmpty(raw string) []string {
	var values []string
	for _, value := range strings.Split(raw, ",") {
		if value = strings.TrimSpace(value); value != "" {
			values = append(values, value)
		}
	}
	return values
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
