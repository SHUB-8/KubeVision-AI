package prometheus

import "testing"

func TestExtractPodName(t *testing.T) {
	tests := []struct {
		metric   map[string]string
		expected string
	}{
		{map[string]string{"pod": "frontend-123"}, "frontend-123"},
		{map[string]string{"k8s_pod_name": "cartservice-456"}, "cartservice-456"},
		{map[string]string{"pod": "priority-pod", "k8s_pod_name": "other-pod"}, "priority-pod"},
		{map[string]string{"container": "app"}, ""},
	}

	for _, tc := range tests {
		got := ExtractPodName(tc.metric)
		if got != tc.expected {
			t.Errorf("ExtractPodName(%v) = %q, want %q", tc.metric, got, tc.expected)
		}
	}
}
