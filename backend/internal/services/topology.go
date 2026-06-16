package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/models"
)

type TopologyService struct {
	k8sClient  *k8s.Client
	promClient *prometheus.Client
}

func NewTopologyService(k8sClient *k8s.Client, promClient *prometheus.Client) *TopologyService {
	return &TopologyService{k8sClient: k8sClient, promClient: promClient}
}

func (s *TopologyService) GetTopology(ctx context.Context, namespace, window string) (*models.Topology, error) {
	if window == "" {
		window = "5m"
	}

	pods, err := s.k8sClient.GetPods(namespace)
	if err != nil {
		return nil, fmt.Errorf("failed to get pods: %w", err)
	}

	nodeMap := make(map[string]models.Node)
	for _, pod := range pods {
		svcName := extractServiceName(pod.Name)
		if _, exists := nodeMap[svcName]; !exists {
			nodeMap[svcName] = models.Node{
				ID:        svcName,
				Label:     svcName,
				Type:      "service",
				Namespace: namespace,
			}
		}
	}

	ipToService, _ := s.k8sClient.GetServiceClusterIPs(namespace)

	edges, err := s.buildEdges(ctx, namespace, window, ipToService, nodeMap)
	if err != nil {
		edges = []models.Edge{}
	}

	nodes := make([]models.Node, 0, len(nodeMap))
	for _, node := range nodeMap {
		nodes = append(nodes, node)
	}

	return &models.Topology{Nodes: nodes, Edges: edges}, nil
}

type clientEntry struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`
}

func (s *TopologyService) parseClientEntries(raw json.RawMessage, edgeMap map[string]float64, ipToService map[string]string) {
	var results []clientEntry
	if err := json.Unmarshal(raw, &results); err != nil {
		return
	}
	for _, r := range results {
		source := r.Metric["service_name"]
		serverAddr := r.Metric["server_address"]
		if source == "" || serverAddr == "" {
			continue
		}
		target := extractServiceFromAddress(serverAddr)
		if svc, ok := ipToService[target]; ok {
			target = svc
		}
		if target == "" || source == target {
			continue
		}
		var rate float64
		if len(r.Value) >= 2 {
			switch v := r.Value[1].(type) {
			case float64:
				rate = v
			case string:
				fmt.Sscanf(v, "%f", &rate)
			}
		}
		key := source + "->" + target
		edgeMap[key] += rate
	}
}

func (s *TopologyService) buildEdges(ctx context.Context, namespace, window string, ipToService map[string]string, nodeMap map[string]models.Node) ([]models.Edge, error) {
	edgeMap := make(map[string]float64)

	httpData, err := s.promClient.GetClientMetrics(namespace, window)
	if err == nil {
		s.parseClientEntries(httpData, edgeMap, ipToService)
	}

	rpcData, err := s.promClient.GetRPCClientMetrics(namespace, window)
	if err == nil {
		s.parseClientEntries(rpcData, edgeMap, ipToService)
	}

	var edges []models.Edge
	edgeID := 0
	for key, rate := range edgeMap {
		parts := strings.SplitN(key, "->", 2)
		source, target := parts[0], parts[1]
		if _, exists := nodeMap[target]; !exists {
			continue
		}
		edges = append(edges, models.Edge{
			ID:     fmt.Sprintf("e%d", edgeID),
			Source: source,
			Target: target,
			Rate:   rate,
		})
		edgeID++
	}
	return edges, nil
}

func extractServiceFromAddress(addr string) string {
	if idx := strings.Index(addr, ":"); idx > 0 {
		return addr[:idx]
	}
	return addr
}

func extractServiceName(podName string) string {
	parts := strings.Split(podName, "-")
	if len(parts) >= 2 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	return podName
}
