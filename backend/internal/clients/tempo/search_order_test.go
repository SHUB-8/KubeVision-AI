package tempo

import (
	"errors"
	"testing"

	"github.com/kubevision/backend/models"
)

func traceWithStart(id string, start int64) models.Trace {
	return models.Trace{TraceID: id, Spans: []models.Span{{SpanID: id + "-s", StartTime: start}}}
}

func TestChooseSearchResultPrefersFreshPrimaryEvenWhenShorter(t *testing.T) {
	primary := []models.Trace{traceWithStart("a", 300), traceWithStart("b", 200)}
	fallback := []models.Trace{traceWithStart("c", 100), traceWithStart("d", 90), traceWithStart("e", 80)}
	got, err := chooseSearchResult(primary, nil, fallback, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != len(primary) || got[0].TraceID != "a" {
		t.Fatalf("expected the non-empty primary result, got %+v", got)
	}
}

func TestChooseSearchResultUsesFallbackOnlyWhenPrimaryEmpty(t *testing.T) {
	fallback := []models.Trace{traceWithStart("c", 100)}
	got, err := chooseSearchResult(nil, nil, fallback, nil)
	if err != nil || len(got) != 1 || got[0].TraceID != "c" {
		t.Fatalf("expected fallback, got %+v err=%v", got, err)
	}
	// primary error + empty fallback must surface the primary error
	if _, err := chooseSearchResult(nil, errors.New("boom"), nil, nil); err == nil {
		t.Fatal("expected the primary error to surface")
	}
}

func TestSortTracesByStartDescNewestFirstWithStableTieBreak(t *testing.T) {
	traces := []models.Trace{
		traceWithStart("old", 100),
		traceWithStart("new", 300),
		traceWithStart("mid-b", 200),
		traceWithStart("mid-a", 200),
	}
	sortTracesByStartDesc(traces)
	got := []string{traces[0].TraceID, traces[1].TraceID, traces[2].TraceID, traces[3].TraceID}
	want := []string{"new", "mid-a", "mid-b", "old"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
}

func TestTraceEarliestSpanStartUsesMinimum(t *testing.T) {
	tr := models.Trace{TraceID: "t", Spans: []models.Span{
		{SpanID: "a", StartTime: 500},
		{SpanID: "b", StartTime: 100},
		{SpanID: "c", StartTime: 300},
	}}
	if got := traceEarliestSpanStart(tr); got != 100 {
		t.Fatalf("earliest = %d, want 100", got)
	}
}

func TestCandidateStartUnixNanoParsesTempoMetadata(t *testing.T) {
	if got := candidateStartUnixNano(tempoTrace{StartTimeUnixNano: "1700000000000000000"}); got != 1700000000000000000 {
		t.Fatalf("start = %d", got)
	}
	if got := candidateStartUnixNano(tempoTrace{StartTimeUnixNano: "garbage"}); got != 0 {
		t.Fatalf("invalid metadata should sort last, got %d", got)
	}
}
