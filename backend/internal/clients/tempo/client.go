package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kubevision/backend/models"
)

type Client struct {
	baseURL      string
	client       *http.Client
	traceCacheMu sync.Mutex
	traceCache   map[string]cachedTrace
}

const (
	traceFetchWorkers    = 8
	traceCacheTTL        = 45 * time.Second
	maxTraceCacheEntries = 256
	// Traces with more parentless spans than this are degenerate (a multiplexed
	// connection's shared context stamped across unrelated requests) and are
	// skipped from listings rather than rendered as unusable waterfalls.
	maxParentlessSpans = 12
	// Listings are first fetched with a minimum duration to exclude
	// sub-millisecond kubelet probes; the unbounded query is only a fill-up
	// fallback. minDuration is a Tempo QueryMinDuration string.
	minSearchDuration = "2ms"
	// Oversample the Tempo search so cross-trace detail fetches can still fill
	// `limit` after degenerate / health-only traces are filtered out.
	traceSearchOversample = 8
)

// bareHTTPMethod matches span names that are a bare HTTP verb ("GET", "POST",
// ...). Such names carry no routing information, so they are enriched with the
// request path from span attributes; any richer name (route patterns, gRPC
// methods, db operations) is left as the exporter wrote it.
var bareHTTPMethod = regexp.MustCompile(`^[A-Z]{3,7}$`)

type cachedTrace struct {
	spans     []models.Span
	expiresAt time.Time
}

type searchResponse struct {
	Traces []tempoTrace `json:"traces"`
}

// Field names per the Tempo HTTP API search response (TraceSearchMetadata)
// https://grafana.com/docs/tempo/latest/api_docs/
type tempoTrace struct {
	TraceID           string `json:"traceID"`
	RootServiceName   string `json:"rootServiceName"`
	RootTraceName     string `json:"rootTraceName"`
	StartTimeUnixNano string `json:"startTimeUnixNano"`
	DurationMs        int64  `json:"durationMs"`
	SpanCount         int    `json:"spanCount"`
}

type traceResponse struct {
	Batches []spanBatch `json:"batches"`
}

type spanBatch struct {
	Resource   spanResource `json:"resource"`
	ScopeSpans []scopeSpan  `json:"scopeSpans"`
}

type spanResource struct {
	Attributes []spanAttr `json:"attributes"`
}

type scopeSpan struct {
	Spans []rawSpan `json:"spans"`
}

type rawSpan struct {
	TraceID           string     `json:"traceId"`
	SpanID            string     `json:"spanId"`
	ParentSpanID      string     `json:"parentSpanId"`
	Name              string     `json:"name"`
	StartTimeUnixNano string     `json:"startTimeUnixNano"`
	EndTimeUnixNano   string     `json:"endTimeUnixNano"`
	Kind              string     `json:"kind"`
	Status            spanStatus `json:"status"`
	Attributes        []spanAttr `json:"attributes"`
}

type spanStatus struct {
	Code string `json:"code"`
}

type spanAttr struct {
	Key   string    `json:"key"`
	Value attrValue `json:"value"`
}

