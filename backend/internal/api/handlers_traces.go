package api

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/kubevision/backend/internal/clients/loki"
	"github.com/kubevision/backend/models"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var traceIDRegex = regexp.MustCompile(`^[a-fA-F0-9]{32}$`)

func (h *Handlers) GetTraces(c *gin.Context) {
	traceID := c.Param("trace_id")
	if !traceIDRegex.MatchString(traceID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "trace ID must contain 32 hexadecimal characters"})
		return
	}
	if h.tempoClient == nil {
		c.JSON(http.StatusOK, models.Trace{TraceID: traceID, Spans: []models.Span{}})
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
	// Optional server-side status filter. Errors are frequently a few percent
	// of traffic, so fetching the newest N traces and filtering client-side
	// misses them; Tempo can select them directly.
	status := c.Query("status")
	switch status {
	case "", "error", "ok", "unset":
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be one of: error, ok, unset"})
		return
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
	minDuration := c.Query("minDuration")
	if minDuration == "" {
		if minDurMs := c.Query("minDurationMs"); minDurMs != "" {
			if ms, err := strconv.Atoi(minDurMs); err == nil && ms > 0 {
				minDuration = fmt.Sprintf("%dms", ms)
			}
		}
	}
	traces, err := h.tempoClient.SearchTraces(c.Request.Context(), serviceName, limit, startSec, endSec, status, minDuration)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, traces)
}

// GetTraceLogs returns the log lines emitted by EVERY service in a trace,
// inside that trace's time window (padded). The reason a request failed is
// often logged by the callee, not by the service whose node the operator
// clicked, so a single-service log query can legitimately come back empty.
func (h *Handlers) GetTraceLogs(c *gin.Context) {
	traceID := c.Param("trace_id")
	if !traceIDRegex.MatchString(traceID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "trace ID must contain 32 hexadecimal characters"})
		return
	}
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	if h.tempoClient == nil || h.lokiClient == nil {
		c.JSON(http.StatusOK, models.TraceLogs{TraceID: traceID})
		return
	}

	spans, err := h.tempoClient.GetTrace(c.Request.Context(), traceID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	var minStart, maxEnd int64
	serviceSet := make(map[string]struct{})
	for _, span := range spans {
		if span.StartTime > 0 && (minStart == 0 || span.StartTime < minStart) {
			minStart = span.StartTime
		}
		if end := span.StartTime + span.Duration; end > maxEnd {
			maxEnd = end
		}
		if span.ServiceName != "" && span.ServiceName != "unknown" {
			serviceSet[span.ServiceName] = struct{}{}
		}
	}
	if minStart == 0 {
		c.JSON(http.StatusOK, models.TraceLogs{TraceID: traceID})
		return
	}

	services := make([]string, 0, len(serviceSet))
	for service := range serviceSet {
		services = append(services, service)
	}
	sort.Strings(services)

	// Logs are timestamped by the collector on receipt, so pad the trace window
	// instead of requiring exact overlap.
	startNS := minStart - int64(2*time.Second)
	if startNS < 0 {
		startNS = 0
	}
	endNS := maxEnd + int64(3*time.Second)

	logQL := loki.BuildLogQLForServices(namespace, services, "")
	entries, err := h.lokiClient.QueryRange(c.Request.Context(), logQL,
		strconv.FormatInt(startNS, 10), strconv.FormatInt(endNS, 10), 300)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Attribute each line to its workload (pod name -> owning workload).
	workloadByPod := make(map[string]string)
	if h.k8sClient != nil {
		if pods, err := h.k8sClient.GetPods(c.Request.Context(), namespace); err == nil {
			for _, pod := range pods {
				workloadByPod[pod.Name] = pod.WorkloadName
			}
		}
	}

	out := make([]models.TraceLogEntry, 0, len(entries))
	for _, entry := range entries {
		pod := entry.Labels["kubernetes_pod_name"]
		service := workloadByPod[pod]
		if service == "" {
			service = pod
		}
		out = append(out, models.TraceLogEntry{LogEntry: entry, Service: service})
	}
	// Chronological order: the trace is a timeline, newest-first buries the cause.
	nanos := func(s string) int64 {
		v, _ := strconv.ParseInt(s, 10, 64)
		return v
	}
	sort.SliceStable(out, func(i, j int) bool { return nanos(out[i].Timestamp) < nanos(out[j].Timestamp) })

	c.JSON(http.StatusOK, models.TraceLogs{
		TraceID:  traceID,
		Services: services,
		StartNS:  startNS,
		EndNS:    endNS,
		Entries:  out,
	})
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

func (h *Handlers) GetLogVolume(c *gin.Context) {
	if h.lokiClient == nil {
		c.JSON(http.StatusOK, []models.LogVolumeBucket{})
		return
	}
	namespace, ok := h.requestNamespace(c)
	if !ok {
		return
	}
	pod := strings.TrimSpace(c.Query("pod"))
	service := strings.TrimSpace(c.Query("service"))
	target := pod
	if target == "" {
		target = service
	}
	step := strings.TrimSpace(c.Query("step"))

	now := time.Now()
	start := now.Add(-15 * time.Minute)
	end := now

	if s := c.Query("start"); s != "" {
		if sec, err := strconv.ParseInt(s, 10, 64); err == nil && sec > 0 {
			start = time.Unix(sec, 0)
		}
	}
	if e := c.Query("end"); e != "" {
		if sec, err := strconv.ParseInt(e, 10, 64); err == nil && sec > 0 {
			end = time.Unix(sec, 0)
		}
	}
	if window := c.Query("window"); window != "" {
		if dur, err := time.ParseDuration(window); err == nil && dur > 0 {
			start = end.Add(-dur)
		}
	}

	buckets, err := h.lokiClient.GetLogVolume(c.Request.Context(), namespace, target, start.Unix(), end.Unix(), step)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, buckets)
}
