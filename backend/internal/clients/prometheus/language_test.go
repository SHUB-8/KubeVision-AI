package prometheus

import (
	"encoding/json"
	"testing"
)

func TestParseServiceLanguages(t *testing.T) {
	raw := json.RawMessage(`[
		{"metric":{"service_name":"frontend","telemetry_sdk_language":"go"},"value":[1,"1"]},
		{"metric":{"service_name":"adservice","telemetry_sdk_language":"Java"},"value":[1,"1"]},
		{"metric":{"service_name":"nocontainer","telemetry_sdk_language":""},"value":[1,"1"]},
		{"metric":{"telemetry_sdk_language":"python"},"value":[1,"1"]},
		{"metric":{"service_name":"spaces","telemetry_sdk_language":"  nodejs  "},"value":[1,"1"]}
	]`)

	languages := ParseServiceLanguages(raw)

	// Languages are normalized so the UI's display-name map and any equality
	// check do not have to care about casing or stray whitespace.
	if got, want := languages["frontend"], "go"; got != want {
		t.Errorf("frontend language = %q, want %q", got, want)
	}
	if got, want := languages["adservice"], "java"; got != want {
		t.Errorf("adservice language = %q, want %q", got, want)
	}
	if got, want := languages["spaces"], "nodejs"; got != want {
		t.Errorf("spaces language = %q, want %q", got, want)
	}
	// A series without a service name or language is skipped, never guessed.
	if _, exists := languages[""]; exists {
		t.Error("series without service_name must not produce an entry")
	}
	if _, exists := languages["nocontainer"]; exists {
		t.Error("empty telemetry_sdk_language must not produce an entry")
	}
	if len(languages) != 3 {
		t.Errorf("got %d languages, want 3: %v", len(languages), languages)
	}
}

func TestParseServiceLanguagesMalformed(t *testing.T) {
	if got := ParseServiceLanguages(json.RawMessage(`{"not":"a vector"}`)); got != nil {
		t.Errorf("malformed payload must yield nil, got %v", got)
	}
}
