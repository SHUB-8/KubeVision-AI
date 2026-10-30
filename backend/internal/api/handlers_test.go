package api

import (
	"testing"

	"github.com/kubevision/backend/models"
)

func TestServiceMetricProvenanceInvariant(t *testing.T) {
	services := map[string]*models.Service{
		"frontend":   {},
		"redis-cart": {},
		"no-source":  {},
	}

	setServiceRate(services["frontend"], 12.5, models.SourceMetrics)
	setServiceLatency(services["frontend"], 0.042, models.SourceMetrics)
	setServiceRate(services["no-source"], 8.0, "")
	setServiceLatency(services["no-source"], 0.2, "")
	if services["no-source"].Rate != 0 || services["no-source"].RateSource != "" {
		t.Errorf("unlabelled rate should be absent, got value=%v source=%q", services["no-source"].Rate, services["no-source"].RateSource)
	}
	if services["no-source"].LatencyP95 != 0 || services["no-source"].LatencySource != "" {
		t.Errorf("unlabelled latency should be absent, got value=%v source=%q", services["no-source"].LatencyP95, services["no-source"].LatencySource)
	}

	enrichMissingServiceRatesFromTopology(services, []models.Edge{
		{Source: "frontend", Target: "redis-cart", Rate: 4.0, RateSource: models.SourceEstimated},
		{Source: "frontend", Target: "no-source", Rate: 9.0},
	})

	if got := services["redis-cart"].RateSource; got != models.SourceEstimated {
		t.Errorf("borrowed rate source = %q, want %q", got, models.SourceEstimated)
	}
	if got := services["no-source"].Rate; got != 0 {
		t.Errorf("service with an unlabelled edge received rate %v, want 0", got)
	}

	for name, svc := range services {
		if svc.Rate > 0 && svc.RateSource == "" {
			t.Errorf("service %q has rate %v with no source", name, svc.Rate)
		}
		if svc.LatencyP95 > 0 && svc.LatencySource == "" {
			t.Errorf("service %q has p95 latency %v with no source", name, svc.LatencyP95)
		}
	}
}
