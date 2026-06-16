package models

type UISettings struct {
	Theme           string            `json:"theme"`
	RefreshInterval int               `json:"refreshInterval"`
	TimeWindow      string            `json:"timeWindow"`
	Namespace       string            `json:"namespace"`
	Thresholds      ThresholdSettings `json:"thresholds"`
	Display         DisplaySettings   `json:"display"`
}

type ThresholdSettings struct {
	ErrorRateWarning  float64 `json:"errorRateWarning"`
	ErrorRateCritical float64 `json:"errorRateCritical"`
	LatencyWarning    float64 `json:"latencyWarning"`
	LatencyCritical   float64 `json:"latencyCritical"`
	CPUWarning        float64 `json:"cpuWarning"`
	CPUCritical       float64 `json:"cpuCritical"`
	MemoryWarning     float64 `json:"memoryWarning"`
	MemoryCritical    float64 `json:"memoryCritical"`
}

type DisplaySettings struct {
	ShowAnnotations   bool `json:"showAnnotations"`
	ShowProtocolStats bool `json:"showProtocolStats"`
	ShowK8sMetadata   bool `json:"showK8sMetadata"`
}

type Baseline struct {
	Service   string  `json:"service"`
	Endpoint  string  `json:"endpoint"`
	Metric    string  `json:"metric"`
	Value     float64 `json:"value"`
	Window    string  `json:"window"`
	UpdatedAt string  `json:"updatedAt"`
}

type HealthResponse struct {
	Status     string `json:"status"`
	Prometheus string `json:"prometheus"`
	Loki       string `json:"loki"`
	Tempo      string `json:"tempo"`
	K8s        string `json:"k8s"`
}
