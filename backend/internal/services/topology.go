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

	pods, err := s.k8sClient.GetPods(ctx, namespace)
	if err != nil {
		return nil, fmt.Errorf("failed to get pods: %w", err)
	}

	svcProtocols, err := s.k8sClient.GetServicePortProtocols(ctx, namespace)
	if err != nil {
		slog.Warn("topology could not load Kubernetes service protocols", "namespace", namespace, "error", err)
		svcProtocols = map[string]string{}
	}
	clusterIPs, err := s.k8sClient.GetServiceClusterIPs(ctx, namespace)
	if err != nil {
		slog.Warn("topology could not load Kubernetes Service IPs", "namespace", namespace, "error", err)
		clusterIPs = map[string]string{}
	}
	podIPs, err := s.k8sClient.GetPodIPs(ctx, namespace)
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
			svcName = k8s.ExtractServiceName(pod.Name)
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

	edges, serverLatencies, err := s.buildEdges(ctx, namespace, window, ipToService, svcProtocols, nodeMap)
	if err != nil {
		slog.Warn("topology edge construction failed", "namespace", namespace, "window", window, "error", err)
		edges = []models.Edge{}
		serverLatencies = map[string]float64{}
	}

	nodes := make([]models.Node, 0, len(nodeMap))
	for _, node := range nodeMap {
		var totalInboundRate float64
		var totalInboundBytes float64
		var weightedLatencySum float64
		var totalLatencyRate float64
		var totalErrors float64
		rateSource := ""
		latencySource := ""
		for _, e := range edges {
			if e.Target == node.ID {
				totalInboundRate += e.Rate
				totalInboundBytes += e.BytesRate
				if e.Rate > 0 {
					rateSource = weakerSource(rateSource, e.RateSource)
				}
				if e.LatencyP95 > 0 && e.Rate > 0 {
					weightedLatencySum += e.LatencyP95 * e.Rate
					totalLatencyRate += e.Rate
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
			node.BytesRate = totalInboundBytes
			node.RateSource = rateSource
			node.ErrorRate = totalErrors / totalInboundRate

			// Standard SRE practice: A service node's latency is its measured server-side
			// response duration (RED golden signal). If server-side metrics are unavailable
			// (e.g. datastores or external endpoints), fall back to the traffic-weighted
			// caller-observed latency across all incoming edges.
			// Guard: If a server-side metric pegged to the Prometheus histogram boundary
			// (>=10.0s) due to upper-bound extrapolation with low/uneven samples, but caller-observed
			// edges report credible operational latencies (<5.0s), prefer the traffic-weighted caller latency.
			sLat, hasServer := serverLatencies[node.ID]
			weightedCallerLat := 0.0
			if totalLatencyRate > 0 {
				weightedCallerLat = weightedLatencySum / totalLatencyRate
			}

			if hasServer && sLat > 0 && !(sLat >= 10.0 && weightedCallerLat > 0 && weightedCallerLat < 5.0) {
				node.LatencyP95 = sLat
				node.LatencySource = models.SourceMetrics
			} else if weightedCallerLat > 0 {
				node.LatencyP95 = weightedCallerLat
				node.LatencySource = latencySource
			} else if hasServer && sLat > 0 {
				node.LatencyP95 = sLat
				node.LatencySource = models.SourceMetrics
			}
		} else if totalInboundBytes > 0 {
			node.BytesRate = totalInboundBytes
		}
		nodes = append(nodes, node)
	}

	return &models.Topology{Nodes: nodes, Edges: edges}, nil
}
