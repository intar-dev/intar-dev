package talos

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResolveBootstrapVersions(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/talos/releases", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"tag_name":"v1.12.1","draft":false,"prerelease":false},
			{"tag_name":"v1.12.0","draft":false,"prerelease":false},
			{"tag_name":"v1.11.7","draft":false,"prerelease":false}
		]`))
	})
	mux.HandleFunc("/kubernetes/stable-1.35.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("v1.35.3"))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	resolver := &ReleaseResolver{
		httpClient:             server.Client(),
		supportedTalosMinor:    "1.12",
		talosReleasesURLFmt:    server.URL + "/talos/releases?per_page=%d",
		kubernetesStableURLFmt: server.URL + "/kubernetes/stable-%s.txt",
	}

	talosVersion, kubernetesVersion, err := resolver.ResolveBootstrapVersions(context.Background(), "", "")
	if err != nil {
		t.Fatalf("ResolveBootstrapVersions returned error: %v", err)
	}
	if talosVersion != "v1.12.1" {
		t.Fatalf("unexpected Talos version: %s", talosVersion)
	}
	if kubernetesVersion != "1.35.3" {
		t.Fatalf("unexpected Kubernetes version: %s", kubernetesVersion)
	}
}

func TestStableTalosVersions(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/talos/releases", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"tag_name":"v1.12.1","draft":false,"prerelease":false},
			{"tag_name":"v1.12.0","draft":false,"prerelease":false},
			{"tag_name":"v1.11.7","draft":false,"prerelease":false},
			{"tag_name":"v1.13.0-beta.1","draft":false,"prerelease":true}
		]`))
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	resolver := &ReleaseResolver{
		httpClient:          server.Client(),
		supportedTalosMinor: "1.12",
		talosReleasesURLFmt: server.URL + "/talos/releases?per_page=%d",
	}
	versions, err := resolver.StableTalosVersions(context.Background(), 2)
	if err != nil {
		t.Fatalf("StableTalosVersions returned error: %v", err)
	}
	if len(versions) != 2 {
		t.Fatalf("unexpected version count: %d", len(versions))
	}
	if versions[0] != "v1.12.1" || versions[1] != "v1.12.0" {
		t.Fatalf("unexpected versions: %#v", versions)
	}
}

func TestResolveBootstrapVersionsKeepsOverrides(t *testing.T) {
	resolver := NewReleaseResolver()
	talosVersion, kubernetesVersion, err := resolver.ResolveBootstrapVersions(context.Background(), "1.11.4", "v1.34.2")
	if err != nil {
		t.Fatalf("ResolveBootstrapVersions returned error: %v", err)
	}
	if talosVersion != "v1.11.4" {
		t.Fatalf("unexpected Talos version: %s", talosVersion)
	}
	if kubernetesVersion != "1.34.2" {
		t.Fatalf("unexpected Kubernetes version: %s", kubernetesVersion)
	}
}
