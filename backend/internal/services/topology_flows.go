package services

import (
	"encoding/json"
	"github.com/kubevision/backend/models"
)

func (s *TopologyService) processFlows(
	raw json.RawMessage,
	namespace string,
	ipToService map[string]string,
	svcProtocols map[string]string,
	nodeMap map[string]models.Node,
	getOrCreate func(string, string, string, string) *edgeAccumulator,
	edgeKey func(string, string, string, string) string,
	edgeMap map[string]*edgeAccumulator,
) {
	for _, r := range parseMetricEntries(raw) {
		srcRaw := r.Metric["k8s_src_owner_name"]
		dstRaw := r.Metric["k8s_dst_owner_name"]
		dir := r.Metric["direction"]

		sourceNS := firstNonEmpty(r.Metric["k8s_src_namespace"], namespace)
		targetNS := r.Metric["k8s_dst_namespace"]
		if srcRaw == "" || dstRaw == "" || (srcRaw == dstRaw && (targetNS == "" || sourceNS == targetNS)) {
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
		if source == "" || target == "" || (source == target && (targetNS == "" || sourceNS == targetNS)) {
			continue
		}

		if isDatabaseOrCache(source) && !isDatabaseOrCache(target) {
			source, target = target, source
			r.Metric["k8s_src_namespace"], r.Metric["k8s_dst_namespace"] = r.Metric["k8s_dst_namespace"], r.Metric["k8s_src_namespace"]
		} else if isTrafficGenerator(target) && !isTrafficGenerator(source) {
			source, target = target, source
			r.Metric["k8s_src_namespace"], r.Metric["k8s_dst_namespace"] = r.Metric["k8s_dst_namespace"], r.Metric["k8s_src_namespace"]
		}

		byteRate := parseRateValue(r.Value)
		if dir == "response" {
			// Response packets flow in the return direction; ignore to prevent back-edges
			continue
		}

		if dir == "request" {
			sourceNS := firstNonEmpty(r.Metric["k8s_src_namespace"], namespace)
			targetNS := r.Metric["k8s_dst_namespace"]
			e := getOrCreate(source, target, sourceNS, targetNS)
			setEdgeNamespaces(e, sourceNS, targetNS)
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
			edgeSourceNS := firstNonEmpty(r.Metric["k8s_src_namespace"], namespace)
			edgeTargetNS := r.Metric["k8s_dst_namespace"]
			if edgeSrc != source {
				edgeSourceNS, edgeTargetNS = edgeTargetNS, edgeSourceNS
			}
			revKey := edgeKey(edgeDst, edgeSrc, edgeTargetNS, edgeSourceNS)
			if _, revExists := edgeMap[revKey]; revExists {
				continue
			}

			e := getOrCreate(edgeSrc, edgeDst, edgeSourceNS, edgeTargetNS)
			setEdgeNamespaces(e, edgeSourceNS, edgeTargetNS)
			e.bytesRate += byteRate
		}
	}
}

func setEdgeNamespaces(edge *edgeAccumulator, sourceNamespace, targetNamespace string) {
	if sourceNamespace != "" {
		edge.sourceNamespace = sourceNamespace
	}
	if targetNamespace != "" {
		edge.targetNamespace = targetNamespace
	}
}
