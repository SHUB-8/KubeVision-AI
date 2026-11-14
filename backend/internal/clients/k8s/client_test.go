package k8s

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestExtractServiceName(t *testing.T) {
	tests := []struct {
		podName  string
		expected string
	}{
		{"frontend-6b474476c4-abcde", "frontend"},
		{"cartservice-7d88b48b94-xyz12", "cartservice"},
		{"redis-cart-0", "redis-cart"},
		{"standalone", "standalone"},
	}

	for _, tc := range tests {
		got := ExtractServiceName(tc.podName)
		if got != tc.expected {
			t.Errorf("ExtractServiceName(%q) = %q, want %q", tc.podName, got, tc.expected)
		}
	}
}

func TestExtractWorkloadName(t *testing.T) {
	if got := ExtractWorkloadName(nil); got != "" {
		t.Errorf("ExtractWorkloadName(nil) = %q, want empty", got)
	}

	podWithLabel := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "pod-12345-abcde",
			Labels: map[string]string{
				"app.kubernetes.io/name": "paymentservice",
			},
		},
	}
	if got := ExtractWorkloadName(podWithLabel); got != "paymentservice" {
		t.Errorf("ExtractWorkloadName() = %q, want paymentservice", got)
	}

	podWithOwnerRS := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "emailservice-6b474476c4-xyz12",
			OwnerReferences: []metav1.OwnerReference{
				{
					Kind: "ReplicaSet",
					Name: "emailservice-6b474476c4",
				},
			},
		},
	}
	if got := ExtractWorkloadName(podWithOwnerRS); got != "emailservice" {
		t.Errorf("ExtractWorkloadName() = %q, want emailservice", got)
	}
}

func TestDetectProtocolFromPort(t *testing.T) {
	httpProto := "http"
	if got := DetectProtocolFromPort("web", &httpProto, 80); got != "HTTP/1.1" {
		t.Errorf("expected HTTP/1.1, got %q", got)
	}
	grpcProto := "grpc"
	if got := DetectProtocolFromPort("rpc", &grpcProto, 50051); got != "gRPC" {
		t.Errorf("expected gRPC, got %q", got)
	}
	if got := DetectProtocolFromPort("redis", nil, 6379); got != "Redis (RESP)" {
		t.Errorf("expected Redis (RESP), got %q", got)
	}
}
