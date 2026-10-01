package loki

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/kubevision/backend/models"
)

type Client struct {
	baseURL string
	client  *http.Client
}

type lokiResponse struct {
	Status string   `json:"status"`
	Data   lokiData `json:"data"`
}

type lokiData struct {
	ResultType string       `json:"resultType"`
	Result     []lokiStream `json:"result"`
}

type lokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][]string        `json:"values"`
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		client:  &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) QueryRange(ctx context.Context, logQL string, start, end string, limit int) ([]models.LogEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	params := url.Values{}
	params.Set("query", logQL)
	params.Set("start", start)
	params.Set("end", end)
	params.Set("limit", fmt.Sprintf("%d", limit))
	params.Set("direction", "backward")

	u := fmt.Sprintf("%s/loki/api/v1/query_range?%s", c.baseURL, params.Encode())
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("loki query failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var lokiResp lokiResponse
	if err := json.Unmarshal(body, &lokiResp); err != nil {
		return nil, fmt.Errorf("failed to parse loki response: %w", err)
	}

	var entries []models.LogEntry
	for _, stream := range lokiResp.Data.Result {
		for _, val := range stream.Values {
			if len(val) >= 2 {
				entries = append(entries, models.LogEntry{
					Timestamp: val[0],
					Stream:    stream.Stream["job"],
					Labels:    stream.Stream,
					Line:      val[1],
				})
			}
		}
	}
	return entries, nil
}

func BuildLogQL(namespace, pod, filter string) string {
	// Label keys are the ones Fluent Bit's Loki output produces with
	// Auto_Kubernetes_Labels on: namespace_name, pod_name, container_name.
	selectors := fmt.Sprintf(`namespace_name="%s"`, namespace)
	if pod != "" {
		selectors += fmt.Sprintf(`, pod_name=~"%s.*"`, pod)
	}
	query := fmt.Sprintf(`{%s}`, selectors)
	if filter != "" {
		query += fmt.Sprintf(` |~ "%s"`, filter)
	}
	return query
}

// Health probes Loki via a cheap labels query. It uses /loki/api/v1/labels
// (not /ready) because that path is also proxied by the loki-gateway nginx
// config that the Helm chart deploys in front of Loki.
func (c *Client) Health(ctx context.Context) error {
	u := fmt.Sprintf("%s/loki/api/v1/labels?limit=1", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return fmt.Errorf("loki health check failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("loki unhealthy: status %d", resp.StatusCode)
	}
	return nil
}
