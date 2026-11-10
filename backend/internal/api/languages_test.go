package api

import (
	"testing"

	"github.com/kubevision/backend/models"
)

func TestMergeServiceLanguagesPrefersMetrics(t *testing.T) {
	fromMetrics := map[string]string{
		"frontend":    "go",
		"cartservice": "dotnet",
	}
	fromTraces := map[string]string{
		"frontend":     "python",
		"emailservice": " Python ",
	}

	merged := mergeServiceLanguages(fromMetrics, fromTraces)

	// target_info is a direct observation of the owning process, so it wins
	// over a trace value sampled from a single fetched span.
	if got, want := merged["frontend"], "go"; got != want {
		t.Errorf("frontend = %q, want %q", got, want)
	}
	if got, want := merged["cartservice"], "dotnet"; got != want {
		t.Errorf("cartservice = %q, want %q", got, want)
	}
	// Trace-only services still get a language, normalized.
	if got, want := merged["emailservice"], "python"; got != want {
		t.Errorf("emailservice = %q, want %q", got, want)
	}
}

func TestMergeServiceLanguagesEmpty(t *testing.T) {
	if got := mergeServiceLanguages(nil, nil); got != nil {
		t.Errorf("no observations must yield nil, got %v", got)
	}
	if got := mergeServiceLanguages(map[string]string{"frontend": "  "}, nil); len(got) != 0 {
		t.Errorf("blank language must not create an entry, got %v", got)
	}
}

func TestAttachNodeLanguagesOnlyServiceNodes(t *testing.T) {
	topology := &models.Topology{Nodes: []models.Node{
		{ID: "frontend", Type: "service"},
		{ID: "redis-cart", Type: "service"},
		{ID: "external:db.example", Type: "external"},
		{ID: "other/frontend", Type: "cross-namespace"},
	}}

	attachNodeLanguages(topology, map[string]string{
		"frontend":            "go",
		"external:db.example": "postgres",
		"other/frontend":      "go",
	})

	if got, want := topology.Nodes[0].Language, "go"; got != want {
		t.Errorf("service node language = %q, want %q", got, want)
	}
	// A service with no observation must stay empty rather than inherit a
	// neighbour's language.
	if got := topology.Nodes[1].Language; got != "" {
		t.Errorf("unobserved service language = %q, want empty", got)
	}
	// External and cross-namespace nodes have no local process to observe.
	for _, index := range []int{2, 3} {
		if got := topology.Nodes[index].Language; got != "" {
			t.Errorf("node %s language = %q, want empty", topology.Nodes[index].Type, got)
		}
	}
}

func TestAttachNodeLanguagesNilTopology(t *testing.T) {
	attachNodeLanguages(nil, map[string]string{"frontend": "go"})
}
