package k8s

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/kubevision/backend/models"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/clientcmd"
)

// Client talks to the Kubernetes API directly via client-go. It works both
// in-cluster (ServiceAccount token) and locally (default kubeconfig rules:
// KUBECONFIG env var, ~/.kube/config).
type Client struct {
	clientset   *kubernetes.Clientset
	clusterName string

	// Short-TTL cache for pod inventories. /services and /topology both list
	// pods on every request (and every 15s auto-refresh); the List call costs
	// 100-400ms against the API server. A few seconds of staleness is fine for
	// dashboards — the /events informer remains the source for event streams.
	podsMu    sync.Mutex
	podsCache map[string]podCacheEntry
}

type podCacheEntry struct {
	pods    []models.PodInfo
	expires time.Time
}

// Just under the 15s auto-refresh so a scheduled refresh mostly reads cache;
// long enough that the occasional fresh List amortizes across viewers.
const podsCacheTTL = 12 * time.Second

func NewClient(clusterName string) (*Client, error) {
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
	return &Client{clientset: clientset, clusterName: clusterName, podsCache: make(map[string]podCacheEntry)}, nil
}

func (c *Client) ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 15*time.Second)
}

func (c *Client) GetPods(namespace string) ([]models.PodInfo, error) {
	// Single-flight: the check, the API list and the store all happen under
	// one lock, so concurrent requests during a miss WAIT for the fresh list
	// instead of stampeding the API server (k3s throttles at ~1.3s per list
	// on this host — two simultaneous misses used to cost 2x that).
	c.podsMu.Lock()
	defer c.podsMu.Unlock()

	if entry, ok := c.podsCache[namespace]; ok && time.Now().Before(entry.expires) {
		return entry.pods, nil
	}

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
	c.podsCache[namespace] = podCacheEntry{pods: pods, expires: time.Now().Add(podsCacheTTL)}
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
		Name:    c.clusterName,
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

// WatchWarningEvents persists only Warning events. Informer updates are
// delivered for repeated Kubernetes Events as their Count and last timestamp
// change, so callers must upsert from both AddFunc and UpdateFunc.
func (c *Client) WatchWarningEvents(ctx context.Context, namespaces []string, onWarning func(*corev1.Event)) error {
	unique := make([]string, 0, len(namespaces))
	seen := make(map[string]struct{}, len(namespaces))
	for _, namespace := range namespaces {
		if namespace == "" {
			continue
		}
		if _, exists := seen[namespace]; exists {
			continue
		}
		seen[namespace] = struct{}{}
		unique = append(unique, namespace)
	}
	if len(unique) == 0 {
		return fmt.Errorf("no namespaces configured for Kubernetes Event watching")
	}

	informers := make([]cache.SharedIndexInformer, 0, len(unique))
	for _, namespace := range unique {
		listWatch := cache.NewFilteredListWatchFromClient(
			c.clientset.CoreV1().RESTClient(), "events", namespace,
			func(*metav1.ListOptions) {},
		)
		informer := cache.NewSharedIndexInformer(listWatch, &corev1.Event{}, 0, cache.Indexers{})
		writeWarning := func(obj interface{}) {
			event, ok := obj.(*corev1.Event)
			if !ok || event.Type != corev1.EventTypeWarning || onWarning == nil {
				return
			}
			onWarning(event.DeepCopy())
		}
		if _, err := informer.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    writeWarning,
			UpdateFunc: func(_, newObj interface{}) { writeWarning(newObj) },
		}); err != nil {
			return fmt.Errorf("register Kubernetes Event informer for namespace %q: %w", namespace, err)
		}
		informers = append(informers, informer)
	}

	for _, informer := range informers {
		go informer.Run(ctx.Done())
	}
	cacheSyncs := make([]cache.InformerSynced, 0, len(informers))
	for _, informer := range informers {
		cacheSyncs = append(cacheSyncs, informer.HasSynced)
	}
	if !cache.WaitForCacheSync(ctx.Done(), cacheSyncs...) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("Kubernetes Event informer cache failed to sync")
	}
	slog.Info("Kubernetes Warning Event informers synchronized", "namespaces", unique)
	<-ctx.Done()
	return ctx.Err()
}

func EventRecord(event *corev1.Event) models.KubernetesEvent {
	count := event.Count
	if count < 1 {
		count = 1
	}
	first := event.FirstTimestamp.Time
	if first.IsZero() {
		first = event.EventTime.Time
	}
	if first.IsZero() {
		first = event.CreationTimestamp.Time
	}
	last := event.LastTimestamp.Time
	if event.Series != nil {
		if event.Series.Count > count {
			count = event.Series.Count
		}
		if !event.Series.LastObservedTime.IsZero() {
			last = event.Series.LastObservedTime.Time
		}
	}
	if last.IsZero() {
		last = first
	}
	uid := string(event.UID)
	if uid == "" {
		uid = "name-" + event.Namespace + "-" + event.Name
	}
	component := event.ReportingController
	if component == "" {
		component = event.Source.Component
	}
	return models.KubernetesEvent{
		UID:                uid,
		Namespace:          event.Namespace,
		Name:               event.Name,
		Type:               event.Type,
		Reason:             event.Reason,
		Message:            event.Message,
		Count:              count,
		FirstObservedAt:    first.UTC().Format(time.RFC3339Nano),
		LastObservedAt:     last.UTC().Format(time.RFC3339Nano),
		InvolvedObjectKind: event.InvolvedObject.Kind,
		InvolvedObjectName: event.InvolvedObject.Name,
		InvolvedObjectUID:  string(event.InvolvedObject.UID),
		ReportingComponent: component,
	}
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

// GetDeclaredServiceEndpoints dynamically inspects the Kubernetes Service spec for any namespace and service,
// returning declared ports and protocols without any hardcoded service names.
func (c *Client) GetDeclaredServiceEndpoints(namespace, serviceName string) ([]models.Endpoint, error) {
	ctx, cancel := c.ctx()
	defer cancel()

	svc, err := c.clientset.CoreV1().Services(namespace).Get(ctx, serviceName, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}

	var endpoints []models.Endpoint
	for _, port := range svc.Spec.Ports {
		proto := DetectProtocolFromPort(port.Name, port.AppProtocol, port.Port)
		path := fmt.Sprintf(":%d", port.Port)
		if port.Name != "" {
			path = fmt.Sprintf(":%d (%s)", port.Port, port.Name)
		}
		endpoints = append(endpoints, models.Endpoint{
			Service: serviceName,
			Path:    path,
			Method:  proto,
		})
	}
	return endpoints, nil
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
