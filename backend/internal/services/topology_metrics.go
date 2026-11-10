package services

import (
	"encoding/json"
	"fmt"
	"github.com/kubevision/backend/internal/clients/prometheus"
	"github.com/kubevision/backend/models"
	"math"
	"strconv"
)

type edgeAccumulator struct {
	source          string
	target          string
	sourceNamespace string
	targetNamespace string
	protocol        string
	rate            float64
	errorRate       float64
	latencyP95      float64
	bytesRate       float64
	rateSource      string
	latencySource   string
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
			return finiteMetricValue(v)
		case string:
			f, err := strconv.ParseFloat(v, 64)
			if err == nil {
				return finiteMetricValue(f)
			}
		}
	}
	return 0
}

func finiteMetricValue(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}

// sourceRank orders provenance by strength of evidence. A larger rank is weaker.
func sourceRank(s string) int {
	switch s {
	case models.SourceMetrics:
		return 0
	case models.SourceTraces:
		return 1
	case models.SourceEstimated:
		return 2
	}
	return -1 // unset
}

// weakerSource returns whichever source is less trustworthy, so an aggregate
// never claims better evidence than its weakest input. An unset source means
// "no contribution" and yields to the other.
func weakerSource(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	if sourceRank(b) > sourceRank(a) {
		return b
	}
	return a
}

