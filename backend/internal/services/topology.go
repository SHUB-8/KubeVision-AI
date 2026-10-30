package services

import (
	"context"
	"fmt"
	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/models"
	"log/slog"
)

type TopologyService struct {
	k8sClient  *k8s.Client
	promClient *prometheus.Client
}

func NewTopologyService(k8sClient *k8s.Client, promClient *prometheus.Client) *TopologyService {
	return &TopologyService{
		k8sClient:  k8sClient,
		promClient: promClient,
	}
}

func (s *TopologyService) GetTopology(ctx context.Context, namespace, window string) (*models.Topology, error) {
	if window == "" {
		window = models.DefaultWindow
	}

	pods, err := s.k8sClient.GetPods(namespace)
	if err != nil {
		return nil, fmt.Errorf("failed to get pods: %w", err)
	}

	svcProtocols, err := s.k8sClient.GetServicePortProtocols(namespace)
	if err != nil {
		slog.Warn("topology could not load Kubernetes service protocols", "namespace", namespace, "error", err)
		svcProtocols = map[string]string{}
	}
	clusterIPs, err := s.k8sClient.GetServiceClusterIPs(namespace)
	if err != nil {
		slog.Warn("topology could not load Kubernetes Service IPs", "namespace", namespace, "error", err)
		clusterIPs = map[string]string{}
	}
	podIPs, err := s.k8sClient.GetPodIPs(namespace)
	if err != nil {
		slog.Warn("topology could not load Kubernetes Pod IPs", "namespace", namespace, "error", err)
		podIPs = map[string]string{}
	}

	// Combine ClusterIPs and PodIPs into a unified IP resolution map
	ipToService := make(map[string]string)
	for ip, svc := range clusterIPs {
		ipToService[ip] = svc
	}
	for ip, svc := range podIPs {
		ipToService[ip] = svc
	}

	nodeMap := make(map[string]models.Node)
	for _, pod := range pods {
		svcName := pod.WorkloadName
		if svcName == "" {
			svcName = extractServiceName(pod.Name)
		}
		if _, exists := nodeMap[svcName]; !exists {
			proto := svcProtocols[svcName]
			if proto == "" {
				proto = "TCP"
			}
			nodeMap[svcName] = models.Node{
				ID:        svcName,
				Label:     svcName,
				Type:      "service",
				Namespace: namespace,
				Protocol:  proto,
			}
		}
	}

	edges, err := s.buildEdges(namespace, window, ipToService, svcProtocols, nodeMap)
	if err != nil {
		slog.Warn("topology edge construction failed", "namespace", namespace, "window", window, "error", err)
		edges = []models.Edge{}
	}

	nodes := make([]models.Node, 0, len(nodeMap))
	for _, node := range nodeMap {
		var totalInboundRate float64
		var maxLatency float64
		var totalErrors float64
		rateSource := ""
		latencySource := ""
		for _, e := range edges {
			if e.Target == node.ID {
				totalInboundRate += e.Rate
				if e.Rate > 0 {
					rateSource = weakerSource(rateSource, e.RateSource)
				}
				if e.LatencyP95 > maxLatency {
					maxLatency = e.LatencyP95
				}
				if e.LatencyP95 > 0 {
					latencySource = weakerSource(latencySource, e.LatencySource)
				}
				totalErrors += e.ErrorRate * e.Rate
			}
		}
		// A node's numbers are only populated when it actually received traffic.
		// Leaving Rate/LatencyP95 at zero with an empty source is what tells the
		// UI "not measured" instead of "measured as 0 req/s / 0 ms".
		if totalInboundRate > 0 {
			node.Rate = totalInboundRate
			node.RateSource = rateSource
			node.ErrorRate = totalErrors / totalInboundRate
			if maxLatency > 0 {
				node.LatencyP95 = maxLatency
				node.LatencySource = latencySource
			}
		}
		nodes = append(nodes, node)
	}

	return &models.Topology{Nodes: nodes, Edges: edges}, nil
}
