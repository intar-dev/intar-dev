package operation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/intar-dev/stardrive/internal/fs"
	"github.com/intar-dev/stardrive/internal/names"
)

type Store struct {
	root string
}

func NewStore(root string) *Store {
	return &Store{root: root}
}

func (s *Store) OperationDir(cluster string) string {
	cluster = names.Slugify(cluster)
	return filepath.Join(s.root, "operations", cluster)
}

func (s *Store) Save(op *Operation) error {
	if op == nil {
		return fmt.Errorf("operation is required")
	}

	path := filepath.Join(s.OperationDir(op.Cluster), op.ID+".json")
	data, err := json.MarshalIndent(op, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal operation: %w", err)
	}
	return fs.WriteFileAtomic(path, data, 0o644)
}

func (s *Store) Load(cluster, id string) (*Operation, error) {
	path := filepath.Join(s.OperationDir(cluster), strings.TrimSpace(id)+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read operation %s: %w", path, err)
	}

	var op Operation
	if err := json.Unmarshal(data, &op); err != nil {
		return nil, fmt.Errorf("decode operation %s: %w", path, err)
	}

	return &op, nil
}

func (s *Store) Latest(cluster string, opType Type) (*Operation, error) {
	dir := s.OperationDir(cluster)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read operation dir %s: %w", dir, err)
	}

	type candidate struct {
		name string
		mod  int64
	}

	items := make([]candidate, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, fmt.Errorf("read operation info %s: %w", entry.Name(), err)
		}
		items = append(items, candidate{name: entry.Name(), mod: info.ModTime().UnixNano()})
	}

	sort.Slice(items, func(i, j int) bool { return items[i].mod > items[j].mod })
	for _, item := range items {
		id := strings.TrimSuffix(item.name, ".json")
		op, err := s.Load(cluster, id)
		if err != nil {
			return nil, err
		}
		if opType == "" || op.Type == opType {
			return op, nil
		}
	}

	return nil, nil
}

func (s *Store) StartOrResume(cluster string, opType Type, phases []string) (*Operation, bool, error) {
	if existing, err := s.Latest(cluster, opType); err != nil {
		return nil, false, err
	} else if existing != nil && !existing.IsComplete() && slices.Equal(existing.PhaseOrder, phases) {
		return existing, true, nil
	}

	op, err := New(uuid.NewString(), opType, cluster, phases)
	if err != nil {
		return nil, false, err
	}
	if err := s.Save(op); err != nil {
		return nil, false, err
	}
	return op, false, nil
}

func (s *Store) DeleteCluster(cluster string) error {
	return os.RemoveAll(s.OperationDir(cluster))
}
