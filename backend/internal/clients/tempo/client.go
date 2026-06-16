package tempo

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/kubevision/backend/models"
)

type Client struct {
	baseURL string
	client  *http.Client
}

type searchResponse struct {
	Traces []tempoTrace `json:"traces"`
}

type tempoTrace struct {
	TraceID    string `json:"traceID"`
	Root       *struct {
		ServiceName string `json:"serviceName"`
	} `json:"root"`
	StartTime  string `json:"startTime"`
	Duration   string `json:"duration"`
	TotalSpans int    `json:"totalSpans"`
}

type traceResponse struct {
	Batches []spanBatch `json:"batches"`
}

type spanBatch struct {
	Resource  spanResource `json:"resource"`
	ScopeSpans []scopeSpan `json:"scopeSpans"`
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
	DurationUnixNano  string     `json:"durationUnixNano"`
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
		baseURL: baseURL,
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) SearchTraces(ctx context.Context, serviceName string, limit int) ([]models.Trace, error) {
	if limit <= 0 {
		limit = 20
	}
	params := url.Values{}
	params.Set("service.name", serviceName)
	params.Set("limit", fmt.Sprintf("%d", limit))

	u := fmt.Sprintf("%s/api/traces/search?%s", c.baseURL, params.Encode())
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

	var traces []models.Trace
	for _, t := range searchResp.Traces {
		spans, err := c.GetTrace(ctx, t.TraceID)
		if err != nil {
			continue
		}
		traces = append(traces, models.Trace{TraceID: t.TraceID, Spans: spans})
	}
	return traces, nil
}

func (c *Client) GetTrace(ctx context.Context, traceID string) ([]models.Span, error) {
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
				durNano, _ := strconv.ParseInt(raw.DurationUnixNano, 10, 64)

				attrs := make(map[string]string)
				for _, a := range raw.Attributes {
					attrs[a.Key] = a.Value.StringValue
				}

				spans = append(spans, models.Span{
					TraceID:       raw.TraceID,
					SpanID:        raw.SpanID,
					ParentSpanID:  raw.ParentSpanID,
					OperationName: raw.Name,
					ServiceName:   serviceName,
					StartTime:     startNano,
					Duration:      durNano,
					StatusCode:    raw.Status.Code,
					Attributes:    attrs,
				})
			}
		}
	}
	return spans, nil
}

func extractServiceName(attrs []spanAttr) string {
	for _, a := range attrs {
		if a.Key == "service.name" {
			return a.Value.StringValue
		}
	}
	return "unknown"
}
