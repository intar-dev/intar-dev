package fs

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestEnsureDirRequiresPath(t *testing.T) {
	if err := EnsureDir("", 0o755); err == nil {
		t.Fatalf("expected error for empty path")
	}
	if err := EnsureDir("   ", 0o755); err == nil {
		t.Fatalf("expected error for blank path")
	}
}

func TestEnsureDirCreatesNestedDirectories(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a", "b", "c")
	if err := EnsureDir(dir, 0o755); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("expected directory at %s", dir)
	}
}

func TestWriteFileAtomicRequiresPath(t *testing.T) {
	if err := WriteFileAtomic("", []byte("data"), 0o600); err == nil {
		t.Fatalf("expected error for empty path")
	}
}

func TestWriteFileAtomicWritesContentAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "file.txt")
	if err := WriteFileAtomic(path, []byte("hello"), 0o600); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("content = %q, want %q", data, "hello")
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
		}
	}
}

func TestWriteFileAtomicOverwritesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.txt")
	if err := WriteFileAtomic(path, []byte("first"), 0o644); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := WriteFileAtomic(path, []byte("second"), 0o600); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(data) != "second" {
		t.Fatalf("content = %q, want %q", data, "second")
	}
}

func TestWriteFileAtomicLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file.txt")
	if err := WriteFileAtomic(path, []byte("data"), 0o600); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") {
			t.Fatalf("leftover temp file: %s", entry.Name())
		}
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly one file, got %d", len(entries))
	}
}
