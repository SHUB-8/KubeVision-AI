package services

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/storage"
	"github.com/kubevision/backend/models"
)

type Baseliner struct {
	store      *storage.Store
	promClient *prometheus.Client
}

func NewBaseliner(store *storage.Store, promClient *prometheus.Client) *Baseliner {
	return &Baseliner{store: store, promClient: promClient}
}

func (b *Baseliner) CalculateBaselines(ctx context.Context, namespace, window string) error {
	if window == "" {
		window = "5m"
	}

	rateData, err := b.promClient.GetServiceRates(namespace, window)
	if err != nil {
		return fmt.Errorf("failed to get rates: %w", err)
	}

	var rateResults []prometheus.VectorResult
	if err := json.Unmarshal(rateData, &rateResults); err == nil {
		for _, r := range rateResults {
			svc := r.Metric["service_name"]
			if svc == "" {
				continue
			}
			key := fmt.Sprintf("baseline:%s:rate:%s", svc, window)
			baseline := models.Baseline{
				Service:   svc,
				Endpoint:  "/",
				Metric:    "rate",
				Value:     r.FloatValue(),
				Window:    window,
				UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			}
			if err := b.store.Set(key, baseline); err != nil {
				return fmt.Errorf("failed to store baseline: %w", err)
			}
		}
	}

	quantiles := []struct {
		name, value string
	}{
		{"p50", "0.5"},
		{"p95", "0.95"},
		{"p99", "0.99"},
	}

	for _, q := range quantiles {
		latencyData, err := b.promClient.GetServiceLatency(namespace, window, q.value)
		if err != nil {
			continue
		}
		var latencyResults []prometheus.VectorResult
		if err := json.Unmarshal(latencyData, &latencyResults); err == nil {
			for _, r := range latencyResults {
				svc := r.Metric["service_name"]
				if svc == "" {
					continue
				}
				key := fmt.Sprintf("baseline:%s:latency_%s:%s", svc, q.name, window)
				baseline := models.Baseline{
					Service:   svc,
					Endpoint:  "/",
					Metric:    fmt.Sprintf("latency_%s", q.name),
					Value:     r.FloatValue(),
					Window:    window,
					UpdatedAt: time.Now().UTC().Format(time.RFC3339),
				}
				b.store.Set(key, baseline)
			}
		}
	}
	return nil
}

func (b *Baseliner) GetBaselines(service, window string) ([]models.Baseline, error) {
	prefix := fmt.Sprintf("baseline:%s:", service)
	data, err := b.store.List(prefix)
	if err != nil {
		return nil, err
	}
	var baselines []models.Baseline
	for _, raw := range data {
		var bl models.Baseline
		if err := json.Unmarshal(raw, &bl); err != nil {
			continue
		}
		if window != "" && bl.Window != window {
			continue
		}
		baselines = append(baselines, bl)
	}
	return baselines, nil
}
