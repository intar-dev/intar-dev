package workflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderGitOpsSourceRendersTemplates(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	sourceRoot := t.TempDir()

	templatePath := filepath.Join(sourceRoot, "core", "cert-manager-issuer", "clusterissuer.yaml.tmpl")
	publicEdgeTemplatePath := filepath.Join(sourceRoot, "core", "public-edge", "gateway.yaml.tmpl")
	if err := os.MkdirAll(filepath.Dir(templatePath), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(templatePath, []byte("email: {{ .ACMEEmail }}\n"), 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(publicEdgeTemplatePath), 0o755); err != nil {
		t.Fatalf("mkdir public edge: %v", err)
	}
	if err := os.WriteFile(publicEdgeTemplatePath, []byte("host: {{ .AppWildcardDomain }}\napi: {{ .APIHostname }}\n"), 0o644); err != nil {
		t.Fatalf("write gateway template: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "kustomization.yaml"), []byte("kind: Kustomization\n"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	renderedRoot, cleanup, err := renderGitOpsSource(sourceRoot, cfg)
	if err != nil {
		t.Fatalf("render gitops source: %v", err)
	}
	defer cleanup()

	renderedPath := filepath.Join(renderedRoot, "core", "cert-manager-issuer", "clusterissuer.yaml")
	rendered, err := os.ReadFile(renderedPath)
	if err != nil {
		t.Fatalf("read rendered file: %v", err)
	}
	if strings.Contains(string(rendered), "{{") {
		t.Fatalf("expected template markers to be rendered, got %s", rendered)
	}
	if !strings.Contains(string(rendered), cfg.Cluster.ACMEEmail) {
		t.Fatalf("expected ACME email in rendered manifest, got %s", rendered)
	}

	publicEdgeRenderedPath := filepath.Join(renderedRoot, "core", "public-edge", "gateway.yaml")
	publicEdgeRendered, err := os.ReadFile(publicEdgeRenderedPath)
	if err != nil {
		t.Fatalf("read public edge rendered file: %v", err)
	}
	if !strings.Contains(string(publicEdgeRendered), cfg.AppWildcardHostname()) {
		t.Fatalf("expected wildcard hostname in rendered gateway manifest, got %s", publicEdgeRendered)
	}
	if !strings.Contains(string(publicEdgeRendered), cfg.DNS.APIHostname) {
		t.Fatalf("expected API hostname in rendered gateway manifest, got %s", publicEdgeRendered)
	}
}

func TestSyncRenderedGitOpsSourceCopiesBundleToClusterDirectory(t *testing.T) {
	t.Parallel()

	cfg := workflowTestConfig(3)
	sourceRoot := t.TempDir()

	templatePath := filepath.Join(sourceRoot, "core", "cert-manager-issuer", "clusterissuer.yaml.tmpl")
	if err := os.MkdirAll(filepath.Dir(templatePath), 0o755); err != nil {
		t.Fatalf("mkdir template: %v", err)
	}
	if err := os.WriteFile(templatePath, []byte("email: {{ .ACMEEmail }}\n"), 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, "apps"), 0o755); err != nil {
		t.Fatalf("mkdir apps: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "apps", "kustomization.yaml"), []byte("resources: []\n"), 0o644); err != nil {
		t.Fatalf("write apps kustomization: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "apps", "README.md"), []byte("bundled app docs\n"), 0o644); err != nil {
		t.Fatalf("write apps readme: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "kustomization.yaml"), []byte("resources:\n  - core\n  - apps\n"), 0o644); err != nil {
		t.Fatalf("write root kustomization: %v", err)
	}

	renderedRoot, cleanup, err := renderGitOpsSource(sourceRoot, cfg)
	if err != nil {
		t.Fatalf("render gitops source: %v", err)
	}
	defer cleanup()

	targetRoot := filepath.Join(t.TempDir(), "gitops")
	if err := os.MkdirAll(filepath.Join(targetRoot, "apps"), 0o755); err != nil {
		t.Fatalf("mkdir target apps: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(targetRoot, "core"), 0o755); err != nil {
		t.Fatalf("mkdir target core: %v", err)
	}
	if err := os.WriteFile(filepath.Join(targetRoot, "core", "stale.yaml"), []byte("stale\n"), 0o644); err != nil {
		t.Fatalf("write stale core file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(targetRoot, "apps", "custom.yaml"), []byte("kind: ConfigMap\n"), 0o644); err != nil {
		t.Fatalf("write custom app: %v", err)
	}
	if err := os.WriteFile(filepath.Join(targetRoot, "apps", "kustomization.yaml"), []byte("resources:\n  - custom.yaml\n"), 0o644); err != nil {
		t.Fatalf("write custom app kustomization: %v", err)
	}

	if err := syncRenderedGitOpsSource(renderedRoot, targetRoot); err != nil {
		t.Fatalf("sync rendered gitops source: %v", err)
	}

	renderedClusterIssuer := filepath.Join(targetRoot, "core", "cert-manager-issuer", "clusterissuer.yaml")
	rendered, err := os.ReadFile(renderedClusterIssuer)
	if err != nil {
		t.Fatalf("read rendered cluster issuer: %v", err)
	}
	if !strings.Contains(string(rendered), cfg.Cluster.ACMEEmail) {
		t.Fatalf("expected rendered cluster issuer in target, got %s", rendered)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "core", "stale.yaml")); !os.IsNotExist(err) {
		t.Fatalf("expected stale managed core file to be removed, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "core", "cert-manager-issuer", "clusterissuer.yaml.tmpl")); !os.IsNotExist(err) {
		t.Fatalf("expected template source to stay out of cluster gitops dir, err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "apps", "custom.yaml")); err != nil {
		t.Fatalf("expected custom app file to be preserved: %v", err)
	}
	customKustomization, err := os.ReadFile(filepath.Join(targetRoot, "apps", "kustomization.yaml"))
	if err != nil {
		t.Fatalf("read custom app kustomization: %v", err)
	}
	if !strings.Contains(string(customKustomization), "custom.yaml") {
		t.Fatalf("expected custom app kustomization to be preserved, got %s", customKustomization)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "apps", "README.md")); err != nil {
		t.Fatalf("expected missing bundled apps README to be copied: %v", err)
	}
}

func TestSyncRenderedGitOpsSourceCreatesMissingTargetDirectory(t *testing.T) {
	t.Parallel()

	sourceRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(sourceRoot, "core"), 0o755); err != nil {
		t.Fatalf("mkdir source core: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "core", "namespace.yaml"), []byte("kind: Namespace\n"), 0o644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	targetRoot := filepath.Join(t.TempDir(), "cluster", "gitops")
	if err := syncRenderedGitOpsSource(sourceRoot, targetRoot); err != nil {
		t.Fatalf("sync rendered gitops source: %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "core", "namespace.yaml")); err != nil {
		t.Fatalf("expected source file to be copied into missing target directory: %v", err)
	}
}
