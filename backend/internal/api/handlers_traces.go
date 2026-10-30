package api

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/models"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

func (h *Handlers) GetTraces(c *gin.Context) {
	traceID := c.Param("trace_id")
	if !regexp.MustCompile(`^[a-fA-F0-9]{32}$`).MatchString(traceID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "trace ID must contain 32 hexadecimal characters"})
		return
	}
	spans, err := h.tempoClient.GetTrace(c.Request.Context(), traceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, models.Trace{TraceID: traceID, Spans: spans})
}

// parseTraceWindow accepts Go-style durations (5m, 1h, 24h) for the trace
// search window, so the header's time-range control governs traces like it
// governs metrics and logs. Empty lets Tempo apply its own default.
func parseTraceWindow(w string) (time.Duration, error) {
	if w == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(w)
	if err != nil || d < time.Minute || d > 24*time.Hour {
		return 0, fmt.Errorf("window must be a duration between 1m and 24h (e.g. 5m, 1h)")
	}
	return d, nil
}

func (h *Handlers) SearchTraces(c *gin.Context) {
	serviceName := c.Query("serviceName")
	if serviceName == "" {
		serviceName = c.Query("service")
	}
	if serviceName != "" && !validNamespace(serviceName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "service name must be a valid Kubernetes name"})
		return
	}
	limit := 20
	if l := c.Query("limit"); l != "" {
		parsed, err := strconv.Atoi(l)
		if err != nil || parsed < 1 || parsed > 100 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be between 1 and 100"})
			return
		}
		limit = parsed
	}
	window := c.Query("window")
	win, err := parseTraceWindow(window)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var startSec, endSec int64
	if win > 0 {
		endSec = time.Now().Unix()
		startSec = endSec - int64(win.Seconds())
	}
	traces, err := h.tempoClient.SearchTraces(c.Request.Context(), serviceName, limit, startSec, endSec)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, traces)
}

func (h *Handlers) GetLogs(c *gin.Context) {
	pod := c.Query("pod")
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	filter := c.Query("filter")
	if len(filter) > 256 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "filter must be at most 256 characters"})
		return
	}
	if filter != "" {
		if _, err := regexp.Compile(filter); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "filter must be a valid regular expression"})
			return
		}
	}
	if pod != "" && !validPodName(pod) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pod must be a valid Kubernetes name or name prefix"})
		return
	}
	limit := 100
	if l := c.Query("limit"); l != "" {
		parsed, err := strconv.Atoi(l)
		if err != nil || parsed < 1 || parsed > 500 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be between 1 and 500"})
			return
		}
		limit = parsed
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
	startValue, startErr := strconv.ParseInt(start, 10, 64)
	endValue, endErr := strconv.ParseInt(end, 10, 64)
	if startErr != nil || endErr != nil || startValue <= 0 || endValue <= startValue {
		c.JSON(http.StatusBadRequest, gin.H{"error": "start and end must be valid increasing Unix nanosecond timestamps"})
		return
	}

	entries, err := h.lokiClient.QueryRange(c.Request.Context(), logQL, start, end, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, entries)
}
