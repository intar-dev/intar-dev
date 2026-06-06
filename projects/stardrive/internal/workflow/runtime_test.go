package workflow

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/intar-dev/stardrive/internal/config"
)

func TestCiliumCLIVersionIsPinned(t *testing.T) {
	t.Parallel()

	if defaultCiliumCLIVersion != "v0.19.2" {
		t.Fatalf("expected pinned Cilium CLI version v0.19.2, got %q", defaultCiliumCLIVersion)
	}
}

func TestEnsureClusterAccessSecretsSkipsReloadWhenExistingSecretsSatisfyRequirement(t *testing.T) {
	t.Parallel()

	called := false
	existing := clusterAccessSecrets{
		TalosconfigYAML: []byte("talosconfig"),
		KubeconfigYAML:  []byte("kubeconfig"),
	}

	got, err := ensureClusterAccessSecrets(existing, true, func() (clusterAccessSecrets, error) {
		called = true
		return clusterAccessSecrets{}, nil
	})
	if err != nil {
		t.Fatalf("ensure cluster access secrets: %v", err)
	}
	if called {
		t.Fatal("expected loader to be skipped")
	}
	if string(got.TalosconfigYAML) != "talosconfig" || string(got.KubeconfigYAML) != "kubeconfig" {
		t.Fatalf("unexpected secrets returned: %+v", got)
	}
}

func TestEnsureClusterAccessSecretsReloadsMissingKubeconfig(t *testing.T) {
	t.Parallel()

	called := false
	got, err := ensureClusterAccessSecrets(clusterAccessSecrets{
		TalosconfigYAML: []byte("talosconfig"),
	}, true, func() (clusterAccessSecrets, error) {
		called = true
		return clusterAccessSecrets{
			TalosconfigYAML: []byte("talosconfig"),
			KubeconfigYAML:  []byte("kubeconfig"),
		}, nil
	})
	if err != nil {
		t.Fatalf("ensure cluster access secrets: %v", err)
	}
	if !called {
		t.Fatal("expected loader to be called")
	}
	if string(got.KubeconfigYAML) != "kubeconfig" {
		t.Fatalf("expected kubeconfig to be reloaded, got %q", string(got.KubeconfigYAML))
	}
}

func TestEnsureClusterAccessSecretsFailsWhenReloadStillMissingRequiredSecret(t *testing.T) {
	t.Parallel()

	_, err := ensureClusterAccessSecrets(clusterAccessSecrets{}, true, func() (clusterAccessSecrets, error) {
		return clusterAccessSecrets{
			TalosconfigYAML: []byte("talosconfig"),
		}, nil
	})
	if err == nil {
		t.Fatal("expected error when kubeconfig is still missing")
	}
	if err.Error() != "kubeconfig is missing" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestCiliumEnvKeepsCommandStateUnderStateDir(t *testing.T) {
	t.Parallel()

	stateDir := t.TempDir()
	kubeconfigPath := filepath.Join(t.TempDir(), "kubeconfig")
	app := NewApp(context.Background(), Options{
		Paths: config.Paths{StateDir: stateDir},
	})

	env, err := app.ciliumEnv(kubeconfigPath)
	if err != nil {
		t.Fatalf("cilium env: %v", err)
	}

	want := map[string]string{
		"KUBECONFIG":       kubeconfigPath,
		"HOME":             filepath.Join(stateDir, "command-home"),
		"DARWIN_CACHE":     filepath.Join(stateDir, "command-home", "Library", "Caches"),
		"XDG_CACHE_HOME":   filepath.Join(stateDir, "command-home", "cache"),
		"XDG_CONFIG_HOME":  filepath.Join(stateDir, "command-home", "config"),
		"XDG_DATA_HOME":    filepath.Join(stateDir, "command-home", "data"),
		"HELM_CACHE_HOME":  filepath.Join(stateDir, "command-home", "cache", "helm"),
		"HELM_CONFIG_HOME": filepath.Join(stateDir, "command-home", "config", "helm"),
		"HELM_DATA_HOME":   filepath.Join(stateDir, "command-home", "data", "helm"),
	}
	for key, value := range want {
		if key != "DARWIN_CACHE" && env[key] != value {
			t.Fatalf("expected %s=%q, got %q", key, value, env[key])
		}
		if key == "KUBECONFIG" {
			continue
		}
		info, err := os.Stat(value)
		if err != nil {
			t.Fatalf("expected %s directory %s: %v", key, value, err)
		}
		if !info.IsDir() {
			t.Fatalf("expected %s to be a directory", value)
		}
	}
}
