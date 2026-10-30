package api

import (
	"encoding/json"
	"math"
	"strconv"
)

type metricEntry struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`
}

func parseMetricEntries(data json.RawMessage) []metricEntry {
	var results []metricEntry
	if err := json.Unmarshal(data, &results); err != nil {
		return nil
	}
	return results
}

func entryValue(r metricEntry) float64 {
	if len(r.Value) >= 2 {
		switch v := r.Value[1].(type) {
		case float64:
			return finiteMetricValue(v)
		case string:
			f, err := strconv.ParseFloat(v, 64)
			if err == nil {
				return finiteMetricValue(f)
			}
		}
	}
	return 0
}

// Prometheus can return NaN for undefined ratios (0/0) and empty histogram
// quantiles. Those values cannot be encoded as JSON, so treat them as absent
// before they reach an API response.
func finiteMetricValue(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}
