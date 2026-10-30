package services

import (
	"github.com/kubevision/backend/models"
	"strings"
)

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func namespaceFromAddress(address string) string {
	host := address
	if colon := strings.Index(host, ":"); colon >= 0 {
		host = host[:colon]
	}
	parts := strings.Split(host, ".")
	if len(parts) >= 4 && parts[2] == "svc" {
		return parts[1]
	}
	return ""
}

func ensureTopologyNode(nodeMap map[string]models.Node, name, endpointNamespace, selectedNamespace string, serviceProtocols map[string]string) string {
	if endpointNamespace == "" {
		endpointNamespace = namespaceFromAddress(name)
	}
	if endpointNamespace != "" && endpointNamespace != selectedNamespace {
		id := endpointNamespace + "/" + name
		if _, exists := nodeMap[id]; !exists {
			nodeMap[id] = models.Node{ID: id, Label: name, Type: "cross-namespace", Namespace: endpointNamespace}
		}
		return id
	}
	if protocol, exists := serviceProtocols[name]; exists {
		nodeMap[name] = models.Node{ID: name, Label: name, Type: "service", Namespace: selectedNamespace, Protocol: protocol}
		return name
	}
	id := "external:" + name
	if _, exists := nodeMap[id]; !exists {
		nodeMap[id] = models.Node{ID: id, Label: name, Type: "external", Namespace: endpointNamespace}
	}
	return id
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

func isDatabaseOrCache(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "redis") ||
		strings.Contains(lower, "postgres") ||
		strings.Contains(lower, "mysql") ||
		strings.Contains(lower, "mongo") ||
		strings.Contains(lower, "mariadb") ||
		strings.Contains(lower, "cassandra") ||
		strings.Contains(lower, "memcached") ||
		strings.Contains(lower, "database") ||
		strings.Contains(lower, "cache")
}

func isTrafficGenerator(name string) bool {
	lower := strings.ToLower(name)
	return strings.Contains(lower, "loadgenerator") ||
		strings.Contains(lower, "locust") ||
		strings.Contains(lower, "jmeter") ||
		strings.Contains(lower, "k6")
}
