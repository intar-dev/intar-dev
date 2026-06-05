package workflow

import "testing"

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
