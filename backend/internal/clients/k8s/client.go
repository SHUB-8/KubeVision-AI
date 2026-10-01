package k8s

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/kubevision/backend/models"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

// Client talks to the Kubernetes API directly via client-go. It works both
// in-cluster (ServiceAccount token) and locally (default kubeconfig rules:
// KUBECONFIG env var, ~/.kube/config).
type Client struct {
	clientset *kubernetes.Clientset
}

func NewClient() (*Client, error) {
	config, err := rest.InClusterConfig()
	if err != nil {
		// Not running inside the cluster - fall back to kubeconfig (local dev)
		kubeconfig, kubeErr := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			clientcmd.NewDefaultClientConfigLoadingRules(),
			&clientcmd.ConfigOverrides{},
		).ClientConfig()
		if kubeErr != nil {
			return nil, fmt.Errorf("no in-cluster config and no kubeconfig found: %w", err)
		}
		config = kubeconfig
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create kubernetes client: %w", err)
	}
	return &Client{clientset: clientset}, nil
}

func (c *Client) ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

func (c *Client) GetPods(namespace string) ([]models.PodInfo, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	list, err := c.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list pods: %w", err)
	}

	pods := make([]models.PodInfo, 0, len(list.Items))
	for _, p := range list.Items {
		var restarts int32
		for _, cs := range p.Status.ContainerStatuses {
			restarts += cs.RestartCount
		}
		pods = append(pods, models.PodInfo{
			Name:         p.Name,
			Namespace:    p.Namespace,
			Status:       string(p.Status.Phase),
			Node:         p.Spec.NodeName,
			IP:           p.Status.PodIP,
			Restart:      restarts,
			Age:          p.CreationTimestamp.Format(time.RFC3339),
			WorkloadName: ExtractWorkloadName(p),
		})
	}
	return pods, nil
}

func (c *Client) GetClusterInfo() (*models.ClusterInfo, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	version, err := c.clientset.Discovery().ServerVersion()
	if err != nil {
		return nil, fmt.Errorf("failed to get server version: %w", err)
	}

	nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list nodes: %w", err)
	}

	nodeName, nodeStatus := "unknown", "unknown"
	if len(nodes.Items) > 0 {
		nodeName = nodes.Items[0].Name
		nodeStatus = "Ready"
		for _, n := range nodes.Items {
			for _, cond := range n.Status.Conditions {
				if cond.Type == corev1.NodeReady && cond.Status != corev1.ConditionTrue {
					nodeStatus = "NotReady"
					break
				}
			}
		}
	}

	return &models.ClusterInfo{
		Name:    "k3s",
		Version: version.GitVersion,
		Node:    nodeName,
		Status:  nodeStatus,
	}, nil
}

func (c *Client) GetNamespaces() ([]string, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	list, err := c.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list namespaces: %w", err)
	}

	names := make([]string, 0, len(list.Items))
	for _, ns := range list.Items {
		names = append(names, ns.Name)
	}
	return names, nil
}

func (c *Client) GetServiceClusterIPs(namespace string) (map[string]string, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	list, err := c.clientset.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	ipToService := make(map[string]string)
	for _, svc := range list.Items {
		if svc.Spec.ClusterIP != "" && svc.Spec.ClusterIP != "None" {
			ipToService[svc.Spec.ClusterIP] = svc.Name
		}
	}
	return ipToService, nil
}

func (c *Client) GetPodIPs(namespace string) (map[string]string, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	list, err := c.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list pods for ip mapping: %w", err)
	}

	ipMap := make(map[string]string)
	for _, pod := range list.Items {
		if pod.Status.PodIP != "" {
			ipMap[pod.Status.PodIP] = ExtractWorkloadName(pod)
		}
	}
	return ipMap, nil
}

