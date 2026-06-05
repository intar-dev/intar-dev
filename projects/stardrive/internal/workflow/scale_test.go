package workflow

import (
	"strings"
	"testing"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"gopkg.in/yaml.v3"
)

func TestScaledConfigPreservesExistingAndAddsNewNodes(t *testing.T) {
	current := workflowTestConfig(3)

	scaled, removed, added, err := scaledConfig(current, 5)
	if err != nil {
		t.Fatalf("scale up: %v", err)
	}
	if len(removed) != 0 {
		t.Fatalf("expected no removed nodes, got %d", len(removed))
	}
	if len(added) != 2 {
		t.Fatalf("expected 2 added nodes, got %d", len(added))
	}
	if len(scaled.Nodes) != 5 {
		t.Fatalf("expected 5 nodes, got %d", len(scaled.Nodes))
	}
	for i := 0; i < 3; i++ {
		if scaled.Nodes[i].Name != current.Nodes[i].Name {
			t.Fatalf("existing node %d name changed from %q to %q", i, current.Nodes[i].Name, scaled.Nodes[i].Name)
		}
		if scaled.Nodes[i].PrivateIPv4 != current.Nodes[i].PrivateIPv4 {
			t.Fatalf("existing node %d private IP changed from %q to %q", i, current.Nodes[i].PrivateIPv4, scaled.Nodes[i].PrivateIPv4)
		}
	}
	seenIPs := map[string]struct{}{}
	for _, node := range scaled.Nodes {
		if _, ok := seenIPs[node.PrivateIPv4]; ok {
			t.Fatalf("duplicate private IP %q in scaled config", node.PrivateIPv4)
		}
		seenIPs[node.PrivateIPv4] = struct{}{}
	}
}

func TestScaledConfigRemovesTrailingNodes(t *testing.T) {
	current := workflowTestConfig(5)

	scaled, removed, added, err := scaledConfig(current, 3)
	if err != nil {
		t.Fatalf("scale down: %v", err)
	}
	if len(added) != 0 {
		t.Fatalf("expected no added nodes, got %d", len(added))
	}
	if len(removed) != 2 {
		t.Fatalf("expected 2 removed nodes, got %d", len(removed))
	}
	if len(scaled.Nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(scaled.Nodes))
	}
	if removed[0].Name != current.Nodes[3].Name || removed[1].Name != current.Nodes[4].Name {
		t.Fatalf("unexpected removed nodes: %#v", removed)
	}
}

func TestInjectBootstrapManifestsAddsProviderAndSMBManifests(t *testing.T) {
	cfg := workflowTestConfig(3)

	base := []byte(`machine:
  install:
    disk: /dev/sda
    image: ghcr.io/siderolabs/installer:v1.12.6
`)

	rendered, err := injectBootstrapManifests(base, cfg, "ghcr.io/siderolabs/installer:v1.12.6")
	if err != nil {
		t.Fatalf("inject bootstrap manifests: %v", err)
	}

	var document map[string]any
	if err := yaml.Unmarshal(rendered, &document); err != nil {
		t.Fatalf("parse rendered config: %v", err)
	}

	cluster := document["cluster"].(map[string]any)
	external := cluster["externalCloudProvider"].(map[string]any)
	if enabled, ok := external["enabled"].(bool); !ok || !enabled {
		t.Fatalf("expected externalCloudProvider.enabled=true, got %#v", external["enabled"])
	}
	manifestsList := external["manifests"].([]any)
	if len(manifestsList) != 1 || manifestsList[0].(string) != hetznerCCMManifestURL() {
		t.Fatalf("unexpected external cloud provider manifests: %#v", manifestsList)
	}

	machine := document["machine"].(map[string]any)
	install := machine["install"].(map[string]any)
	if install["image"] != "ghcr.io/siderolabs/installer:v1.12.6" {
		t.Fatalf("expected install.image to be preserved, got %#v", install["image"])
	}
	if install["disk"] != "/dev/sda" {
		t.Fatalf("expected install disk to be preserved, got %#v", install["disk"])
	}
}

