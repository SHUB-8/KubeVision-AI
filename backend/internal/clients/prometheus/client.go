package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Client struct {
	baseURL string
	client  *http.Client
}

type queryResult struct {
	Status string    `json:"status"`
	Data   queryData `json:"data"`
	Error  string    `json:"error"`
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

func serverAddressPattern(service string) string {
	return "^" + regexp.QuoteMeta(service) + "($|[.:])"
}

func (c *Client) Query(ctx context.Context, query string) (json.RawMessage, error) {
	u := fmt.Sprintf("%s/api/v1/query?query=%s", c.baseURL, url.QueryEscape(query))
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		slog.Warn("could not build Prometheus query request", "query", query, "error", err)
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		wrapped := fmt.Errorf("prometheus query failed: %w", err)
		slog.Warn("Prometheus query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Warn("could not read Prometheus query response", "query", query, "error", err)
		return nil, err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		wrapped := fmt.Errorf("Prometheus returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		slog.Warn("Prometheus query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	var result queryResult
	if err := json.Unmarshal(body, &result); err != nil {
		slog.Warn("could not decode Prometheus query response", "query", query, "error", err)
		return nil, err
	}
	if result.Status != "success" {
		wrapped := fmt.Errorf("Prometheus query status %q: %s", result.Status, result.Error)
		slog.Warn("Prometheus query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	return result.Data.Result, nil
}

func (c *Client) QueryRange(ctx context.Context, query, start, end, step string) (json.RawMessage, error) {
	params := url.Values{}
	params.Set("query", query)
	params.Set("start", start)
	params.Set("end", end)
	params.Set("step", step)
	req, err := http.NewRequestWithContext(ctx, "GET", c.baseURL+"/api/v1/query_range?"+params.Encode(), nil)
	if err != nil {
		slog.Warn("could not build Prometheus range query request", "query", query, "error", err)
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		wrapped := fmt.Errorf("prometheus range query failed: %w", err)
		slog.Warn("Prometheus range query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Warn("could not read Prometheus range query response", "query", query, "error", err)
		return nil, err
	}
	if resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		wrapped := fmt.Errorf("Prometheus returned HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
		slog.Warn("Prometheus range query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	var result queryResult
	if err := json.Unmarshal(body, &result); err != nil {
		slog.Warn("could not decode Prometheus range query response", "query", query, "error", err)
		return nil, err
	}
	if result.Status != "success" {
		wrapped := fmt.Errorf("Prometheus range query status %q: %s", result.Status, result.Error)
		slog.Warn("Prometheus range query failed", "query", query, "error", wrapped)
		return nil, wrapped
	}
	return result.Data.Result, nil
}

// FetchParallel runs independent Prometheus queries concurrently and returns
// their raw results in order (nil on that query's error). The dashboard
// handlers fire 7-11 of these per request; run sequentially at 100-250ms per
// round trip that serialized latency was the app's main bottleneck.
func FetchParallel(queries ...func() (json.RawMessage, error)) []json.RawMessage {
	results := make([]json.RawMessage, len(queries))
	var wg sync.WaitGroup
	for i, q := range queries {
		wg.Add(1)
		go func(i int, q func() (json.RawMessage, error)) {
			defer wg.Done()
			results[i], _ = q()
		}(i, q)
	}
	wg.Wait()
	return results
}

// MetricServiceName resolves the workload identity of a metric series.
// OBI 0.15 stopped exporting service.name as a metric-level label on the RED
// families (it moved to resource attributes only — pkg/export/attributes/
// attr_defs.go pins ServiceName: false in the app attribute group), while
// Beyla 3.x always carried service_name and the k8s metadata decorator always
// provides k8s_owner_name. Every query therefore groups by BOTH labels and
// readers resolve identity through this chain:
// service_name -> k8s_owner_name -> k8s_deployment_name.
func MetricServiceName(metric map[string]string) string {
	for _, k := range []string{"service_name", "k8s_owner_name", "k8s_deployment_name"} {
		if v := metric[k]; v != "" {
			return v
		}
	}
	return ""
}

func (c *Client) GetServiceRates(namespace, window string) (json.RawMessage, error) {
	// OBI emits a separate server-side metric family per protocol: HTTP
	// requests, gRPC calls, DB/Redis operations (RESP, SQL, Mongo), messaging.
	// Sum them all so a service shows traffic whichever protocol it speaks.
	// Datastore rates are credible (client- and server-side counts agree);
	// only the db_server DURATION histogram is broken on persistent
	// connections — latency never comes from this query.
	query := fmt.Sprintf(`sum(rate({__name__=~"http_server_request_duration_seconds_count|rpc_server_call_duration_seconds_count|db_server_operation_duration_seconds_count",k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetServiceLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(http_server_request_duration_seconds_bucket{k8s_namespace_name=%q}[%s])) by (le, service_name, k8s_owner_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetEndpointMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (http_route, http_request_method)`, namespace, service, window, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

// GetEndpointErrors returns the 5xx fraction of requests per endpoint
// (0 = all healthy, 1 = every request failing).
func (c *Client) GetEndpointErrors(namespace, service, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`(sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (http_route, http_request_method))`, namespace, service, window, namespace, serverAddressPattern(service), window)
	errors := fmt.Sprintf(`(sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q,http_response_status_code=~"5.."}[%s])) by (http_route, http_request_method) or sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q,http_response_status_code=~"5.."}[%s])) by (http_route, http_request_method))`, namespace, service, window, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceErrors returns the 5xx fraction of requests per service.
func (c *Client) GetServiceErrors(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q,http_response_status_code=~"5.."}[%s])) by (service_name, k8s_owner_name)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceRPCErrors returns the fraction of gRPC calls whose status is not
// "OK" (OBI reports the canonical gRPC status name, not the numeric code).
func (c *Client) GetServiceRPCErrors(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name=%q,rpc_response_status_code!="OK"}[%s])) by (service_name, k8s_owner_name)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetServiceRPCLatency returns a gRPC latency quantile per service.
func (c *Client) GetServiceRPCLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_server_call_duration_seconds_bucket{k8s_namespace_name=%q}[%s])) by (le, service_name, k8s_owner_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetEndpointRPCMetrics returns the gRPC call rate per method (from server metrics or client calls targeting this service).
func (c *Client) GetEndpointRPCMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (rpc_method)`, namespace, service, window, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

// GetEndpointRPCErrors returns the fraction of gRPC calls per method whose
// status is not "OK".
func (c *Client) GetEndpointRPCErrors(namespace, service, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`(sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (rpc_method))`, namespace, service, window, namespace, serverAddressPattern(service), window)
	errors := fmt.Sprintf(`(sum(rate(rpc_server_call_duration_seconds_count{k8s_namespace_name=%q,k8s_owner_name=%q,rpc_response_status_code!="OK"}[%s])) by (rpc_method) or sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q,rpc_response_status_code!="OK"}[%s])) by (rpc_method))`, namespace, service, window, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetEndpointRPCLatency returns a gRPC latency quantile per method.
func (c *Client) GetEndpointRPCLatency(namespace, service, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_server_call_duration_seconds_bucket{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (le, rpc_method)) or histogram_quantile(%s, sum(rate(rpc_client_call_duration_seconds_bucket{k8s_namespace_name=%q,server_address=~%q}[%s])) by (le, rpc_method))`, quantile, namespace, service, window, quantile, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

// GetEndpointLatency returns a latency quantile (p50/p95/p99) per endpoint.
func (c *Client) GetEndpointLatency(namespace, service, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(http_server_request_duration_seconds_bucket{k8s_namespace_name=%q,k8s_owner_name=%q}[%s])) by (le, http_route, http_request_method)) or histogram_quantile(%s, sum(rate(http_client_request_duration_seconds_bucket{k8s_namespace_name=%q,server_address=~%q}[%s])) by (le, http_route, http_request_method))`, quantile, namespace, service, window, quantile, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetServerMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_server_request_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name, http_route)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetClientMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(http_client_request_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name, http_route, server_address, server_service_namespace, server_k8s_namespace_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

func (c *Client) GetRPCClientMetrics(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientLatencyByEdge returns p95 latency for each client->server interaction edge
func (c *Client) GetClientLatencyByEdge(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(rpc_client_call_duration_seconds_bucket{k8s_namespace_name=%q}[%s])) by (le, service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientLatencyByServer returns a latency quantile for each target server
// address as observed by its CALLERS, across every client-side protocol
// family: gRPC (rpc_client_*), databases (db_client_*: Redis RESP, SQL, Mongo)
// and messaging (messaging_client_*). This is the only credible latency for
// datastores: their server-side histogram mis-pairs operations on persistent
// connections (see GetDBServerLatency). The source must be surfaced as
// SourceClientObserved, not SourceMetrics.
func (c *Client) GetClientLatencyByServer(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate({__name__=~"rpc_client_call_duration_seconds_bucket|db_client_operation_duration_seconds_bucket|messaging_client_operation_duration_seconds_bucket",k8s_namespace_name=%q}[%s])) by (le, server_address, server_service_namespace, server_k8s_namespace_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetClientErrorsByServer returns the fraction of failed operations per target
// server address as observed by its callers. Each family signals failure in a
// different label (gRPC: rpc_response_status_code != "OK"; DB and messaging:
// error_type), and a single AND-combined selector would exclude the other
// families' series, so the terms are queried separately and merged here.
func (c *Client) GetClientErrorsByServer(namespace, window string) (json.RawMessage, error) {
	by := ` by (server_address, server_service_namespace, server_k8s_namespace_name)`
	families := []struct{ metric, errFilter string }{
		{"rpc_client_call_duration_seconds_count", `rpc_response_status_code!="OK"`},
		{"db_client_operation_duration_seconds_count", `error_type!=""`},
		{"messaging_client_operation_duration_seconds_count", `error_type!=""`},
	}
	totalQ := fmt.Sprintf(`sum(rate({__name__=~"rpc_client_call_duration_seconds_count|db_client_operation_duration_seconds_count|messaging_client_operation_duration_seconds_count",k8s_namespace_name=%q}[%s]))%s`, namespace, window, by)

	totals, err := c.Query(context.Background(), totalQ)
	if err != nil {
		return nil, err
	}
	var totalRes queryResult
	if err := json.Unmarshal(totals, &totalRes); err != nil {
		return nil, err
	}
	var totalEntries []promInstantVector
	if err := json.Unmarshal(totalRes.Data.Result, &totalEntries); err != nil {
		return nil, err
	}

	errSums := make(map[string]float64, len(totalEntries))
	for _, fam := range families {
		errQ := fmt.Sprintf(`sum(rate(%s{k8s_namespace_name=%q,%s}[%s]))%s`, fam.metric, namespace, fam.errFilter, window, by)
		raw, err := c.Query(context.Background(), errQ)
		if err != nil {
			return nil, err
		}
		var res queryResult
		if err := json.Unmarshal(raw, &res); err != nil {
			return nil, err
		}
		var entries []promInstantVector
		if err := json.Unmarshal(res.Data.Result, &entries); err != nil {
			return nil, err
		}
		for _, e := range entries {
			errSums[e.Metric["server_address"]] += e.Value
		}
	}

	out := make([]map[string]any, 0, len(totalEntries))
	for _, t := range totalEntries {
		total := t.Value
		ratio := 0.0
		if total > 0 {
			ratio = errSums[t.Metric["server_address"]] / total
		}
		// Same shape as a Prometheus instant vector so the API-layer
		// parseMetricEntries consumes it unchanged.
		out = append(out, map[string]any{
			"metric": t.Metric,
			"value":  []any{time.Now().Unix(), strconv.FormatFloat(ratio, 'f', -1, 64)},
		})
	}
	result, err := json.Marshal(map[string]any{
		"status": "success",
		"data":   map[string]any{"resultType": "vector", "result": out},
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// promInstantVector is one series of a Prometheus instant-vector response,
// whose value arrives as [<unix_ts>, "<string>"].
type promInstantVector struct {
	Metric map[string]string `json:"metric"`
	Value  float64           `json:"-"`
}

func (v *promInstantVector) UnmarshalJSON(b []byte) error {
	var raw struct {
		Metric map[string]string `json:"metric"`
		Value  []json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	v.Metric = raw.Metric
	if len(raw.Value) == 2 {
		var s string
		if err := json.Unmarshal(raw.Value[1], &s); err == nil {
			v.Value, _ = strconv.ParseFloat(s, 64)
		}
	}
	return nil
}

// GetClientErrorsByEdge returns the error rate for each client->server interaction edge
func (c *Client) GetClientErrorsByEdge(namespace, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name)`, namespace, window)
	errors := fmt.Sprintf(`sum(rate(rpc_client_call_duration_seconds_count{k8s_namespace_name=%q,rpc_response_status_code!="OK"}[%s])) by (service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name)`, namespace, window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetNetworkFlows returns eBPF network flow rates targeting the namespace (bytes/sec)
func (c *Client) GetNetworkFlows(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(obi_network_flow_bytes_total{k8s_dst_namespace=%q}[%s])) by (k8s_src_owner_name, k8s_dst_owner_name, k8s_src_namespace, k8s_dst_namespace, direction)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetOutboundNetworkFlows returns eBPF network flow rates originating in the namespace
func (c *Client) GetOutboundNetworkFlows(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(obi_network_flow_bytes_total{k8s_src_namespace=%q}[%s])) by (k8s_src_owner_name, k8s_dst_owner_name, k8s_src_namespace, k8s_dst_namespace, direction)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetServiceThroughput returns incoming byte throughput per destination service in the namespace
func (c *Client) GetServiceThroughput(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(obi_network_flow_bytes_total{k8s_dst_namespace=%q}[%s])) by (k8s_dst_owner_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

// --- Database / cache traffic -------------------------------------------------
//
// Beyla parses DB wire protocols (Redis RESP, SQL, MongoDB, ...) and emits
// db_client_operation_duration_seconds on the CALLER and
// db_server_operation_duration_seconds on the database process itself. These
// families are the only source of latency for a datastore: it speaks RESP/TCP,
// not HTTP or gRPC, so no http_*/rpc_* histogram covers it. Without them a
// cache like redis-cart reports a borrowed request rate and NO latency at all.

// GetDBClientRates returns the measured call rate per (caller, database) pair.
func (c *Client) GetDBClientRates(namespace, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(db_client_operation_duration_seconds_count{k8s_namespace_name=%q}[%s])) by (service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name)`, namespace, window)
	return c.Query(context.Background(), query)
}

// GetDBClientLatency returns the caller-observed latency quantile per
// (caller, database) pair.
func (c *Client) GetDBClientLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(db_client_operation_duration_seconds_bucket{k8s_namespace_name=%q}[%s])) by (le, service_name, k8s_owner_name, server_address, server_service_namespace, server_k8s_namespace_name))`, quantile, namespace, window)
	return c.Query(context.Background(), query)
}

// GetEndpointDBMetrics returns the datastore operation rate per command
// (db_operation_name: GET, SET, CLIENT, ...), observed on the callers that
// target this datastore.
func (c *Client) GetEndpointDBMetrics(namespace, service, window string) (json.RawMessage, error) {
	query := fmt.Sprintf(`sum(rate(db_client_operation_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (db_operation_name)`, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

// GetEndpointDBErrors returns the fraction of failed operations per command as
// seen by the callers. OBI marks failures with error_type / db_response_status
// ("ERR"); healthy series carry no such label.
func (c *Client) GetEndpointDBErrors(namespace, service, window string) (json.RawMessage, error) {
	total := fmt.Sprintf(`sum(rate(db_client_operation_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q}[%s])) by (db_operation_name)`, namespace, serverAddressPattern(service), window)
	errors := fmt.Sprintf(`sum(rate(db_client_operation_duration_seconds_count{k8s_namespace_name=%q,server_address=~%q,error_type!=""}[%s])) by (db_operation_name)`, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), fmt.Sprintf(`(%s) / (%s)`, errors, total))
}

// GetEndpointDBLatency returns a caller-observed latency quantile per
// datastore command.
func (c *Client) GetEndpointDBLatency(namespace, service, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(db_client_operation_duration_seconds_bucket{k8s_namespace_name=%q,server_address=~%q}[%s])) by (le, db_operation_name))`, quantile, namespace, serverAddressPattern(service), window)
	return c.Query(context.Background(), query)
}

// GetDBServerLatency returns the database-observed latency quantile per
// database service.
//
// NOT WIRED UP, ON PURPOSE. On this stack the value is wrong: for redis-cart it
// reports a 320 ms mean / 1717 ms p95 for the same calls the client measures at
// 0.16 ms / 4.75 ms, and sum(rate(_sum)) sits at ~1.0 seconds per second, which
// means the timer is running continuously and effectively measuring the gap to
// the next request (1/request-rate = 0.324 s matches the reported 0.320 s).
// Keep it here as the documented query, but do not feed it to the topology
// until the pairing behaviour is confirmed fixed upstream.
func (c *Client) GetDBServerLatency(namespace, window, quantile string) (json.RawMessage, error) {
	query := fmt.Sprintf(`histogram_quantile(%s, sum(rate(db_server_operation_duration_seconds_bucket{k8s_namespace_name=%q}[%s])) by (le, service_name))`, quantile, namespace, window)
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
