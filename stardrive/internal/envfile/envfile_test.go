package envfile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	data := []byte(`
# comment
INFISICAL_CLIENT_ID=test-client
HCLOUD_TOKEN="secret value"
export CLOUDFLARE_API_TOKEN=token
QUOTED_SINGLE='hello world'
INLINE=value # trailing comment
`)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write env file: %v", err)
	}

	t.Setenv("INFISICAL_CLIENT_ID", "existing")

	loaded, err := Load(path, false)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if loaded != 4 {
		t.Fatalf("unexpected loaded count: %d", loaded)
	}
	if got := os.Getenv("INFISICAL_CLIENT_ID"); got != "existing" {
		t.Fatalf("expected existing env to win, got %q", got)
	}
	if got := os.Getenv("HCLOUD_TOKEN"); got != "secret value" {
		t.Fatalf("unexpected HCLOUD_TOKEN: %q", got)
	}
	if got := os.Getenv("CLOUDFLARE_API_TOKEN"); got != "token" {
		t.Fatalf("unexpected CLOUDFLARE_API_TOKEN: %q", got)
	}
	if got := os.Getenv("QUOTED_SINGLE"); got != "hello world" {
		t.Fatalf("unexpected QUOTED_SINGLE: %q", got)
	}
	if got := os.Getenv("INLINE"); got != "value" {
		t.Fatalf("unexpected INLINE: %q", got)
	}
}
