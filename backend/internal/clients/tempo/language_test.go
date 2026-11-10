package tempo

import "testing"

func TestNoteLanguageMajorityWins(t *testing.T) {
	client := &Client{}

	// A service is normally reported consistently; the incumbent wins on ties
	// and a single stray observation must not relabel it.
	client.noteLanguage("cartservice", "dotnet")
	client.noteLanguage("cartservice", "dotnet")
	client.noteLanguage("cartservice", "cpp")

	if got := client.ServiceLanguages()["cartservice"]; got != "dotnet" {
		t.Errorf("language = %q, want dotnet (stray observation must not flip)", got)
	}

	// Only once a conflicting observation outnumbers the incumbent does the
	// winner change.
	for i := 0; i < 3; i++ {
		client.noteLanguage("cartservice", "cpp")
	}
	if got := client.ServiceLanguages()["cartservice"]; got != "cpp" {
		t.Errorf("language = %q, want cpp (majority must win)", got)
	}
}

func TestNoteLanguageNormalizesAndSkipsEmpty(t *testing.T) {
	client := &Client{}
	client.noteLanguage(" frontend ", " Go ")
	if got := client.ServiceLanguages()["frontend"]; got != "go" {
		t.Errorf("language = %q, want go", got)
	}

	client.noteLanguage("", "go")
	client.noteLanguage("empty", "   ")
	if _, exists := client.ServiceLanguages()[""]; exists {
		t.Error("empty service name must not be recorded")
	}
	if _, exists := client.ServiceLanguages()["empty"]; exists {
		t.Error("empty language must not be recorded")
	}
}

func TestServiceLanguagesSnapshotIsACopy(t *testing.T) {
	client := &Client{}
	client.noteLanguage("frontend", "go")

	snapshot := client.ServiceLanguages()
	snapshot["frontend"] = "mutated"

	if got := client.ServiceLanguages()["frontend"]; got != "go" {
		t.Errorf("callers must not be able to mutate the cache, got %q", got)
	}
}
