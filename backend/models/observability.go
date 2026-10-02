package models

// Provenance values for RateSource / LatencySource. Every number the UI shows
// must be able to say where it came from: a p95 computed from a handful of
// sampled spans and a histogram_quantile over every request on the wire are
// not the same evidence, and must not look identical on screen.
const (
	// SourceMetrics - measured by eBPF/Beyla, scraped from Prometheus.
	SourceMetrics = "metrics"
	// SourceTraces - derived by this backend from Tempo spans (sampled).
	SourceTraces = "traces"
	// SourceEstimated - borrowed from a peer's measured rate because this
	// service's own L7 protocol is not parsed (e.g. Redis RESP).
	SourceEstimated = "estimated"
)

type Node struct {
	ID         string            `json:"id"`
	Label      string            `json:"label"`
	Type       string            `json:"type"`
	Namespace  string            `json:"namespace"`
	Protocol   string            `json:"protocol,omitempty"`
	Rate       float64           `json:"rate,omitempty"`
	ErrorRate  float64           `json:"errorRate,omitempty"`
	LatencyP95 float64           `json:"latencyP95,omitempty"`
	// RateSource / LatencySource are empty when the value is absent (no data),
	// which is distinct from a measured zero. The frontend renders "no data"
	// for an absent value rather than "0 req/s / 0 ms".
	RateSource    string            `json:"rateSource,omitempty"`
	LatencySource string            `json:"latencySource,omitempty"`
	Labels        map[string]string `json:"labels,omitempty"`
}

type Edge struct {
	ID            string  `json:"id"`
	Source        string  `json:"source"`
	Target        string  `json:"target"`
	Protocol      string  `json:"protocol,omitempty"`
	Rate          float64 `json:"rate,omitempty"`
	ErrorRate     float64 `json:"errorRate,omitempty"`
	LatencyP95    float64 `json:"latencyP95,omitempty"`
	RateSource    string  `json:"rateSource,omitempty"`
	LatencySource string  `json:"latencySource,omitempty"`
}

type Topology struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

type Service struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Status    string            `json:"status"`
	Replicas  int32             `json:"replicas"`
	Ready     int32             `json:"ready"`
	Labels    map[string]string `json:"labels,omitempty"`
	// RED metrics sourced from Beyla via Prometheus. Zero when the service
	// had no traffic in the requested window.
	Rate       float64 `json:"rate"`
	ErrorRate  float64 `json:"errorRate"`
	LatencyP95 float64 `json:"latencyP95"`
}

type Endpoint struct {
	Service    string  `json:"service"`
	Path       string  `json:"path"`
	Method     string  `json:"method,omitempty"`
	LatencyP50 float64 `json:"latencyP50"`
	LatencyP95 float64 `json:"latencyP95"`
	LatencyP99 float64 `json:"latencyP99"`
	Rate       float64 `json:"rate"`
	ErrorRate  float64 `json:"errorRate"`
	// See the Source* constants. "traces" means the value was computed by this
	// backend from sampled spans, not measured from the full request stream.
	RateSource    string `json:"rateSource,omitempty"`
	LatencySource string `json:"latencySource,omitempty"`
}

type Span struct {
	TraceID       string            `json:"traceId"`
	SpanID        string            `json:"spanId"`
	ParentSpanID  string            `json:"parentSpanId,omitempty"`
	OperationName string            `json:"operationName"`
	ServiceName   string            `json:"serviceName"`
	StartTime     int64             `json:"startTime"`
	Duration      int64             `json:"duration"`
	StatusCode    string            `json:"statusCode"`
	Attributes    map[string]string `json:"attributes,omitempty"`
}

type Trace struct {
	TraceID         string `json:"traceId"`
	RootServiceName string `json:"rootServiceName,omitempty"`
	RootTraceName   string `json:"rootTraceName,omitempty"`
	DurationMs      int64  `json:"durationMs,omitempty"`
	SpanCount       int    `json:"spanCount,omitempty"`
	Spans           []Span `json:"spans"`
}

type LogEntry struct {
	Timestamp string            `json:"timestamp"`
	Stream    string            `json:"stream"`
	Labels    map[string]string `json:"labels,omitempty"`
	Line      string            `json:"line"`
}

type PodInfo struct {
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Status       string `json:"status"`
	Node         string `json:"node"`
	IP           string `json:"ip"`
	Restart      int32  `json:"restarts"`
	Age          string `json:"age"`
	WorkloadName string `json:"workloadName,omitempty"`
}

type ClusterInfo struct {
	Name    string    `json:"name"`
	Version string    `json:"version"`
	Node    string    `json:"node"`
	Status  string    `json:"status"`
	Pods    []PodInfo `json:"pods,omitempty"`
}
