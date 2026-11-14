package services

import (
	"math"
	"testing"

	"github.com/kubevision/backend/models"
)

// TestNodeLatencyPrefersServerSideMetrics verifies that when a service node
// has its own server-side latency measured from Prometheus (RED golden signal),
// that server-side latency is preserved, rather than being overwritten by
// an aberrant edge latency.
func TestNodeLatencyPrefersServerSideMetrics(t *testing.T) {
	node := models.Node{ID: "frontend", Label: "frontend", Type: "service"}
	edges := []models.Edge{
		{
			ID:         "e1",
			Source:     "loadgenerator",
			Target:     "frontend",
			Rate:       3.0,
			LatencyP95: 0.020, // 20 ms
		},
		{
			ID:         "e2",
			Source:     "slow-probe",
			Target:     "frontend",
			Rate:       0.01,
			LatencyP95: 10.0, // 10s timeout artifact
		},
	}
	serverLatencies := map[string]float64{
		"frontend": 0.0185, // 18.5 ms measured server-side
	}

	var totalInboundRate float64
	var weightedLatencySum float64
	var totalLatencyRate float64
	var totalErrors float64
	rateSource := ""
	latencySource := ""

	for _, e := range edges {
		if e.Target == node.ID {
			totalInboundRate += e.Rate
			if e.Rate > 0 {
				rateSource = weakerSource(rateSource, e.RateSource)
			}
			if e.LatencyP95 > 0 && e.Rate > 0 {
				weightedLatencySum += e.LatencyP95 * e.Rate
				totalLatencyRate += e.Rate
				latencySource = weakerSource(latencySource, e.LatencySource)
			}
			totalErrors += e.ErrorRate * e.Rate
		}
	}

	if totalInboundRate > 0 {
		node.Rate = totalInboundRate
		node.RateSource = rateSource
		node.ErrorRate = totalErrors / totalInboundRate

		if sLat, ok := serverLatencies[node.ID]; ok && sLat > 0 {
			node.LatencyP95 = sLat
			node.LatencySource = models.SourceMetrics
		} else if totalLatencyRate > 0 {
			node.LatencyP95 = weightedLatencySum / totalLatencyRate
			node.LatencySource = latencySource
		}
	}

	if math.Abs(node.LatencyP95-0.0185) > 1e-4 {
		t.Fatalf("expected node latency to equal server-side latency 0.0185s (18.5ms), got %f", node.LatencyP95)
	}
	if node.LatencyP95 >= 1.0 {
		t.Fatalf("node latency was corrupted by 10s edge timeout: got %f", node.LatencyP95)
	}
}

// TestNodeLatencyWeightedFallbackWhenServerMetricsAbsent verifies that when
// server-side latency is missing (e.g. datastore like redis-cart), the node
// calculates traffic-weighted latency instead of taking max(e.LatencyP95).
func TestNodeLatencyWeightedFallbackWhenServerMetricsAbsent(t *testing.T) {
	node := models.Node{ID: "redis-cart", Label: "redis-cart", Type: "service"}
	edges := []models.Edge{
		{
			ID:         "e1",
			Source:     "cartservice",
			Target:     "redis-cart",
			Rate:       100.0,
			LatencyP95: 0.005, // 5 ms at 100 req/s
		},
		{
			ID:         "e2",
			Source:     "stray-scanner",
			Target:     "redis-cart",
			Rate:       0.1,
			LatencyP95: 10.0, // 10s timeout on 0.1 req/s
		},
	}
	serverLatencies := map[string]float64{} // No server metrics

	var totalInboundRate float64
	var weightedLatencySum float64
	var totalLatencyRate float64
	var totalErrors float64
	rateSource := ""
	latencySource := ""

	for _, e := range edges {
		if e.Target == node.ID {
			totalInboundRate += e.Rate
			if e.Rate > 0 {
				rateSource = weakerSource(rateSource, e.RateSource)
			}
			if e.LatencyP95 > 0 && e.Rate > 0 {
				weightedLatencySum += e.LatencyP95 * e.Rate
				totalLatencyRate += e.Rate
				latencySource = weakerSource(latencySource, e.LatencySource)
			}
			totalErrors += e.ErrorRate * e.Rate
		}
	}

	if totalInboundRate > 0 {
		node.Rate = totalInboundRate
		node.RateSource = rateSource
		node.ErrorRate = totalErrors / totalInboundRate

		sLat, hasServer := serverLatencies[node.ID]
		weightedCallerLat := 0.0
		if totalLatencyRate > 0 {
			weightedCallerLat = weightedLatencySum / totalLatencyRate
		}

		if hasServer && sLat > 0 && !(sLat >= 10.0 && weightedCallerLat > 0 && weightedCallerLat < 5.0) {
			node.LatencyP95 = sLat
			node.LatencySource = models.SourceMetrics
		} else if weightedCallerLat > 0 {
			node.LatencyP95 = weightedCallerLat
			node.LatencySource = latencySource
		} else if hasServer && sLat > 0 {
			node.LatencyP95 = sLat
			node.LatencySource = models.SourceMetrics
		}
	}

	// Expected: (100 * 0.005 + 0.1 * 10.0) / 100.1 = (0.5 + 1.0) / 100.1 = 0.01498s (~15ms)
	// Under the old max() bug, this would have been 10.0s (10000ms)!
	if node.LatencyP95 >= 1.0 {
		t.Fatalf("expected rate-weighted latency (~0.015s), but got unweighted max skew: %f", node.LatencyP95)
	}
	expectedWeighted := (100.0*0.005 + 0.1*10.0) / 100.1
	if math.Abs(node.LatencyP95-expectedWeighted) > 1e-4 {
		t.Fatalf("expected rate-weighted latency %f, got %f", expectedWeighted, node.LatencyP95)
	}
}

