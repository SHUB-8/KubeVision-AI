package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kubevision/backend/internal/clients/k8s"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/internal/clients/tempo"
	"github.com/kubevision/backend/models"
)

type TopologyService struct {
	k8sClient   *k8s.Client
	promClient  *prometheus.Client
	tempoClient *tempo.Client
}

func NewTopologyService(k8sClient *k8s.Client, promClient *prometheus.Client, tempoClient *tempo.Client) *TopologyService {
	return &TopologyService{
		k8sClient:   k8sClient,
		promClient:  promClient,
		tempoClient: tempoClient,
	}
}

func (s *TopologyService) GetTopology(ctx context.Context, namespace, window string) (*models.Topology, error) {
	if window == "" {
		window = "5m"
	}

	pods, err := s.k8sClient.GetPods(namespace)
	if err != nil {
		return nil, fmt.Errorf("failed to get pods: %w", err)
	}

	svcProtocols, _ := s.k8sClient.GetServicePortProtocols(namespace)
	clusterIPs, _ := s.k8sClient.GetServiceClusterIPs(namespace)
	podIPs, _ := s.k8sClient.GetPodIPs(namespace)

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

	edges, err := s.buildEdges(ctx, namespace, window, ipToService, svcProtocols, nodeMap)
	if err != nil {
		edges = []models.Edge{}
	}

	nodes := make([]models.Node, 0, len(nodeMap))
	for _, node := range nodeMap {
		nodes = append(nodes, node)
	}

	return &models.Topology{Nodes: nodes, Edges: edges}, nil
}

type edgeAccumulator struct {
	source    string
	target    string
	protocol  string
	rate      float64
	errorRate float64
	bytesRate float64
}

type rawMetricEntry struct {
	Metric map[string]string `json:"metric"`
	Value  []interface{}     `json:"value"`
}

func parseMetricEntries(raw json.RawMessage) []rawMetricEntry {
	var results []rawMetricEntry
	if err := json.Unmarshal(raw, &results); err != nil {
		return nil
	}
	return results
}

func parseRateValue(val []interface{}) float64 {
	if len(val) >= 2 {
		switch v := val[1].(type) {
		case float64:
			return v
		case string:
			var f float64
			fmt.Sscanf(v, "%f", &f)
			return f
		}
	}
	return 0
}

func (s *TopologyService) buildEdges(
	ctx context.Context,
	namespace, window string,
	ipToService map[string]string,
	svcProtocols map[string]string,
	nodeMap map[string]models.Node,
) ([]models.Edge, error) {
	edgeMap := make(map[string]*edgeAccumulator)

	getOrCreate := func(src, dst string) *edgeAccumulator {
		key := src + "->" + dst
		if e, exists := edgeMap[key]; exists {
			return e
		}
		e := &edgeAccumulator{source: src, target: dst}
		edgeMap[key] = e
		return e
	}

	// 1. Layer 1: L7 Outbound Client Metrics from Prometheus (HTTP)
	if httpData, err := s.promClient.GetClientMetrics(namespace, window); err == nil {
		for _, r := range parseMetricEntries(httpData) {
			src := r.Metric["service_name"]
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			if target == "" || src == target {
				continue
			}
			rate := parseRateValue(r.Value)
			e := getOrCreate(src, target)
			e.rate += rate
			e.protocol = "HTTP/1.1"
		}
	}

	// 2. Layer 1: L7 Outbound Client Metrics from Prometheus (gRPC)
	if rpcData, err := s.promClient.GetRPCClientMetrics(namespace, window); err == nil {
		for _, r := range parseMetricEntries(rpcData) {
			src := r.Metric["service_name"]
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			if target == "" || src == target {
				continue
			}
			rate := parseRateValue(r.Value)
			e := getOrCreate(src, target)
			e.rate += rate
			e.protocol = "gRPC"
		}
	}

	// 3. Layer 2: OpenTelemetry Distributed Trace Spans from Tempo
	// Automatically discovers DBs (Redis RESP, Postgres, MySQL), message queues, and caller clients
	if s.tempoClient != nil {
		if traceEdges, err := s.tempoClient.GetTraceEdges(ctx, 30); err == nil {
			for _, te := range traceEdges {
				src := resolveTarget(te.Source, ipToService)
				target := resolveTarget(te.Target, ipToService)
				if src == "" || target == "" || src == target {
					continue
				}
				e := getOrCreate(src, target)
				if e.protocol == "" {
					e.protocol = te.Protocol
				}
			}
		}
	}

	// 4. Layer 3: eBPF Network Flow Metrics from Beyla (Prometheus)
	// Captures ALL protocol network flows (TCP, RESP, DBs, uninstrumented clients)
	if flowData, err := s.promClient.GetNetworkFlows(namespace, window); err == nil {
		s.processFlows(flowData, namespace, ipToService, svcProtocols, nodeMap, getOrCreate, edgeMap)
	}
	if outFlowData, err := s.promClient.GetOutboundNetworkFlows(namespace, window); err == nil {
		s.processFlows(outFlowData, namespace, ipToService, svcProtocols, nodeMap, getOrCreate, edgeMap)
	}

	// 5. Query Inbound Server Rates to enrich uninstrumented caller edges (e.g. loadgenerator -> frontend)
	srvRateMap := make(map[string]float64)
	if srvRatesRaw, err := s.promClient.GetServiceRates(namespace, window); err == nil {
		for _, r := range parseMetricEntries(srvRatesRaw) {
			svc := r.Metric["service_name"]
			if svc != "" {
				srvRateMap[svc] = parseRateValue(r.Value)
			}
		}
	}

	// For polyglot services without native Go server metrics,
	// accumulate inbound call rates from their client callers
	for _, e := range edgeMap {
		if e.rate > 0 {
			srvRateMap[e.target] += e.rate
		}
	}

	// 6. Finalize Edge Protocols and Rates
	var edges []models.Edge
	edgeID := 0

	for _, e := range edgeMap {
		// Only retain edges whose source and target exist in our inventory
		if _, srcExists := nodeMap[e.source]; !srcExists {
			continue
		}
		if _, dstExists := nodeMap[e.target]; !dstExists {
			continue
		}

		// Dynamically resolve protocol if still unset
		if e.protocol == "" {
			if p, ok := svcProtocols[e.target]; ok && p != "" {
				e.protocol = p
			} else if p, ok := svcProtocols[e.source]; ok && p != "" {
				e.protocol = p
			} else {
				e.protocol = "TCP"
			}
		}

		// If L7 rate was 0 (e.g. client without Beyla probe, or DB with RESP/TCP),
		// fall back to the operational rate of the connected peer
		if e.rate == 0 {
			if targetRate, ok := srvRateMap[e.target]; ok && targetRate > 0 {
				e.rate = targetRate
			} else if srcRate, ok := srvRateMap[e.source]; ok && srcRate > 0 {
				e.rate = srcRate
			}
		}

		// Ensure the node's protocol badge reflects the discovered protocol
		if node, ok := nodeMap[e.target]; ok && (node.Protocol == "" || node.Protocol == "TCP") {
			node.Protocol = e.protocol
			nodeMap[e.target] = node
		}
		if node, ok := nodeMap[e.source]; ok && (node.Protocol == "" || node.Protocol == "TCP") {
			if e.protocol == "HTTP/1.1" || e.protocol == "HTTPS" {
				node.Protocol = e.protocol
				nodeMap[e.source] = node
			}
		}

		edges = append(edges, models.Edge{
			ID:       fmt.Sprintf("e%d", edgeID),
			Source:   e.source,
			Target:   e.target,
			Protocol: e.protocol,
			Rate:     e.rate,
		})
		edgeID++
	}

	return edges, nil
}

