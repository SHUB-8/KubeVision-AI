package api

import (
	"encoding/json"

	"github.com/kubevision/backend/internal/clients/prometheus"
)

type metricEntry = prometheus.VectorResult

func parseMetricEntries(data json.RawMessage) []metricEntry {
	return prometheus.ParseMetricEntries(data)
}

func entryValue(r metricEntry) float64 {
	return r.FloatValue()
}

func finiteMetricValue(value float64) float64 {
	return prometheus.FiniteMetricValue(value)
}
