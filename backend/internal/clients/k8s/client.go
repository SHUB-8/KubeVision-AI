package k8s

import (
	"context"
	"fmt"
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
			Name:      p.Name,
			Namespace: p.Namespace,
			Status:    string(p.Status.Phase),
			Node:      p.Spec.NodeName,
			IP:        p.Status.PodIP,
			Restart:   restarts,
			Age:       p.CreationTimestamp.Format(time.RFC3339),
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
