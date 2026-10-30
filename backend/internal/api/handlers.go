package api

import (
	"context"
	"encoding/json"
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/internal/services"
	"github.com/kubevision/backend/internal/storage"
	"github.com/kubevision/backend/models"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

type Handlers struct {
	store              *storage.Store
	defaultNamespace   string
	observedNamespaces []string
	k8sClient          *k8s.Client
	promClient         *prometheus.Client
	lokiClient         *loki.Client
	tempoClient        *tempo.Client
	topologySvc        *services.TopologyService
	baseliner          *services.Baseliner
}

func NewHandlers(store *storage.Store, k8sClient *k8s.Client, promClient *prometheus.Client,
	lokiClient *loki.Client, tempoClient *tempo.Client, defaultNamespace string, observedNamespaces []string) *Handlers {
	return &Handlers{
		store:              store,
		defaultNamespace:   defaultNamespace,
		observedNamespaces: append([]string(nil), observedNamespaces...),
		k8sClient:          k8sClient,
		promClient:         promClient,
		lokiClient:         lokiClient,
		tempoClient:        tempoClient,
		topologySvc:        services.NewTopologyService(k8sClient, promClient),
		baseliner:          services.NewBaseliner(store, promClient),
	}
}

// StartBaselineAutoRecalc keeps baselines fresh without manual triggers.
// Baselines only exist after a calculation, so after every backend restart
// each Baselines view is empty until something recalculates. Recalculates
// the observed namespaces across the windows the UI queries, immediately and
// then on every tick.
func (h *Handlers) StartBaselineAutoRecalc(ctx context.Context, interval time.Duration) {
	windows := []string{"5m", "15m", "1h"}
	namespaces := h.observedNamespaces
	if len(namespaces) == 0 {
		namespaces = []string{h.defaultNamespace}
	}
	recalc := func() {
		for _, ns := range namespaces {
			for _, w := range windows {
				if err := h.baseliner.CalculateBaselines(ctx, ns, w); err != nil {
					slog.Warn("baseline auto-recalc failed", "namespace", ns, "window", w, "error", err)
				}
			}
		}
	}
	go func() {
		recalc()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				recalc()
			}
		}
	}()
}

// cachedResponseEntry is the short-lived body cache for the two heaviest
// dashboard endpoints. TTL below one auto-refresh (15s) so data is at most a
// few seconds stale; the point is making multi-tab loads, tab switches and
// the double-fired first fetches free, not replacing live refreshes.
type cachedResponseEntry struct {
	body    []byte
	expires time.Time
}

var responseCache sync.Map // string -> cachedResponseEntry

// serveCachedJSON serves the cached body for key when fresh; otherwise
// computes it, caches the marshalled body, and serves that.
func serveCachedJSON(c *gin.Context, key string, ttl time.Duration, compute func() (any, error)) {
	if entry, ok := responseCache.Load(key); ok {
		e := entry.(cachedResponseEntry)
		if time.Now().Before(e.expires) {
			c.Data(http.StatusOK, "application/json; charset=utf-8", e.body)
			return
		}
	}
	payload, err := compute()
	if err != nil {
		status := http.StatusInternalServerError
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}
	body, err := json.Marshal(payload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	responseCache.Store(key, cachedResponseEntry{body: body, expires: time.Now().Add(ttl)})
	c.Data(http.StatusOK, "application/json; charset=utf-8", body)
}

func (h *Handlers) requestNamespace(c *gin.Context) (string, bool) {
	namespace := c.DefaultQuery("namespace", h.defaultNamespace)
	if !validNamespace(namespace) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace must be a valid Kubernetes namespace name"})
		return "", false
	}
	if len(h.observedNamespaces) > 0 && !containsNamespace(h.observedNamespaces, namespace) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is not in the configured observed namespace list"})
		return "", false
	}
	return namespace, true
}

func (h *Handlers) requestWindow(c *gin.Context) (string, bool) {
	window := c.DefaultQuery("window", models.DefaultWindow)
	if !validWindow(window) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "window must be a Prometheus duration such as 5m, 1h, or 1d"})
		return "", false
	}
	return window, true
}

func containsNamespace(namespaces []string, target string) bool {
	for _, namespace := range namespaces {
		if namespace == target {
			return true
		}
	}
	return false
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
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	window, ok := h.requestWindow(c)
	if !ok {
		return
	}

	if h.k8sClient == nil {
		c.JSON(http.StatusOK, models.Topology{Nodes: []models.Node{}, Edges: []models.Edge{}})
		return
	}

	serveCachedJSON(c, "topology:"+namespace+":"+window, 5*time.Second, func() (any, error) {
		return h.topologySvc.GetTopology(c.Request.Context(), namespace, window)
	})
}
