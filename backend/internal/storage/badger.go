package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/dgraph-io/badger/v4"
)

const DefaultRetentionTTL = 7 * 24 * time.Hour

type Store struct {
	db *badger.DB
}

func NewStore(path string) (*Store, error) {
	opts := badger.DefaultOptions(path).
		WithNumVersionsToKeep(1).
		WithLogger(nil)

	db, err := badger.Open(opts)
	if err != nil {
		return nil, fmt.Errorf("failed to open badger: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Set(key string, value interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to marshal value: %w", err)
	}
	return s.db.Update(func(txn *badger.Txn) error {
		return txn.SetEntry(badger.NewEntry([]byte(key), data))
	})
}

func (s *Store) SetWithTTL(key string, value interface{}, ttl time.Duration) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to marshal value: %w", err)
	}
	return s.db.Update(func(txn *badger.Txn) error {
		return txn.SetEntry(badger.NewEntry([]byte(key), data).WithTTL(ttl))
	})
}

// RunValueLogGC periodically reclaims obsolete value-log data. Badger returns
// ErrNoRewrite when no file currently meets the discard threshold; that is a
// normal idle result, not a GC failure.
func (s *Store) RunValueLogGC(interval time.Duration, discardRatio float64, stop <-chan struct{}) {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	if discardRatio <= 0 || discardRatio >= 1 {
		discardRatio = 0.5
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			for {
				err := s.db.RunValueLogGC(discardRatio)
				if errors.Is(err, badger.ErrNoRewrite) {
					break
				}
				if err != nil {
					slog.Warn("Badger value-log GC failed", "error", err)
					break
				}
			}
		}
	}
}

func (s *Store) Get(key string, dest interface{}) error {
	return s.db.View(func(txn *badger.Txn) error {
		item, err := txn.Get([]byte(key))
		if err == badger.ErrKeyNotFound {
			return fmt.Errorf("key not found: %s", key)
		}
		if err != nil {
			return err
		}
		return item.Value(func(val []byte) error {
			return json.Unmarshal(val, dest)
		})
	})
}

func (s *Store) Delete(key string) error {
	return s.db.Update(func(txn *badger.Txn) error {
		return txn.Delete([]byte(key))
	})
}

func (s *Store) List(prefix string) (map[string][]byte, error) {
	result := make(map[string][]byte)
	prefixBytes := []byte(prefix)
	return result, s.db.View(func(txn *badger.Txn) error {
		opts := badger.DefaultIteratorOptions
		opts.Prefix = prefixBytes
		it := txn.NewIterator(opts)
		defer it.Close()
		for it.Rewind(); it.Valid(); it.Next() {
			item := it.Item()
			key := string(item.Key())
			err := item.Value(func(val []byte) error {
				result[key] = append([]byte{}, val...)
				return nil
			})
			if err != nil {
				return err
			}
		}
		return nil
	})
}
