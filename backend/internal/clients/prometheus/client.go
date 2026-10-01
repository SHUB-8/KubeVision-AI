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
	// Beyla emits separate metric families per protocol: HTTP server requests
	// and gRPC (rpc) server calls. Sum both so a service shows traffic
	// whichever protocol it speaks.
	query := fmt.Sprintf(`sum(rate({__name__=~"http_server_request_duration_seconds_count|rpc_server_call_duration_seconds_count",k8s_namespace_name="%s"}[%s])) by (service_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetServiceLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(http_server_request_duration_seconds_bucket{k8s_namespace_name="%s"}[%s])) by (le, service_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetEndpointMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s",service_name="%s"}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (http_route, http_request_method)`, namespace, service, window, namespace, service, window)
	return c.Query(context.Background(), query)
}

// GetEndpointErrors returns the 5xx fraction of requests per endpoint
// (0 = all healthy, 1 = every request failing).
func (c *Client) GetEndpointErrors(namespace, service, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`(sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s",service_name="%s"}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (http_route, http_request_method))`, namespace, service, window, namespace, service, window)
	errors := fmt.Sprintf(`(sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s",service_name="%s",http_response_status_code=~"5.."}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*",http_response_status_code=~"5.."}[%s])) by (http_route, http_request_method))`, namespace, service, window, namespace, service, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceErrors returns the 5xx fraction of requests per service.
func (c *Client) GetServiceErrors(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name="%s",http_response_status_code=~"5.."}[%s])) by (service_name)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceRPCErrors returns the fraction of gRPC calls whose status is not
// "OK" (Beyla reports the canonical gRPC status name, not the numeric code).
func (c *Client) GetServiceRPCErrors(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name="%s",rpc_response_status_code!="OK"}[%s])) by (service_name)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceRPCLatency returns a gRPC latency quantile per service.
func (c *Client) GetServiceRPCLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_server_call_duration_seconds_bucket{k8s_namespace_name="%s"}[%s])) by (le, service_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetEndpointRPCMetrics returns the gRPC call rate per method (from server metrics or client calls targeting this service).
func (c *Client) GetEndpointRPCMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name="%s",service_name="%s"}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (rpc_method)`, namespace, service, window, namespace, service, window)
	return c.Query(context.Background(), query)
}

// GetEndpointRPCErrors returns the fraction of gRPC calls per method whose
// status is not "OK".
func (c *Client) GetEndpointRPCErrors(namespace, service, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`(sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name="%s",service_name="%s"}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (rpc_method))`, namespace, service, window, namespace, service, window)
	errors := fmt.Sprintf(`(sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name="%s",service_name="%s",rpc_response_status_code!="OK"}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s",server_address=~"%s.*",rpc_response_status_code!="OK"}[%s])) by (rpc_method))`, namespace, service, window, namespace, service, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetEndpointRPCLatency returns a gRPC latency quantile per method.
func (c *Client) GetEndpointRPCLatency(namespace, service, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_server_call_duration_seconds_bucket{k8s_namespace_name="%s",service_name="%s"}[%s])) by (le, rpc_method)) or histogram_quantile(%s, sum(rate(rpc_client_call_duration_seconds_bucket{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (le, rpc_method))`, quantile, namespace, service, window, quantile, namespace, service, window)
	return c.Query(context.Background(), query)
}

// GetEndpointLatency returns a latency quantile (p50/p95/p99) per endpoint.
func (c *Client) GetEndpointLatency(namespace, service, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(http_server_request_duration_seconds_bucket{k8s_namespace_name="%s",service_name="%s"}[%s])) by (le, http_route, http_request_method)) or histogram_quantile(%s, sum(rate(http_client_request_duration_seconds_bucket{k8s_namespace_name="%s",server_address=~"%s.*"}[%s])) by (le, http_route, http_request_method))`, quantile, namespace, service, window, quantile, namespace, service, window)
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
	query := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name, server_address)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientLatencyByEdge returns p95 latency for each client->server interaction edge
func (c *Client) GetClientLatencyByEdge(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_client_call_duration_seconds_bucket{k8s_namespace_name="%s"}[%s])) by (le, service_name, server_address))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientLatencyByServer returns p95 latency for each target server address as observed by its callers
func (c *Client) GetClientLatencyByServer(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_client_call_duration_seconds_bucket{k8s_namespace_name="%s"}[%s])) by (le, server_address))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientErrorsByEdge returns the error rate for each client->server interaction edge
func (c *Client) GetClientErrorsByEdge(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s"}[%s])) by (service_name, server_address)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name="%s",rpc_response_status_code!="OK"}[%s])) by (service_name, server_address)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetNetworkFlows returns eBPF network flow rates targeting the namespace (bytes/sec)
func (c *Client) GetNetworkFlows(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(beyla_network_flow_bytes_total{k8s_dst_namespace="%s"}[%s])) by (k8s_src_owner_name, k8s_dst_owner_name, direction)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetOutboundNetworkFlows returns eBPF network flow rates originating in the namespace
func (c *Client) GetOutboundNetworkFlows(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(beyla_network_flow_bytes_total{k8s_src_namespace="%s"}[%s])) by (k8s_src_owner_name, k8s_dst_owner_name, direction)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetServiceThroughput returns incoming byte throughput per destination service in the namespace
func (c *Client) GetServiceThroughput(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(beyla_network_flow_bytes_total{k8s_dst_namespace="%s"}[%s])) by (k8s_dst_owner_name)`, namespace, window)
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