type attrValue struct {
	StringValue string `json:"stringValue"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL:    baseURL,
		client:     &http.Client{Timeout: 30 * time.Second},
		traceCache: make(map[string]cachedTrace),
	}
}

func isSystemOrHealthOperation(name string) bool {
	if name == "" {
		return false
	}
	lower := strings.ToLower(name)
	return strings.Contains(lower, "health") ||
		strings.Contains(lower, "healthz") ||
		strings.Contains(lower, "_healthz") ||
		strings.Contains(lower, "liveness") ||
		strings.Contains(lower, "readiness") ||
		strings.Contains(lower, "traceservice/export") ||
		strings.Contains(lower, "opentelemetry.proto")
}

func isSystemOrHealthSpan(s models.Span) bool {
	if isSystemOrHealthOperation(s.OperationName) {
		return true
	}
	path := strings.ToLower(s.Attributes["url.path"])
	if strings.Contains(path, "health") || strings.Contains(path, "_healthz") {
		return true
	}
	target := strings.ToLower(s.Attributes["http.target"])
	if strings.Contains(target, "health") || strings.Contains(target, "_healthz") {
		return true
	}
	ua := strings.ToLower(s.Attributes["user_agent.original"])
	if strings.Contains(ua, "kube-probe") {
		return true
	}
	return false
}

func (c *Client) SearchTraces(ctx context.Context, serviceName string, limit int, startSec, endSec int64) ([]models.Trace, error) {
	if limit <= 0 {
		limit = 20
	}
	fetchLimit := limit * 8
	if fetchLimit < 100 {
		fetchLimit = 100
	}

	searchWithQuery := func(minDur string) ([]models.Trace, error) {
		params := url.Values{}
		if serviceName != "" {
			params.Set("tags", fmt.Sprintf("service.name=%s", serviceName))
		}
		params.Set("limit", strconv.Itoa(fetchLimit))
		if minDur != "" {
			params.Set("minDuration", minDur)
		}
		// Explicit window so the header's time-range control governs trace
		// search the same way it governs metrics and logs. 0 means "let
		// Tempo apply its own default".
		if startSec > 0 && endSec > startSec {
			params.Set("start", strconv.FormatInt(startSec, 10))
			params.Set("end", strconv.FormatInt(endSec, 10))
		}

		u := fmt.Sprintf("%s/api/search?%s", c.baseURL, params.Encode())
		req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("tempo search failed: %w", err)
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, err
		}

		var searchResp searchResponse
		if err := json.Unmarshal(body, &searchResp); err != nil {
			return nil, fmt.Errorf("failed to parse tempo response: %w", err)
		}

		candidates := make([]tempoTrace, 0, len(searchResp.Traces))
		for _, t := range searchResp.Traces {
			if isSystemOrHealthOperation(t.RootTraceName) {
				continue
			}
			candidates = append(candidates, t)
		}

		traces := []models.Trace{}
		// Fetch a bounded batch at a time. This reduces serial wait time while
		// preserving search order and avoiding detail requests after the limit is met.
		for start := 0; start < len(candidates) && len(traces) < limit; start += traceFetchWorkers {
			end := min(start+traceFetchWorkers, len(candidates))
			traceSpans := make([][]models.Span, end-start)
			var workers sync.WaitGroup
			for i := start; i < end; i++ {
				workers.Add(1)
				go func(traceIndex int) {
					defer workers.Done()
					traceID := candidates[traceIndex].TraceID
					spans, err := c.GetTrace(ctx, traceID)
					if err == nil {
						traceSpans[traceIndex-start] = spans
					} else {
						slog.Warn("could not load Tempo trace details", "trace_id", traceID, "error", err)
					}
				}(i)
			}
			workers.Wait()

			for i, t := range candidates[start:end] {
				spans := traceSpans[i]
				if len(spans) == 0 {
					continue
				}
				cleanSpans := make([]models.Span, 0, len(spans))
				for _, s := range spans {
					if !isSystemOrHealthSpan(s) {
						cleanSpans = append(cleanSpans, s)
					}
				}
				if len(cleanSpans) == 0 {
					continue
				}
				// Beyla can omit parent links on multiplexed HTTP/2 and gRPC
				// connections. In that partial tree, the first parentless span in
				// Tempo's response is not necessarily the transaction entry point.
				// Use the earliest visible span for the display label and mark the
				// choice when the parent tree or Tempo's index does not confirm it.
				earliest := &cleanSpans[0]
				parentlessCount := 0
				for i := range cleanSpans {
					span := &cleanSpans[i]
					if span.ParentSpanID == "" {
						parentlessCount++
					}
					if span.StartTime > 0 && (earliest.StartTime == 0 || span.StartTime < earliest.StartTime) {
						earliest = span
					}
				}
				// The root choice is INFERRED only when the observed span tree
				// itself is ambiguous: multiple disconnected roots, or an earliest
				// span that still claims a parent. Tempo's index root is advisory
				// only — it frequently reports the first-received batch or "root
				// span not yet received" while streaming — so disagreement with it
				// does NOT make our earliest-observed-root choice an inference.
				rootInferred := earliest.StartTime == 0 || earliest.ParentSpanID != "" || parentlessCount != 1
				// Skip traces whose entry point is a health probe (e.g. GET
				// /_healthz from kubelet). The EARLIEST span is checked, not
				// spans[0]: Tempo returns batches in arbitrary order, so index 0
				// was silently skipping or keeping the wrong traces.
				if isSystemOrHealthSpan(*earliest) {
					continue
				}
				// Degenerate-trace guard: when a long-lived multiplexed connection
				// loses per-stream context, hundreds of unrelated spans can share
				// one trace id with no parent links at all (observed 2026-10-27: a
				// Tempo search entry whose trace held 300+ disconnected roots, too
				// large even for GetTrace's fetch timeout). It renders as an
				// unusable waterfall; skip it from listings.
				if parentlessCount > maxParentlessSpans {
					continue
				}
				rootServiceName := earliest.ServiceName
				rootTraceName := earliest.OperationName
				traces = append(traces, models.Trace{
					TraceID:         t.TraceID,
					RootServiceName: rootServiceName,
					RootTraceName:   rootTraceName,
					RootInferred:    rootInferred,
					DurationMs:      t.DurationMs,
					SpanCount:       len(cleanSpans),
					Spans:           cleanSpans,
				})
				if len(traces) >= limit {
					break
				}
			}
		}
		return traces, nil
	}

	// 1. Try querying genuine transactions with duration >= 2ms (excludes sub-ms kubelet probes)
	res, err := searchWithQuery("2ms")
	if err == nil && len(res) >= limit {
		return res, nil
	}

	// 2. If fewer than limit returned, fallback to querying without minDuration
	fallbackRes, fallbackErr := searchWithQuery("")
	if fallbackErr == nil && len(fallbackRes) > len(res) {
		return fallbackRes, nil
	}
	// A failed fallback query must not discard valid results from the first one.
	if len(res) > 0 {
		return res, nil
	}
	if err == nil {
		err = fallbackErr
	}
	return res, err
}

// Health probes the Tempo readiness endpoint (monolithic mode exposes every
// service endpoint, including /ready, on the single tempo service).
func (c *Client) Health(ctx context.Context) error {
	u := fmt.Sprintf("%s/ready", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("tempo health check failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("tempo unhealthy: status %d", resp.StatusCode)
	}
	return nil
}

func (c *Client) GetTrace(ctx context.Context, traceID string) ([]models.Span, error) {
	if spans, ok := c.cachedTrace(traceID); ok {
		return spans, nil
	}

	u := fmt.Sprintf("%s/api/traces/%s", c.baseURL, traceID)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tempo trace fetch failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var traceResp traceResponse
	if err := json.Unmarshal(body, &traceResp); err != nil {
		return nil, fmt.Errorf("failed to parse trace response: %w", err)
	}

	var spans []models.Span
	for _, batch := range traceResp.Batches {
		serviceName := extractServiceName(batch.Resource.Attributes)
		for _, scope := range batch.ScopeSpans {
			for _, raw := range scope.Spans {
				startNano, _ := strconv.ParseInt(raw.StartTimeUnixNano, 10, 64)
				// Tempo's OTLP JSON reports an absolute end time, not a duration.
				endNano, _ := strconv.ParseInt(raw.EndTimeUnixNano, 10, 64)
				durNano := endNano - startNano
				if durNano < 0 {
					durNano = 0
				}

				attrs := make(map[string]string)
				for _, a := range raw.Attributes {
					attrs[a.Key] = a.Value.StringValue
				}

				opName := raw.Name
				if bareHTTPMethod.MatchString(opName) {
					if path, ok := attrs["url.path"]; ok && path != "" {
						opName = fmt.Sprintf("%s %s", raw.Name, path)
					} else if target, ok := attrs["http.target"]; ok && target != "" {
						opName = fmt.Sprintf("%s %s", raw.Name, target)
					} else if route, ok := attrs["http.route"]; ok && route != "" {
						opName = fmt.Sprintf("%s %s", raw.Name, route)
					}
				}
				// OBI's generic (non-Go) tracer cannot decode the HPACK-
				// compressed :path of multiplexed HTTP/2 gRPC calls, so those
				// client spans export the semconv placeholder rpc.method=
				// "_OTHER" and the generic name "grpc" (Go services get real
				// methods via grpc-go uprobes). Enrich the display name with
				// what WAS observed: the method when present, else the target.
				if isGenericRPCName(opName) {
					if m := attrs["rpc.method"]; m != "" && m != "_OTHER" {
						opName = m
					} else if target := attrs["server.address"]; target != "" {
						system := attrs["rpc.system.name"]
						if system == "" {
							system = "rpc"
						}
						opName = fmt.Sprintf("%s %s", system, target)
					}
				}

				kind := normalizeSpanKind(raw.Kind)
				span := models.Span{
					TraceID:       raw.TraceID,
					SpanID:        raw.SpanID,
					ParentSpanID:  raw.ParentSpanID,
					Kind:          kind,
					OperationName: opName,
					ServiceName:   serviceName,
					StartTime:     startNano,
					Duration:      durNano,
					StatusCode:    raw.Status.Code,
					Attributes:    attrs,
				}
				if kind != "" {
					attrs["span.kind"] = kind
				}
				if isSystemOrHealthSpan(span) {
					continue
				}
				spans = append(spans, span)
			}
		}
	}
	reparentOrphanSpans(spans)
	c.cacheTrace(traceID, spans)
	return spans, nil
}

func (c *Client) cachedTrace(traceID string) ([]models.Span, bool) {
	now := time.Now()
	c.traceCacheMu.Lock()
	defer c.traceCacheMu.Unlock()

	entry, ok := c.traceCache[traceID]
	if !ok {
		return nil, false
	}
	if !now.Before(entry.expiresAt) {
		delete(c.traceCache, traceID)
		return nil, false
	}
	return cloneSpans(entry.spans), true
}

func (c *Client) cacheTrace(traceID string, spans []models.Span) {
	now := time.Now()
	c.traceCacheMu.Lock()
	defer c.traceCacheMu.Unlock()
	if c.traceCache == nil {
		c.traceCache = make(map[string]cachedTrace)
	}

	for id, entry := range c.traceCache {
		if !now.Before(entry.expiresAt) {
			delete(c.traceCache, id)
		}
	}
	if _, exists := c.traceCache[traceID]; !exists && len(c.traceCache) >= maxTraceCacheEntries {
		var oldestID string
		var oldestExpiry time.Time
		for id, entry := range c.traceCache {
			if oldestID == "" || entry.expiresAt.Before(oldestExpiry) {
				oldestID = id
				oldestExpiry = entry.expiresAt
			}
		}
		delete(c.traceCache, oldestID)
	}
	c.traceCache[traceID] = cachedTrace{
		spans:     cloneSpans(spans),
		expiresAt: now.Add(traceCacheTTL),
	}
}

func cloneSpans(spans []models.Span) []models.Span {
	cloned := make([]models.Span, len(spans))
	for i, span := range spans {
		cloned[i] = span
		if span.Attributes != nil {
			cloned[i].Attributes = make(map[string]string, len(span.Attributes))
			for key, value := range span.Attributes {
				cloned[i].Attributes[key] = value
			}
		}
	}
	return cloned
}

// reparentOrphanSpans repairs the known eBPF-collection limitation on
// long-lived multiplexed HTTP/2/gRPC connections: Beyla's context tracking is
// per CONNECTION, so on multiplexed streams a CLIENT span is exported without
// the in-process call-site span that issued it. The missing parent is always
// the CALLER's own next-level span. Two orphan shapes appear in Tempo data
// (2026-10-27 baseline, 120 traces): a DANGLING parent id pointing at a span
// that was never exported, and an EMPTY parent id — e.g. recommendationservice
// -> productcatalogservice gRPC calls exported as name "*" with no parent id
// at all in 42/120 traces. Both are repaired the same way.
//
// The causality is still constrained by observable facts: the client span
// names its target (server.address), starts strictly after its caller's span
// began, and ends within the caller's window. So for each orphan CLIENT span
// we search the SAME service's non-client spans (its server span for inbound
// work, its internal spans) for the latest one whose window
// [start, start+duration] contains the orphan's start, and re-attach there.
// A client span with NO plausible host span in its own service is the
// transaction entry point (e.g. loadgenerator, which serves nothing) and is
// left as a root. That link is an INFERENCE, not an observation, so
// ParentInferred is set and the UI must render it differently from observed
// links.
func reparentOrphanSpans(spans []models.Span) {
	ids := make(map[string]struct{}, len(spans))
	for _, s := range spans {
		ids[s.SpanID] = struct{}{}
	}

	type hostSpan struct {
		start, end int64
		idx        int
	}
	// service -> that service's spans that can host a client call (server + internal)
	hosts := make(map[string][]hostSpan)
	for i, s := range spans {
		if !isClientSpan(s) {
			hosts[s.ServiceName] = append(hosts[s.ServiceName], hostSpan{start: s.StartTime, end: s.StartTime + s.Duration, idx: i})
		}
	}

	for i := range spans {
		s := &spans[i]
		if !isClientSpan(*s) {
			continue // only client spans lose their call-site parent
		}
		if s.ParentSpanID != "" {
			if _, ok := ids[s.ParentSpanID]; ok {
				continue // parent present: nothing to repair
			}
		}

		candidates := hosts[s.ServiceName]
		best := -1
		var bestStart int64
		for _, c := range candidates {
			// client call must start inside the hosting span's window
			if s.StartTime >= c.start && s.StartTime <= c.end {
				if best == -1 || c.start > bestStart {
					best = c.idx
					bestStart = c.start
				}
			}
		}
		if best == -1 {
			continue // no plausible host span: leave it as the transaction root
		}
		s.ParentSpanID = spans[best].SpanID
		s.ParentInferred = true
	}
}

func isClientSpan(s models.Span) bool {
	if s.Kind != "" {
		return s.Kind == "client"
	}
	return strings.Contains(strings.ToLower(s.Attributes["span.kind"]), "client")
}

// normalizeSpanKind converts the OTLP JSON span-kind enum ("SPAN_KIND_CLIENT")
// to its lowercase semantic name ("client"); "" stays "".
func normalizeSpanKind(kind string) string {
	kind = strings.TrimSpace(kind)
	kind = strings.TrimPrefix(kind, "SPAN_KIND_")
	return strings.ToLower(kind)
}

// isGenericRPCName reports whether a span name is an exporter placeholder
// rather than a real operation ("grpc" from OBI's unmatched-route heuristic,
// "*" from Beyla, "_OTHER" from the semconv unknown-value convention).
func isGenericRPCName(name string) bool {
	return name == "grpc" || name == "*" || name == "_OTHER"
}

func extractServiceName(attrs []spanAttr) string {
	for _, a := range attrs {
		if a.Key == "service.name" {
			return a.Value.StringValue
		}
	}
	return "unknown"
}
