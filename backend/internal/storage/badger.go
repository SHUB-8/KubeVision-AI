package storage

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/dgraph-io/badger/v4"
)

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