// TestNodeLatencyRejects10sArtifactWhenCallersAreFast verifies that when Prometheus
// histogram_quantile pegs at the maximum finite bucket boundary (10.0s) due to
// extrapolation or small sample size, but callers observe normal fast latencies (<5s),
// the node rejects the 10.0s artifact and reports the caller-observed latency.
func TestNodeLatencyRejects10sArtifactWhenCallersAreFast(t *testing.T) {
	node := models.Node{ID: "frontend", Label: "frontend", Type: "service"}
	edges := []models.Edge{
		{
			ID:         "e1",
			Source:     "loadgenerator",
			Target:     "frontend",
			Rate:       1.5,
			LatencyP95: 0.045, // 45ms observed by caller
		},
	}
	serverLatencies := map[string]float64{
		"frontend": 10.0, // Prometheus histogram 10s extrapolation peg
	}

	var totalInboundRate float64
	var weightedLatencySum float64
	var totalLatencyRate float64
	var totalErrors float64
	rateSource := ""
	latencySource := ""

	for _, e := range edges {
		if e.Target == node.ID {
			totalInboundRate += e.Rate
			if e.Rate > 0 {
				rateSource = weakerSource(rateSource, e.RateSource)
			}
			if e.LatencyP95 > 0 && e.Rate > 0 {
				weightedLatencySum += e.LatencyP95 * e.Rate
				totalLatencyRate += e.Rate
				latencySource = weakerSource(latencySource, e.LatencySource)
			}
			totalErrors += e.ErrorRate * e.Rate
		}
	}

	if totalInboundRate > 0 {
		node.Rate = totalInboundRate
		node.RateSource = rateSource
		node.ErrorRate = totalErrors / totalInboundRate

		sLat, hasServer := serverLatencies[node.ID]
		weightedCallerLat := 0.0
		if totalLatencyRate > 0 {
			weightedCallerLat = weightedLatencySum / totalLatencyRate
		}

		if hasServer && sLat > 0 && !(sLat >= 10.0 && weightedCallerLat > 0 && weightedCallerLat < 5.0) {
			node.LatencyP95 = sLat
			node.LatencySource = models.SourceMetrics
		} else if weightedCallerLat > 0 {
			node.LatencyP95 = weightedCallerLat
			node.LatencySource = latencySource
		} else if hasServer && sLat > 0 {
			node.LatencyP95 = sLat
			node.LatencySource = models.SourceMetrics
		}
	}

	if node.LatencyP95 >= 10.0 {
		t.Fatalf("expected 10.0s artifact to be rejected, but got %f", node.LatencyP95)
	}
	if math.Abs(node.LatencyP95-0.045) > 1e-4 {
		t.Fatalf("expected caller latency 0.045s (45ms), got %f", node.LatencyP95)
	}
}
