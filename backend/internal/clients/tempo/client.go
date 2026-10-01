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

// Field names per the Tempo HTTP API search response (TraceSearchMetadata)
// https://grafana.com/docs/tempo/latest/api_docs/
type tempoTrace struct {
	TraceID           string `json:"traceID"`
	RootServiceName   string `json:"rootServiceName"`
	RootTraceName     string `json:"rootTraceName"`
	StartTimeUnixNano string `json:"startTimeUnixNano"`
	DurationMs        int64  `json:"durationMs"`
	SpanCount         int    `json:"spanCount"`
}

type traceResponse struct {
	Batches []spanBatch `json:"batches"`
}

type spanBatch struct {
	Resource   spanResource `json:"resource"`
	ScopeSpans []scopeSpan  `json:"scopeSpans"`
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
	EndTimeUnixNano   string     `json:"endTimeUnixNano"`
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
	// Search endpoint is /api/search (NOT /api/traces/search) with the
	// logfmt-encoded tags parameter: tags=service.name%3D<name>
	params := url.Values{}
	if serviceName != "" {
		params.Set("tags", fmt.Sprintf("service.name=%s", serviceName))
	}
	params.Set("limit", strconv.Itoa(limit))

	u := fmt.Sprintf("%s/api/search?%s", c.baseURL, params.Encode())
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

	traces := []models.Trace{}
	for _, t := range searchResp.Traces {
		spans, err := c.GetTrace(ctx, t.TraceID)
		if err != nil {
			continue
		}
		traces = append(traces, models.Trace{
			TraceID:         t.TraceID,
			RootServiceName: t.RootServiceName,
			RootTraceName:   t.RootTraceName,
			DurationMs:      t.DurationMs,
			SpanCount:       t.SpanCount,
			Spans:           spans,
		})
	}
	return traces, nil
}

// Health probes the Tempo readiness endpoint (monolithic mode exposes every
// service endpoint, including /ready, on the single tempo service).
func (c *Client) Health(ctx context.Context) error {
	u := fmt.Sprintf("%s/ready", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("tempo health check failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("tempo unhealthy: status %d", resp.StatusCode)
	}
	return nil
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
				// Tempo's OTLP JSON reports an absolute end time, not a duration.
				endNano, _ := strconv.ParseInt(raw.EndTimeUnixNano, 10, 64)
				durNano := endNano - startNano
				if durNano < 0 {
					durNano = 0
				}

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

type TraceEdge struct {
	Source   string
	Target   string
	Protocol string
}

func (c *Client) GetTraceEdges(ctx context.Context, limit int) ([]TraceEdge, error) {
	if limit <= 0 {
		limit = 25
	}
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	u := fmt.Sprintf("%s/api/search?%s", c.baseURL, params.Encode())
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("tempo search for trace edges failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var searchResp searchResponse
	if err := json.Unmarshal(body, &searchResp); err != nil {
		return nil, err
	}

	edgeMap := make(map[string]TraceEdge)
	for _, t := range searchResp.Traces {
		spans, err := c.GetTrace(ctx, t.TraceID)
		if err != nil {
			continue
		}
		for _, s := range spans {
			// Inbound server requests with caller address (e.g. loadgenerator -> frontend)
			clientAddr := s.Attributes["client.address"]
			if clientAddr != "" {
				target := s.Attributes["server.address"]
				if target == "" {
					target = s.ServiceName
				}
				if target != "" && clientAddr != target {
					proto := "HTTP/1.1"
					if s.Attributes["rpc.system"] != "" {
						proto = "gRPC"
					}
					key := clientAddr + "->" + target
					edgeMap[key] = TraceEdge{Source: clientAddr, Target: target, Protocol: proto}
				}
			}

			// Outbound database client spans (e.g. cartservice -> redis-cart)
			dbSystem := s.Attributes["db.system"]
			if dbSystem != "" && s.ServiceName != "" {
				target := s.Attributes["server.address"]
				if target == "" {
					target = s.Attributes["net.peer.name"]
				}
				if target == "" {
					target = s.Attributes["db.name"]
				}
				if target != "" && s.ServiceName != target {
					proto := dbSystem
					switch dbSystem {
					case "redis":
						proto = "Redis (RESP)"
					case "postgresql":
						proto = "PostgreSQL"
					case "mysql":
						proto = "MySQL"
					case "mongodb":
						proto = "MongoDB"
					}
					key := s.ServiceName + "->" + target
					edgeMap[key] = TraceEdge{Source: s.ServiceName, Target: target, Protocol: proto}
				}
			}

			// Outbound messaging client spans (e.g. Kafka, RabbitMQ)
			msgSystem := s.Attributes["messaging.system"]
			if msgSystem != "" && s.ServiceName != "" {
				target := s.Attributes["server.address"]
				if target == "" {
					target = s.Attributes["net.peer.name"]
				}
				if target != "" && s.ServiceName != target {
					key := s.ServiceName + "->" + target
					edgeMap[key] = TraceEdge{Source: s.ServiceName, Target: target, Protocol: msgSystem}
				}
			}
		}
	}

	edges := make([]TraceEdge, 0, len(edgeMap))
	for _, edge := range edgeMap {
		edges = append(edges, edge)
	}
	return edges, nil
}