func (s *TopologyService) processFlows(
	raw json.RawMessage,
	namespace string,
	ipToService map[string]string,
	svcProtocols map[string]string,
	nodeMap map[string]models.Node,
	getOrCreate func(string, string) *edgeAccumulator,
	edgeMap map[string]*edgeAccumulator,
) {
	for _, r := range parseMetricEntries(raw) {
		srcRaw := r.Metric["k8s_src_owner_name"]
		dstRaw := r.Metric["k8s_dst_owner_name"]
		dir := r.Metric["direction"]

		if srcRaw == "" || dstRaw == "" || srcRaw == dstRaw {
			continue
		}

		// Filter out infrastructure agents outside the user's workload scope
		if isSystemWorkload(srcRaw) && r.Metric["k8s_src_namespace"] != namespace {
			continue
		}
		if isSystemWorkload(dstRaw) && r.Metric["k8s_dst_namespace"] != namespace {
			continue
		}

		source := resolveTarget(srcRaw, ipToService)
		target := resolveTarget(dstRaw, ipToService)
		if source == "" || target == "" || source == target {
			continue
		}

		byteRate := parseRateValue(r.Value)
		if dir == "response" {
			// Response packets flow in the return direction; ignore to prevent back-edges
			continue
		}

		if dir == "request" {
			e := getOrCreate(source, target)
			e.bytesRate += byteRate
		} else if dir == "unknown" {
			// For raw socket flows where protocol handshake is opaque (e.g. client -> service):
			_, dstIsSvc := svcProtocols[target]
			_, srcIsSvc := svcProtocols[source]

			var edgeSrc, edgeDst string
			if dstIsSvc && !srcIsSvc {
				edgeSrc, edgeDst = source, target
			} else if srcIsSvc && !dstIsSvc {
				edgeSrc, edgeDst = target, source
			} else {
				edgeSrc, edgeDst = source, target
			}

			// Do not override an already discovered forward edge with a reverse flow
			revKey := edgeDst + "->" + edgeSrc
			if _, revExists := edgeMap[revKey]; revExists {
				continue
			}

			e := getOrCreate(edgeSrc, edgeDst)
			e.bytesRate += byteRate
		}
	}
}

func resolveTarget(addr string, ipToService map[string]string) string {
	clean := extractServiceFromAddress(addr)
	if svc, ok := ipToService[clean]; ok {
		return svc
	}
	// Strip standard Kubernetes DNS domain suffixes: "svc.namespace.svc.cluster.local" -> "svc"
	if idx := strings.Index(clean, "."); idx > 0 {
		clean = clean[:idx]
	}
	return clean
}

func extractServiceFromAddress(addr string) string {
	if idx := strings.Index(addr, ":"); idx > 0 {
		return addr[:idx]
	}
	return addr
}

func extractServiceName(podName string) string {
	parts := strings.Split(podName, "-")
	if len(parts) >= 3 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	if len(parts) == 2 {
		return parts[0]
	}
	return podName
}

func isSystemWorkload(name string) bool {
	switch name {
	case "coredns", "kube-dns", "beyla", "tempo", "prometheus", "loki", "fluent-bit", "opentelemetry-operator":
		return true
	}
	return false
}