func TestRenderInlineManifestBundleJoinsDocuments(t *testing.T) {
	bundle := renderInlineManifestBundle([]inlineManifest{
		{Name: "one", Contents: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: one"},
		{Name: "two", Contents: "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: two"},
	})
	output := string(bundle)
	if !strings.Contains(output, "name: one") || !strings.Contains(output, "name: two") {
		t.Fatalf("unexpected manifest bundle: %s", output)
	}
	if strings.Count(output, "---") != 1 {
		t.Fatalf("expected one document separator, got %d in: %s", strings.Count(output, "---"), output)
	}
}

func TestBootstrapInlineManifestsUseRootSMBShareAndRegistrySubdirectory(t *testing.T) {
	cfg := workflowTestConfig(3)
	storage := storageBoxSecrets{
		Username:  "u12345",
		Password:  "Sd1!test-password",
		SMBSource: "//u12345.your-storagebox.de/backup",
	}
	infra := infraSecrets{
		Hetzner: hetzner.Credentials{Token: "hcloud-token"},
	}
	runtime := runtimeSecrets{
		NetworkID:          77,
		RegistryCACertPEM:  "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
		RegistryTLSCertPEM: "-----BEGIN CERTIFICATE-----\nTLS\n-----END CERTIFICATE-----\n",
		RegistryTLSKeyPEM:  "-----BEGIN EC PRIVATE KEY-----\nKEY\n-----END EC PRIVATE KEY-----\n",
	}

	app := &App{}
	manifests, err := app.bootstrapInlineManifests(cfg, storage, infra, runtime)
	if err != nil {
		t.Fatalf("bootstrapInlineManifests: %v", err)
	}
	if len(manifests) != 4 {
		t.Fatalf("expected 4 manifests, got %d", len(manifests))
	}

	storageManifest := manifests[2].Contents
	if !strings.Contains(storageManifest, "source: //u12345.your-storagebox.de/backup") {
		t.Fatalf("expected root SMB share in storage manifest: %s", storageManifest)
	}
	if strings.Contains(storageManifest, "/stardrive/test/registry") {
		t.Fatalf("storage manifest should not hardcode nested registry path: %s", storageManifest)
	}

	registryManifest := manifests[3].Contents
	if !strings.Contains(registryManifest, "REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY") {
		t.Fatalf("expected registry root directory env var: %s", registryManifest)
	}
	if !strings.Contains(registryManifest, "/var/lib/registry/stardrive/test/registry") {
		t.Fatalf("expected nested registry directory in manifest: %s", registryManifest)
	}
	if !strings.Contains(registryManifest, "runAsNonRoot: true") {
		t.Fatalf("expected restricted pod security context in registry manifest: %s", registryManifest)
	}
	if !strings.Contains(registryManifest, "allowPrivilegeEscalation: false") {
		t.Fatalf("expected container privilege escalation to be disabled: %s", registryManifest)
	}
	if !strings.Contains(registryManifest, "drop:") || !strings.Contains(registryManifest, "- ALL") {
		t.Fatalf("expected all container capabilities to be dropped: %s", registryManifest)
	}
	if !strings.Contains(registryManifest, "REGISTRY_HTTP_TLS_CERTIFICATE") || !strings.Contains(registryManifest, "scheme: HTTPS") {
		t.Fatalf("expected registry TLS configuration in manifest: %s", registryManifest)
	}

	providerSecretManifest := manifests[0].Contents
	if !strings.Contains(providerSecretManifest, `network: "77"`) {
		t.Fatalf("expected network id to be rendered as a string in provider secret: %s", providerSecretManifest)
	}
}

func TestHetznerLabelValueLimitsLength(t *testing.T) {
	value := strings.Repeat("a", 64)
	got := hetznerLabelValue(value)
	if len(got) > 63 {
		t.Fatalf("expected label value to be at most 63 chars, got %d", len(got))
	}
	if got == value {
		t.Fatalf("expected long label value to be normalized")
	}
}

func workflowTestConfig(count int) *config.Config {
	cfg := &config.Config{
		Cluster: config.ClusterConfig{
			Name:               "test",
			NodeCount:          count,
			TalosVersion:       "v1.12.6",
			KubernetesVersion:  "1.34.2",
			ACMEEmail:          "platform@example.com",
			ControlPlaneTaints: false,
		},
		DNS: config.DNSConfig{
			Provider:    "cloudflare",
			Zone:        "example.com",
			APIHostname: "api.example.com",
		},
		Hetzner: config.HetznerConfig{
			ServerType:         "cpx21",
			Location:           "fsn1",
			NetworkZone:        "eu-central",
			PrivateNetworkCIDR: config.DefaultPrivateNetworkCIDR,
		},
		Storage: config.StorageConfig{
			StorageBoxPlan:     "BX11",
			StorageBoxLocation: "fsn1",
		},
		Infisical: config.InfisicalConfig{
			SiteURL:     "https://eu.infisical.com",
			ProjectID:   "project-id",
			ProjectSlug: "project-slug",
			Environment: "prod",
			PathRoot:    "/stardrive",
		},
		Nodes: desiredNodes(count, config.DefaultPrivateNetworkCIDR),
	}
	cfg.ApplyDefaults()
	return cfg
}
