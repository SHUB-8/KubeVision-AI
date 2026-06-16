package models

type Node struct {
	ID        string            `json:"id"`
	Label     string            `json:"label"`
	Type      string            `json:"type"`
	Namespace string            `json:"namespace"`
	Protocol  string            `json:"protocol,omitempty"`
	Labels    map[string]string `json:"labels,omitempty"`
}

type Edge struct {
	ID        string  `json:"id"`
	Source    string  `json:"source"`
	Target    string  `json:"target"`
	Protocol  string  `json:"protocol,omitempty"`
	Rate      float64 `json:"rate,omitempty"`
	ErrorRate float64 `json:"errorRate,omitempty"`
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
	TraceID string `json:"traceId"`
	Spans   []Span `json:"spans"`
}

type LogEntry struct {
	Timestamp string            `json:"timestamp"`
	Stream    string            `json:"stream"`
	Labels    map[string]string `json:"labels,omitempty"`
	Line      string            `json:"line"`
}

type PodInfo struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Status    string `json:"status"`
	Node      string `json:"node"`
	IP        string `json:"ip"`
	Restart   int32  `json:"restarts"`
	Age       string `json:"age"`
}

type ClusterInfo struct {
	Name    string    `json:"name"`
	Version string    `json:"version"`
	Node    string    `json:"node"`
	Status  string    `json:"status"`
	Pods    []PodInfo `json:"pods,omitempty"`
}
