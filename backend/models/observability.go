package models

// Provenance values for RateSource / LatencySource. Every number the UI shows
// must be able to say where it came from: a p95 computed from a handful of
// sampled spans and a histogram_quantile over every request on the wire are
// not the same evidence, and must not look identical on screen.
const (
	// SourceMetrics - measured by eBPF/Beyla, scraped from Prometheus.
	SourceMetrics = "metrics"
	// SourceClientObserved - measured on the CALLER side of an interaction and
	// attributed to the target (e.g. a datastore's latency taken from the
	// db_client_* histogram of its callers, because the server-side histogram
	// is unreliable on persistent connections). Real measurements, but of the
	// other endpoint's view of the interaction.
	SourceClientObserved = "client-observed"
	// SourceTraces - derived by this backend from Tempo spans (sampled).
	SourceTraces = "traces"
	// SourceEstimated - borrowed from a peer's measured rate because this
	// service's own L7 protocol is not parsed (e.g. Redis RESP).
	SourceEstimated = "estimated"
)

type Node struct {
	ID         string  `json:"id"`
	Label      string  `json:"label"`
	Type       string  `json:"type"`
	Namespace  string  `json:"namespace"`
	Protocol   string  `json:"protocol,omitempty"`
	Rate       float64 `json:"rate,omitempty"`
	ErrorRate  float64 `json:"errorRate,omitempty"`
	LatencyP95 float64 `json:"latencyP95,omitempty"`
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
	// RED metrics sourced from Beyla via Prometheus or borrowed from a topology
	// edge. Zero when there was no measurement in the requested window.
	Rate          float64 `json:"rate"`
	ErrorRate     float64 `json:"errorRate"`
	LatencyP95    float64 `json:"latencyP95"`
	RateSource    string  `json:"rateSource,omitempty"`
	LatencySource string  `json:"latencySource,omitempty"`
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
	// Sources identify the evidence behind each value. They are empty when the
	// corresponding value was not measured.
	RateSource      string `json:"rateSource,omitempty"`
	ErrorRateSource string `json:"errorRateSource,omitempty"`
	LatencySource   string `json:"latencySource,omitempty"`
}

type Span struct {
	TraceID      string `json:"traceId"`
	SpanID       string `json:"spanId"`
	ParentSpanID string `json:"parentSpanId,omitempty"`
	// Kind is the normalized OTLP span kind ("client", "server", "internal",
	// "producer", "consumer"); empty when the exporter did not set one.
	Kind string `json:"kind,omitempty"`
	// ParentInferred is set when the original parent span was never exported
	// (the known Beyla limitation on long-lived multiplexed HTTP/2/gRPC
	// connections) and this backend re-attached the span to the serving span
	// of its target service using time + target adjacency. The UI must render
	// such links differently from observed ones.
	ParentInferred bool              `json:"parentInferred,omitempty"`
	OperationName  string            `json:"operationName"`
	ServiceName    string            `json:"serviceName"`
	StartTime      int64             `json:"startTime"`
	Duration       int64             `json:"duration"`
	StatusCode     string            `json:"statusCode"`
	Attributes     map[string]string `json:"attributes,omitempty"`
}

type Trace struct {
	TraceID         string `json:"traceId"`
	RootServiceName string `json:"rootServiceName,omitempty"`
	RootTraceName   string `json:"rootTraceName,omitempty"`
	RootInferred    bool   `json:"rootInferred,omitempty"`
	DurationMs      int64  `json:"durationMs,omitempty"`
	SpanCount       int    `json:"spanCount,omitempty"`
	Spans          []Span `json:"spans"`
}

type LogEntry struct {
	Timestamp string            `json:"timestamp"`
	Stream    string            `json:"stream"`
	Labels    map[string]string `json:"labels,omitempty"`
	Line      string            `json:"line"`
}

type KubernetesEvent struct {
	UID                string `json:"uid"`
	Namespace          string `json:"namespace"`
	Name               string `json:"name"`
	Type               string `json:"type"`
	Reason             string `json:"reason"`
	Message            string `json:"message"`
	Count              int32  `json:"count"`
	FirstObservedAt    string `json:"firstObservedAt"`
	LastObservedAt     string `json:"lastObservedAt"`
	InvolvedObjectKind string `json:"involvedObjectKind"`
	InvolvedObjectName string `json:"involvedObjectName"`
	InvolvedObjectUID  string `json:"involvedObjectUid"`
	ReportingComponent string `json:"reportingComponent,omitempty"`
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
