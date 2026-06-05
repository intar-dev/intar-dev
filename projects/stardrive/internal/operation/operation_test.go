package operation

import (
	"path/filepath"
	"testing"
)

func TestOperationResumeAndPersist(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(dir)

	op, resumed, err := store.StartOrResume("prod", TypeBootstrap, []string{"one", "two"})
	if err != nil {
		t.Fatalf("start operation: %v", err)
	}
	if resumed {
		t.Fatalf("expected new operation")
	}

	if err := op.StartPhase("one"); err != nil {
		t.Fatalf("start phase: %v", err)
	}
	if err := op.CompletePhase("one", map[string]string{"ok": "true"}); err != nil {
		t.Fatalf("complete phase: %v", err)
	}
	if err := store.Save(op); err != nil {
		t.Fatalf("save operation: %v", err)
	}

	loaded, err := store.Load("prod", op.ID)
	if err != nil {
		t.Fatalf("load operation: %v", err)
	}
	if loaded.ResumePhase() != "two" {
		t.Fatalf("unexpected resume phase: %s", loaded.ResumePhase())
	}

	latest, err := store.Latest("prod", TypeBootstrap)
	if err != nil {
		t.Fatalf("latest operation: %v", err)
	}
	if latest == nil || latest.ID != op.ID {
		t.Fatalf("expected latest operation %s", op.ID)
	}

	if err := store.DeleteCluster("prod"); err != nil {
		t.Fatalf("delete cluster operations: %v", err)
	}
	if _, err := store.Load("prod", op.ID); err == nil {
		t.Fatalf("expected load error after delete")
	}

	if got := filepath.Clean(store.OperationDir("prod")); got != filepath.Join(dir, "operations", "prod") {
		t.Fatalf("unexpected operation dir: %s", got)
	}
}
