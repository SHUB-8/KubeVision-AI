package storage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestStoreIterateValues(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(filepath.Join(dir, "badger"))
	if err != nil {
		t.Fatalf("failed to create store: %v", err)
	}
	defer store.Close()

	payload1 := map[string]string{"name": "event-1"}
	payload2 := map[string]string{"name": "event-2"}
	payload3 := map[string]string{"name": "other-1"}

	if err := store.Set("event:k8s:test:1", payload1); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if err := store.Set("event:k8s:test:2", payload2); err != nil {
		t.Fatalf("set failed: %v", err)
	}
	if err := store.Set("other:k8s:test:3", payload3); err != nil {
		t.Fatalf("set failed: %v", err)
	}

	var count int
	err = store.IterateValues("event:k8s:test:", func(val []byte) error {
		var item map[string]string
		if err := json.Unmarshal(val, &item); err != nil {
			return err
		}
		count++
		return nil
	})
	if err != nil {
		t.Fatalf("IterateValues failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 items, got %d", count)
	}

	// Test early stop
	var earlyCount int
	err = store.IterateValues("event:k8s:test:", func(val []byte) error {
		earlyCount++
		return ErrStopIteration
	})
	if err != nil {
		t.Fatalf("IterateValues early stop failed: %v", err)
	}
	if earlyCount != 1 {
		t.Errorf("expected early stop at 1 item, got %d", earlyCount)
	}
}

func init() {
	_ = os.Setenv("TMPDIR", "/tmp")
}
