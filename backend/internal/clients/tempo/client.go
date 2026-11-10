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
	"sort"
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

	// languages maps service name -> runtime language as reported by the
	// telemetry.sdk.language resource attribute every OBI-instrumented trace
	// batch carries. Populated opportunistically while parsing traces. Guarded
	// by langsMu together with langVotes / warmAt / warming.
	langsMu sync.Mutex
	langs   map[string]string
	// langVotes counts observations per service/language so a single
	// mis-attributed span cannot flip a service's language.
	langVotes map[string]map[string]int
	warmAt    time.Time
	warming   bool
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
	// `limit` after degenerate / health-only traces are filtered out. Tempo
	// truncates its result stream BEFORE ordering it, so a small limit can miss
	// the newest traces entirely (observed 2026-11-07: limit=100 returned
	// ~4-minute-old traces while limit=400 returned ~30-second-old ones).
	// Always ask for a large pool and sort it ourselves.
	traceSearchOversample = 8
	minSearchCandidates   = 1000
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
	fetchLimit := limit * traceSearchOversample
	if fetchLimit < minSearchCandidates {
		fetchLimit = minSearchCandidates
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
		// Tempo's response order is an artifact of its truncated internal
		// stream, not a guarantee. Order the candidates by start time so the
		// newest traces are the ones whose details we fetch.
		sort.SliceStable(candidates, func(i, j int) bool {
			si, sj := candidateStartUnixNano(candidates[i]), candidateStartUnixNano(candidates[j])
			if si == sj {
				return candidates[i].TraceID < candidates[j].TraceID
			}
			return si > sj
		})

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
		sortTracesByStartDesc(traces)
		return traces, nil
	}

	// 1. Query genuine transactions with duration >= 2ms (excludes sub-ms
	//    kubelet probes). This is the set we want.
	res, err := searchWithQuery("2ms")

	// 2. Query without minDuration only when the first query produced NOTHING.
	//    Previously a larger fallback set silently replaced a shorter fresh set,
	//    which made the list jump between ~30s-old and ~2-4min-old traces on
	//    every refresh. A smaller fresh list is better than a larger stale one.
	var fallbackRes []models.Trace
	var fallbackErr error
	if err != nil || len(res) == 0 {
		fallbackRes, fallbackErr = searchWithQuery("")
	}
	return chooseSearchResult(res, err, fallbackRes, fallbackErr)
}