func (s *TopologyService) buildEdges(
	namespace, window string,
	ipToService map[string]string,
	svcProtocols map[string]string,
	nodeMap map[string]models.Node,
) ([]models.Edge, error) {
	edgeMap := make(map[string]*edgeAccumulator)

	nodeKey := func(name, endpointNamespace string) string {
		if endpointNamespace != "" && endpointNamespace != namespace {
			return endpointNamespace + "/" + name
		}
		return name
	}
	edgeKey := func(src, dst, sourceNamespace, targetNamespace string) string {
		return nodeKey(src, sourceNamespace) + "->" + nodeKey(dst, targetNamespace)
	}
	setNamespaces := func(e *edgeAccumulator, sourceNS, targetNS string) {
		if sourceNS != "" {
			e.sourceNamespace = sourceNS
		}
		if targetNS != "" {
			e.targetNamespace = targetNS
		}
	}
	getOrCreate := func(src, dst, sourceNamespace, targetNamespace string) *edgeAccumulator {
		key := edgeKey(src, dst, sourceNamespace, targetNamespace)
		if e, exists := edgeMap[key]; exists {
			setNamespaces(e, sourceNamespace, targetNamespace)
			return e
		}
		e := &edgeAccumulator{
			source: src, target: dst,
			sourceNamespace: sourceNamespace, targetNamespace: targetNamespace,
		}
		edgeMap[key] = e
		return e
	}

	// All Prometheus queries run CONCURRENTLY (independent) — sequential they
	// summed to seconds per /topology request.
	results := prometheus.FetchParallel(
		func() (json.RawMessage, error) { return s.promClient.GetClientMetrics(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetRPCClientMetrics(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetNetworkFlows(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetOutboundNetworkFlows(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetDBClientRates(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetDBClientLatency(namespace, window, "0.95") },
		func() (json.RawMessage, error) { return s.promClient.GetClientLatencyByEdge(namespace, window, "0.95") },
		func() (json.RawMessage, error) { return s.promClient.GetClientErrorsByEdge(namespace, window) },
		func() (json.RawMessage, error) { return s.promClient.GetServiceLatency(namespace, window, "0.95") },
		func() (json.RawMessage, error) {
			return s.promClient.GetClientLatencyByServer(namespace, window, "0.95")
		},
		func() (json.RawMessage, error) { return s.promClient.GetServiceRates(namespace, window) },
	)
	httpData, rpcData, flowData, outFlowData := results[0], results[1], results[2], results[3]
	dbRateData, dbLatData, latData, errData := results[4], results[5], results[6], results[7]
	httpLatData, srvLatData, srvRatesRaw := results[8], results[9], results[10]

	// 1. Layer 1: L7 Outbound Client Metrics from Prometheus (HTTP)
	if len(httpData) > 0 {
		for _, r := range parseMetricEntries(httpData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			rate := parseRateValue(r.Value)
			e := getOrCreate(src, target, namespace, targetNS)
			setNamespaces(e, namespace, targetNS)
			e.rate += rate
			e.rateSource = models.SourceMetrics
			e.protocol = "HTTP/1.1"
		}
	}

	// 2. Layer 1: L7 Outbound Client Metrics from Prometheus (gRPC)
	if len(rpcData) > 0 {
		for _, r := range parseMetricEntries(rpcData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			rate := parseRateValue(r.Value)
			e := getOrCreate(src, target, namespace, targetNS)
			setNamespaces(e, namespace, targetNS)
			e.rate += rate
			e.rateSource = models.SourceMetrics
			e.protocol = "gRPC"
		}
	}

	// 3. Layer 2: eBPF Network Flow Metrics from Beyla (Prometheus)
	// Captures ALL protocol network flows (TCP, RESP, DBs, uninstrumented clients)
	if len(flowData) > 0 {
		s.processFlows(flowData, namespace, ipToService, svcProtocols, nodeMap, getOrCreate, edgeKey, edgeMap)
	}
	if len(outFlowData) > 0 {
		s.processFlows(outFlowData, namespace, ipToService, svcProtocols, nodeMap, getOrCreate, edgeKey, edgeMap)
	}

	// 3b. Layer 1: DB / cache client metrics (Redis RESP, SQL, MongoDB, ...).
	// A datastore speaks neither HTTP nor gRPC, so no http_*/rpc_* family covers
	// it. These two queries are the only MEASURED source of rate and latency for
	// such a dependency - without them the edge falls back to borrowing a peer's
	// rate (marked "estimated") and reports no latency at all.
	if len(dbRateData) > 0 {
		for _, r := range parseMetricEntries(dbRateData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			e := getOrCreate(src, target, namespace, targetNS)
			setNamespaces(e, namespace, targetNS)
			e.rate += parseRateValue(r.Value)
			e.rateSource = models.SourceMetrics
		}
	}
	if len(dbLatData) > 0 {
		for _, r := range parseMetricEntries(dbLatData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			if e, ok := edgeMap[edgeKey(src, target, namespace, targetNS)]; ok {
				setNamespaces(e, namespace, targetNS)
				if lat := parseRateValue(r.Value); lat > 0 {
					e.latencyP95 = lat
					// Caller-observed, not server-side: the db_server
					// histogram mis-pairs operations on persistent
					// connections (see GetDBServerLatency).
					e.latencySource = models.SourceClientObserved
				}
			}
		}
	}

	// 5. Query Client Latency per Edge from Prometheus
	if len(latData) > 0 {
		for _, r := range parseMetricEntries(latData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			if e, ok := edgeMap[edgeKey(src, target, namespace, targetNS)]; ok {
				setNamespaces(e, namespace, targetNS)
				if lat := parseRateValue(r.Value); lat > 0 {
					e.latencyP95 = lat
					e.latencySource = models.SourceMetrics
				}
			}
		}
	}

	// 6. Query Client Error Rate per Edge from Prometheus
	if len(errData) > 0 {
		for _, r := range parseMetricEntries(errData) {
			src := prometheus.MetricServiceName(r.Metric)
			serverAddr := r.Metric["server_address"]
			if src == "" || serverAddr == "" {
				continue
			}
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			if target == "" || (src == target && (targetNS == "" || targetNS == namespace)) {
				continue
			}
			if e, ok := edgeMap[edgeKey(src, target, namespace, targetNS)]; ok {
				setNamespaces(e, namespace, targetNS)
				e.errorRate = parseRateValue(r.Value)
			}
		}
	}

	// 7. Query Server Latency for inbound HTTP callers (e.g. loadgenerator -> frontend)
	if len(httpLatData) > 0 {
		for _, r := range parseMetricEntries(httpLatData) {
			svc := prometheus.MetricServiceName(r.Metric)
			lat := parseRateValue(r.Value)
			if lat > 0 {
				for _, e := range edgeMap {
					if e.target == svc && (e.targetNamespace == "" || e.targetNamespace == namespace) && e.latencyP95 == 0 {
						e.latencyP95 = lat
						e.latencySource = models.SourceMetrics
					}
				}
			}
		}
	}

	// 8. Fall back to target server client latency if edge latency was not specifically partitioned
	if len(srvLatData) > 0 {
		for _, r := range parseMetricEntries(srvLatData) {
			serverAddr := r.Metric["server_address"]
			target := resolveTarget(serverAddr, ipToService)
			targetNS := firstNonEmpty(r.Metric["server_service_namespace"], r.Metric["server_k8s_namespace_name"], namespaceFromAddress(serverAddr))
			lat := parseRateValue(r.Value)
			if target != "" && lat > 0 {
				for _, e := range edgeMap {
					if e.target == target && (targetNS == "" || e.targetNamespace == targetNS) && e.latencyP95 == 0 {
						e.latencyP95 = lat
						e.latencySource = models.SourceMetrics
					}
				}
			}
		}
	}

	// 8b. DELIBERATELY NOT DONE: db_server_operation_duration_seconds.
	//
	// It looks like the natural way to give a datastore its own latency, but on
	// this stack the value is unusable. Measured for redis-cart over the same
	// 3.09 calls/s that cartservice sees as 0.16 ms:
	//
	//   client (cartservice, db_client_*): sum/count = 0.16 ms, p95 = 4.75 ms
	//   server (redis-cart,  db_server_*): sum/count = 320 ms,  p95 = 1717 ms
	//
	// The tell is that sum(rate(db_server_..._sum)) = 0.99 SECONDS PER SECOND -
	// the timer is effectively running continuously - and the implied "duration"
	// equals 1/request-rate (1/3.0877 = 0.324 s vs 0.320 s measured). That is the
	// signature of a request paired with the NEXT response, so the histogram
	// reports the inter-arrival gap rather than the operation duration.
	//
	// A number we have positive evidence to distrust is worse than no number:
	// the client-side metric above already covers this edge with a credible
	// value, so the server-side one is dropped rather than shown. Re-check the
	// arithmetic above before wiring it back in.

	// 8. Query Inbound Server Rates to enrich uninstrumented caller edges (e.g. loadgenerator -> frontend)
	srvRateMap := make(map[string]float64)
	if len(srvRatesRaw) > 0 {
		for _, r := range parseMetricEntries(srvRatesRaw) {
			svc := prometheus.MetricServiceName(r.Metric)
			if svc != "" {
				srvRateMap[nodeKey(svc, namespace)] = parseRateValue(r.Value)
			}
		}
	}

	// For polyglot services without native Go server metrics,
	// accumulate inbound call rates from their client callers
	for _, e := range edgeMap {
		if e.rate > 0 {
			srvRateMap[nodeKey(e.target, e.targetNamespace)] += e.rate
		}
	}

	// 9. Finalize Edge Protocols, Rates, Latencies, and Errors
	var edges []models.Edge
	edgeID := 0

	for _, e := range edgeMap {
		// Estimate from a namespace-aware peer before replacing names with
		// topology node IDs (remote nodes are namespace-qualified below).
		if e.rate == 0 {
			if targetRate, ok := srvRateMap[nodeKey(e.target, e.targetNamespace)]; ok && targetRate > 0 {
				e.rate = targetRate
				e.rateSource = models.SourceEstimated
			} else if srcRate, ok := srvRateMap[nodeKey(e.source, e.sourceNamespace)]; ok && srcRate > 0 {
				e.rate = srcRate
				e.rateSource = models.SourceEstimated
			}
		}

		// Only retain edges whose source and target exist in our inventory
		if _, srcExists := nodeMap[e.source]; !srcExists {
			e.source = ensureTopologyNode(nodeMap, e.source, e.sourceNamespace, namespace, svcProtocols)
		}
		if _, dstExists := nodeMap[e.target]; !dstExists {
			e.target = ensureTopologyNode(nodeMap, e.target, e.targetNamespace, namespace, svcProtocols)
		}

		// Dynamically resolve protocol from Kubernetes declared service ports if still unset
		if e.protocol == "" {
			if p, ok := svcProtocols[e.target]; ok && p != "" {
				e.protocol = p
			} else if p, ok := svcProtocols[e.source]; ok && p != "" {
				e.protocol = p
			} else {
				e.protocol = "TCP"
			}
		}

		edges = append(edges, models.Edge{
			ID:            fmt.Sprintf("e%d", edgeID),
			Source:        e.source,
			Target:        e.target,
			Protocol:      e.protocol,
			Rate:          e.rate,
			ErrorRate:     e.errorRate,
			LatencyP95:    e.latencyP95,
			RateSource:    e.rateSource,
			LatencySource: e.latencySource,
		})
		edgeID++
	}

	return edges, nil
}