func (c *Client) GetServicePortProtocols(namespace string) (map[string]string, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	list, err := c.clientset.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list services: %w", err)
	}

	protocols := make(map[string]string)
	for _, svc := range list.Items {
		var proto string
		for _, port := range svc.Spec.Ports {
			detected := DetectProtocolFromPort(port.Name, port.AppProtocol, port.Port)
			if detected != "" && detected != "TCP" {
				proto = detected
				break
			}
			if proto == "" {
				proto = detected
			}
		}
		if proto == "" {
			proto = "TCP"
		}
		protocols[svc.Name] = proto
	}
	return protocols, nil
}

// DetectProtocolFromPort evaluates appProtocol, port name, and port number
// to determine standard protocol (HTTP/1.1, HTTPS, gRPC, Redis (RESP), PostgreSQL, MySQL, Kafka, etc.)
func DetectProtocolFromPort(name string, appProtocol *string, port int32) string {
	if appProtocol != nil && *appProtocol != "" {
		appProto := strings.ToLower(*appProtocol)
		switch appProto {
		case "http":
			return "HTTP/1.1"
		case "https":
			return "HTTPS"
		case "grpc":
			return "gRPC"
		case "redis":
			return "Redis (RESP)"
		case "mysql":
			return "MySQL"
		case "postgres", "postgresql":
			return "PostgreSQL"
		case "mongo", "mongodb":
			return "MongoDB"
		case "kafka":
			return "Kafka"
		case "amqp", "rabbitmq":
			return "RabbitMQ"
		}
	}

	pName := strings.ToLower(name)
	if strings.Contains(pName, "redis") {
		return "Redis (RESP)"
	}
	if strings.Contains(pName, "grpc") {
		return "gRPC"
	}
	if strings.Contains(pName, "http") || strings.Contains(pName, "web") {
		return "HTTP/1.1"
	}
	if strings.Contains(pName, "postgres") || strings.Contains(pName, "pgsql") {
		return "PostgreSQL"
	}
	if strings.Contains(pName, "mysql") {
		return "MySQL"
	}
	if strings.Contains(pName, "mongo") {
		return "MongoDB"
	}
	if strings.Contains(pName, "kafka") {
		return "Kafka"
	}
	if strings.Contains(pName, "amqp") || strings.Contains(pName, "rabbit") {
		return "RabbitMQ"
	}
	if strings.Contains(pName, "dns") {
		return "DNS"
	}

	switch port {
	case 80, 8080, 8000, 3000, 5000, 8888:
		return "HTTP/1.1"
	case 443, 8443:
		return "HTTPS"
	case 6379, 6380, 26379:
		return "Redis (RESP)"
	case 5432, 5433:
		return "PostgreSQL"
	case 3306, 33060:
		return "MySQL"
	case 27017, 27018, 27019:
		return "MongoDB"
	case 9092, 9093, 9094:
		return "Kafka"
	case 5672, 15672:
		return "RabbitMQ"
	case 4222:
		return "NATS"
	case 9042:
		return "Cassandra"
	case 9200, 9300:
		return "Elasticsearch"
	case 11211:
		return "Memcached"
	case 50051, 50052, 9555, 7070, 5050, 7000, 3550:
		return "gRPC"
	}

	return "TCP"
}

// ExtractWorkloadName resolves the top-level owner or app name for a pod.
func ExtractWorkloadName(pod corev1.Pod) string {
	if name, ok := pod.Labels["app.kubernetes.io/name"]; ok && name != "" {
		return name
	}
	if app, ok := pod.Labels["app"]; ok && app != "" {
		return app
	}
	if inst, ok := pod.Labels["app.kubernetes.io/instance"]; ok && inst != "" {
		return inst
	}

	for _, owner := range pod.OwnerReferences {
		if owner.Kind == "ReplicaSet" {
			idx := strings.LastIndex(owner.Name, "-")
			if idx > 0 {
				return owner.Name[:idx]
			}
			return owner.Name
		}
		if owner.Kind == "StatefulSet" || owner.Kind == "DaemonSet" || owner.Kind == "Job" {
			return owner.Name
		}
	}

	parts := strings.Split(pod.Name, "-")
	if len(parts) >= 3 {
		return strings.Join(parts[:len(parts)-2], "-")
	}
	return pod.Name
}
