package k8s

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kubevision/backend/models"
)

type Client struct{}

func NewClient() (*Client, error) {
	cmd := exec.Command("kubectl", "cluster-info")
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("kubectl not available: %w", err)
	}
	return &Client{}, nil
}

func (c *Client) GetPods(namespace string) ([]models.PodInfo, error) {
	out, err := kubectl("get", "pods", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []struct {
			Metadata struct {
				Name              string            `json:"name"`
				Namespace         string            `json:"namespace"`
				CreationTimestamp string            `json:"creationTimestamp"`
				Labels            map[string]string `json:"labels"`
			} `json:"metadata"`
			Spec struct {
				NodeName string `json:"nodeName"`
			} `json:"spec"`
			Status struct {
				Phase             string `json:"phase"`
				PodIP             string `json:"podIP"`
				ContainerStatuses []struct {
					RestartCount int32 `json:"restartCount"`
				} `json:"containerStatuses"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}

	pods := make([]models.PodInfo, 0, len(result.Items))
	for _, p := range result.Items {
		var restarts int32
		for _, cs := range p.Status.ContainerStatuses {
			restarts += cs.RestartCount
		}
		pods = append(pods, models.PodInfo{
			Name:      p.Metadata.Name,
			Namespace: p.Metadata.Namespace,
			Status:    p.Status.Phase,
			Node:      p.Spec.NodeName,
			IP:        p.Status.PodIP,
			Restart:   restarts,
			Age:       p.Metadata.CreationTimestamp,
		})
	}
	return pods, nil
}

func (c *Client) GetClusterInfo() (*models.ClusterInfo, error) {
	out, err := kubectl("get", "nodes", "-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				NodeInfo struct {
					KubeletVersion string `json:"kubeletVersion"`
				} `json:"nodeInfo"`
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}

	nodeName, nodeStatus, version := "unknown", "unknown", "unknown"
	if len(result.Items) > 0 {
		n := result.Items[0]
		nodeName = n.Metadata.Name
		version = n.Status.NodeInfo.KubeletVersion
		for _, c := range n.Status.Conditions {
			if c.Type == "Ready" {
				if c.Status == "True" {
					nodeStatus = "Ready"
				} else {
					nodeStatus = "NotReady"
				}
				break
			}
		}
	}

	return &models.ClusterInfo{Name: "k3s", Version: version, Node: nodeName, Status: nodeStatus}, nil
}

func (c *Client) GetNamespaces() ([]string, error) {
	out, err := kubectl("get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}")
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(out)), nil
}

func (c *Client) GetServiceClusterIPs(namespace string) (map[string]string, error) {
	out, err := kubectl("get", "services", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
	}

	var result struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				ClusterIP string `json:"clusterIP"`
			} `json:"spec"`
		} `json:"items"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		return nil, err
	}

	ipToService := make(map[string]string)
	for _, svc := range result.Items {
		if svc.Spec.ClusterIP != "" && svc.Spec.ClusterIP != "None" {
			ipToService[svc.Spec.ClusterIP] = svc.Metadata.Name
		}
	}
	return ipToService, nil
}

func kubectl(args ...string) ([]byte, error) {
	cmd := exec.Command("kubectl", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("kubectl %s: %s: %w", strings.Join(args, " "), string(out), err)
	}
	return out, nil
}
