package loki

import (
	"testing"
)

func TestBuildLogQL(t *testing.T) {
	ql := BuildLogQL("boutique", "frontend", "")
	expected := `kubernetes_namespace_name="boutique", kubernetes_pod_name=~"frontend($|[-.]).*"`
	if ql != "{"+expected+"}" {
		t.Errorf("BuildLogQL() = %q, want %q", ql, "{"+expected+"}")
	}

	qlWithFilter := BuildLogQL("boutique", "frontend", "error")
	expectedFilter := `kubernetes_namespace_name="boutique", kubernetes_pod_name=~"frontend($|[-.]).*"} |~ "(?i)error"`
	if qlWithFilter != "{"+expectedFilter {
		t.Errorf("BuildLogQL() with filter = %q, want %q", qlWithFilter, "{"+expectedFilter)
	}
}
