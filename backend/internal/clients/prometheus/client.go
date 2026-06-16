package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

type Client struct {
	baseURL string
	client  *http.Client
}

type queryResult struct {
	Status string    `json:"status"`
	Data   queryData `json:"data"`
}

type queryData struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) Query(ctx context.Context, query string) (json.RawMessage, error) {
	u := fmt.Sprintf("%s/api/v1/query?query=%s", c.baseURL, url.QueryEscape(query))
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prometheus query failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var result queryResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result.Data.Result, nil
}

func (c *Client) QueryRange(ctx context.Context, query, start, end, step string) (json.RawMessage, error) {
	url := fmt.Sprintf("%s/api/v1/query_range?query=%s&start=%s&end=%s&step=%s", c.baseURL, query, start, end, step)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prometheus range query failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	var result queryResult
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result.Data.Result, nil
}

func (c *Client) GetServiceRates(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetServiceLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(http_server_request_duration_seconds_bucket{k8s_namespace_name="%s"}[%s])) by (le, service_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetEndpointMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s",service_name="%s"}[%s])) by (http_route, http_request_method)`, namespace, service, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetServerMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name, http_route)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetClientMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name, http_route, server_address)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetRPCClientMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(rpc_client_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name, server_address)`, namespace, window)
	return c.Query(context.Background(), query)
}

func ParseVector(raw json.RawMessage) ([]VectorResult, error) {
	var results []VectorResult
	if err := json.Unmarshal(raw, &results); err != nil {
		return nil, err
	}
	return results, nil
}

type VectorResult struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`
}

func (v VectorResult) FloatValue() float64 {
	if len(v.Value) >= 2 {
		switch val := v.Value[1].(type) {
		case float64:
			return val
		case string:
			var f float64
			fmt.Sscanf(val, "%f", &f)
			return f
		}
	}
	return 0
}