// candidateStartUnixNano reads Tempo's startTimeUnixNano metadata for ordering.
func candidateStartUnixNano(t tempoTrace) int64 {
	if t.StartTimeUnixNano == "" {
		return 0
	}
	v, err := strconv.ParseInt(t.StartTimeUnixNano, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// sortTracesByStartDesc orders traces newest-first with a stable trace-id
// tie-breaker, so repeated searches for the same window return the same order.
func sortTracesByStartDesc(traces []models.Trace) {
	sort.SliceStable(traces, func(i, j int) bool {
		si, sj := traceEarliestSpanStart(traces[i]), traceEarliestSpanStart(traces[j])
		if si == sj {
			return traces[i].TraceID < traces[j].TraceID
		}
		return si > sj
	})
}

func traceEarliestSpanStart(t models.Trace) int64 {
	var earliest int64
	for _, span := range t.Spans {
		if span.StartTime > 0 && (earliest == 0 || span.StartTime < earliest) {
			earliest = span.StartTime
		}
	}
	return earliest
}

// chooseSearchResult implements the freshness policy: a non-empty primary
// result always wins, even when it is shorter than requested; the fallback is
// only considered when the primary produced nothing.
func chooseSearchResult(primary []models.Trace, primaryErr error, fallback []models.Trace, fallbackErr error) ([]models.Trace, error) {
	if primaryErr == nil && len(primary) > 0 {
		return primary, nil
	}
	if fallbackErr == nil && len(fallback) > 0 {
		return fallback, nil
	}
	if primaryErr != nil {
		return primary, primaryErr
	}
	if fallbackErr != nil {
		return fallback, fallbackErr
	}
	return primary, nil
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
				if lang := strings.TrimSpace(resourceAttr(batch.Resource.Attributes, "telemetry.sdk.language")); lang != "" && serviceName != "" {
					c.noteLanguage(serviceName, lang)
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
	enrichGenericRPCNames(spans)
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

// enrichGenericRPCNames recovers the operation name for spans whose RPC method
// was never captured on the wire.
//
// OBI's generic (non-Go) tracer can only decode the HPACK-compressed :path of
// an HTTP/2/gRPC connection when it observed that connection from its first
// byte. For connections that existed before OBI attached - the normal case
// when OBI is installed into a cluster whose workloads are already running -
// the method degrades to the semconv placeholder "_OTHER" and the span name to
// "grpc". The other end of the same call usually DID capture the method (Go
// callers through uprobes, or the other side's instrumentation), so for each
// generic span we look for the paired span of the opposite kind in the same
// trace that covers the same RPC target and the same time window, and copy its
// method.
//
// This is an inference, not an observation: RPCNameInferred is set and the UI
// must label it. The copied value is also written to "rpc.method" so the
// detail panel is coherent; an exporter-supplied "rpc.method_original" is left
// untouched.
func enrichGenericRPCNames(spans []models.Span) {
	type candidate struct {
		generic int
		source  int
		score   int
	}

	generic := make([]int, 0)
	for i := range spans {
		if spans[i].RPCNameInferred {
			continue
		}
		if isGenericRPCSpan(spans[i]) {
			generic = append(generic, i)
		}
	}
	if len(generic) == 0 {
		return
	}

	candidates := make([]candidate, 0)
	for _, gi := range generic {
		for si := range spans {
			if si == gi || spans[si].RPCNameInferred {
				continue
			}
			score, ok := rpcPairScore(spans[gi], spans[si])
			if !ok {
				continue
			}
			candidates = append(candidates, candidate{generic: gi, source: si, score: score})
		}
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].score < candidates[j].score
	})

	usedGeneric := make(map[int]bool, len(generic))
	usedSource := make(map[int]bool, len(candidates))
	for _, cand := range candidates {
		if usedGeneric[cand.generic] || usedSource[cand.source] {
			continue
		}
		method, ok := concreteRPCMethod(spans[cand.source])
		if !ok {
			continue
		}
		target := &spans[cand.generic]
		target.OperationName = method
		if target.Attributes == nil {
			target.Attributes = make(map[string]string)
		}
		target.Attributes["rpc.method"] = method
		target.Attributes["kubevision.rpc_method_inferred"] = "true"
		target.RPCNameInferred = true
		usedGeneric[cand.generic] = true
		usedSource[cand.source] = true
	}
}

// isGenericRPCSpan reports whether a span's operation name is an exporter
// placeholder rather than a captured method. It also covers the display names
// built earlier in GetTrace ("grpc <target>" / "rpc <target>") for spans whose
// method was already known to be missing.
func isGenericRPCSpan(s models.Span) bool {
	if isGenericRPCName(s.OperationName) {
		return true
	}
	if strings.HasPrefix(s.OperationName, "grpc ") || strings.HasPrefix(s.OperationName, "rpc ") {
		return true
	}
	return strings.TrimSpace(s.Attributes["rpc.method"]) == "_OTHER"
}

// concreteRPCMethod returns the captured gRPC method of a span, if it has one.
// gRPC methods are "package.Service/Method"; bare HTTP verbs and route names
// are not accepted.
func concreteRPCMethod(s models.Span) (string, bool) {
	method := strings.TrimSpace(s.Attributes["rpc.method"])
	if method == "" || method == "_OTHER" || isGenericRPCName(method) {
		return "", false
	}
	if !strings.Contains(method, "/") {
		return "", false
	}
	return method, true
}

// rpcPairScore decides whether two spans are the two ends of the same RPC and
// returns a preference score (lower is better). The generic span must be one
// end (client or server), the candidate the opposite end, their time windows
// must overlap with a small tolerance, and they must agree on the RPC target
// (service name best, port as a fallback when the exporter recorded an IP).
func rpcPairScore(generic, candidate models.Span) (int, bool) {
	gKind, cKind := generic.Kind, candidate.Kind
	if gKind == "" || cKind == "" || gKind == cKind {
		return 0, false
	}
	if (gKind == "server" && cKind != "client") || (gKind == "client" && cKind != "server") {
		return 0, false
	}

	const tolerance = int64(2 * time.Millisecond)
	var client, server models.Span
	if gKind == "client" {
		client, server = generic, candidate
	} else {
		client, server = candidate, generic
	}
	clientStart, clientEnd := client.StartTime, client.StartTime+client.Duration
	if server.StartTime < clientStart-tolerance || server.StartTime > clientEnd+tolerance {
		return 0, false
	}

	targetScore, ok := rpcTargetScore(client, server)
	if !ok {
		return 0, false
	}
	return abs64(server.StartTime-clientStart) + targetScore, true
}

// rpcTargetScore checks that a CLIENT span was talking to the given SERVER
// span's service. A service-name match is preferred; a resolved pod-IP match is
// next; a port match is the last-resort signal because ports are not unique
// across a cluster.
func rpcTargetScore(client, server models.Span) (int, bool) {
	address := strings.TrimSpace(client.Attributes["server.address"])
	if address == "" {
		address = strings.TrimSpace(client.Attributes["peer.service"])
	}
	if address == "" {
		address = strings.TrimSpace(client.Attributes["net.peer.name"])
	}
	if address != "" {
		if address == server.ServiceName {
			return 0, true
		}
	}

	clientPort := strings.TrimSpace(client.Attributes["server.port"])
	serverPort := strings.TrimSpace(server.Attributes["server.port"])
	if clientPort != "" && serverPort != "" && clientPort == serverPort {
		return 50, true
	}
	return 0, false
}

func abs64(v int64) int {
	if v < 0 {
		return int(-v)
	}
	return int(v)
}

func extractServiceName(attrs []spanAttr) string {
	for _, a := range attrs {
		if a.Key == "service.name" {
			return a.Value.StringValue
		}
	}
	return "unknown"
}

// noteLanguage records the runtime language of a service as reported by its
// resource attributes (telemetry.sdk.language). The winner is the language with
// the most observations, not the newest one: OBI can attribute a helper process
// to a service (documented behaviour under hostPID / port-based selection), and
// a single such span must not relabel the service. A conflicting observation
// only takes over once it outnumbers the incumbent.
func (c *Client) noteLanguage(service, lang string) {
	service = strings.TrimSpace(service)
	lang = strings.ToLower(strings.TrimSpace(lang))
	if service == "" || lang == "" {
		return
	}
	c.langsMu.Lock()
	defer c.langsMu.Unlock()
	if c.langs == nil {
		c.langs = make(map[string]string)
	}
	if c.langVotes == nil {
		c.langVotes = make(map[string]map[string]int)
	}
	votes := c.langVotes[service]
	if votes == nil {
		votes = make(map[string]int)
		c.langVotes[service] = votes
	}
	votes[lang]++
	if votes[lang] > votes[c.langs[service]] {
		c.langs[service] = lang
	}
}

// ServiceLanguages returns a snapshot of service -> language pairs learned so
// far. Empty when no traced service has reported a language yet.
func (c *Client) ServiceLanguages() map[string]string {
	c.langsMu.Lock()
	defer c.langsMu.Unlock()
	out := make(map[string]string, len(c.langs))
	for k, v := range c.langs {
		out[k] = v
	}
	return out
}

// resourceAttr returns a resource attribute's string value from an OTLP batch.
func resourceAttr(attrs []spanAttr, key string) string {
	for _, a := range attrs {
		if a.Key == key {
			return a.Value.StringValue
		}
	}
	return ""
}

const languageWarmInterval = 2 * time.Minute

// WarmServiceLanguages backfills the service-language map after a cold start
// by sampling a handful of recent traces. Languages are otherwise learned as a
// side effect of trace fetches, which only happens once someone browses the
// Traces view. Throttled: while a warm-up ran recently (or is running) it
// returns immediately, so callers may invoke it on every dashboard refresh.
// Runs inline (typically <1s: one search plus up to 8 cached trace fetches);
// call it from a goroutine to keep request latency unchanged.
// languageTraceStartUnixNano parses the start time of a Tempo search result.
// Local to the language warm-up so the feature does not depend on the
// trace-listing helpers.
func languageTraceStartUnixNano(t tempoTrace) int64 {
	if t.StartTimeUnixNano == "" {
		return 0
	}
	v, err := strconv.ParseInt(t.StartTimeUnixNano, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func (c *Client) WarmServiceLanguages(ctx context.Context) {
	c.langsMu.Lock()
	if c.warming || time.Since(c.warmAt) < languageWarmInterval {
		c.langsMu.Unlock()
		return
	}
	c.warming = true
	c.langsMu.Unlock()
	defer func() {
		c.langsMu.Lock()
		c.warming = false
		c.warmAt = time.Now()
		c.langsMu.Unlock()
	}()

	params := url.Values{}
	params.Set("limit", "400")
	params.Set("minDuration", minSearchDuration)
	u := fmt.Sprintf("%s/api/search?%s", c.baseURL, params.Encode())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return
	}
	resp, err := c.client.Do(req)
	if err != nil {
		slog.Warn("language warm-up search failed", "error", err)
		return
	}
	defer resp.Body.Close()
	var searchResp searchResponse
	if err := json.NewDecoder(resp.Body).Decode(&searchResp); err != nil {
		slog.Warn("language warm-up search parse failed", "error", err)
		return
	}

	candidates := make([]tempoTrace, 0, len(searchResp.Traces))
	for _, t := range searchResp.Traces {
		if isSystemOrHealthOperation(t.RootTraceName) {
			continue
		}
		candidates = append(candidates, t)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		return languageTraceStartUnixNano(candidates[i]) > languageTraceStartUnixNano(candidates[j])
	})

	// Diverse sample: one trace per distinct root service so a single chatty
	// root (loadgenerator) cannot monopolise the batch limit.
	seenRoot := make(map[string]struct{}, 16)
	sample := make([]string, 0, 16)
	for _, t := range candidates {
		if _, dup := seenRoot[t.RootServiceName]; dup {
			continue
		}
		seenRoot[t.RootServiceName] = struct{}{}
		sample = append(sample, t.TraceID)
		if len(sample) >= 8 {
			break
		}
	}

	var wg sync.WaitGroup
	for _, id := range sample {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if _, err := c.GetTrace(ctx, id); err != nil {
				slog.Warn("language warm-up trace fetch failed", "trace_id", id, "error", err)
			}
		}(id)
	}
	wg.Wait()
}
