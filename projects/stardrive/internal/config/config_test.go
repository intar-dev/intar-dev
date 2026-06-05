package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecretPaths(t *testing.T) {
	cfg := &Config{
		Cluster: ClusterConfig{Name: "Production"},
		Infisical: InfisicalConfig{
			PathRoot: "/stardrive",
		},
	}

	paths := cfg.Secrets()
	if paths.OperatorShared != "/stardrive/operator/shared" {
		t.Fatalf("unexpected operator path: %s", paths.OperatorShared)
	}
	if paths.ClusterBootstrap != "/stardrive/clusters/production/bootstrap" {
		t.Fatalf("unexpected bootstrap path: %s", paths.ClusterBootstrap)
	}
	if paths.ClusterAccess != "/stardrive/clusters/production/access" {
		t.Fatalf("unexpected access path: %s", paths.ClusterAccess)
	}
	if paths.ClusterRuntime != "/stardrive/clusters/production/runtime" {
		t.Fatalf("unexpected runtime path: %s", paths.ClusterRuntime)
	}
}

func TestValidateRequiresOddHetznerControlPlanes(t *testing.T) {
	cfg := &Config{
		Cluster: ClusterConfig{
			Name:              "prod",
			NodeCount:         3,
			TalosVersion:      "v1.12.6",
			KubernetesVersion: "1.35.3",
			ACMEEmail:         "platform@example.com",
		},
		Nodes: []NodeConfig{
			{Name: "cp-1", ServerID: 1, Role: RoleControlPlane, PrivateIPv4: "10.42.0.10"},
			{Name: "cp-2", ServerID: 2, Role: RoleControlPlane, PrivateIPv4: "10.42.0.11"},
		},
		DNS: DNSConfig{
			Provider:    "cloudflare",
			Zone:        "example.com",
			APIHostname: "api.example.com",
		},
		Hetzner: HetznerConfig{
			ServerType:         "cax11",
			Location:           "fsn1",
			PrivateNetworkCIDR: DefaultPrivateNetworkCIDR,
		},
		Storage: StorageConfig{
			StorageBoxPlan:     "BX11",
			StorageBoxLocation: "fsn1",
		},
		Infisical: InfisicalConfig{
			SiteURL:     "https://eu.infisical.com",
			ProjectID:   "project-id",
			ProjectSlug: "project-slug",
			Environment: "prod",
			PathRoot:    "/stardrive",
		},
	}

	if err := cfg.Validate(); err == nil {
		t.Fatalf("expected validation error")
	}

	cfg.Nodes = append(cfg.Nodes, NodeConfig{Name: "cp-3", ServerID: 3, Role: RoleControlPlane, PrivateIPv4: "10.42.0.12"})
	if err := cfg.Validate(); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestApplyDefaultsReadsEnv(t *testing.T) {
	t.Setenv(EnvInfisicalSiteURL, "https://eu.infisical.com")
	t.Setenv(EnvInfisicalProjectID, "project-id")
	t.Setenv(EnvInfisicalProjectSlug, "project-slug")
	t.Setenv(EnvInfisicalEnvironment, "prod")
	t.Setenv(EnvInfisicalPathRoot, "/from-env")
	t.Setenv(EnvInfisicalClientID, "client-id")
	t.Setenv(EnvInfisicalClientSecret, "client-secret")
	t.Setenv(EnvCloudflareZone, "example.com")
	t.Setenv(EnvCloudflareAPIHostname, "api.example.com")
	t.Setenv(EnvCloudflareNodeRecords, "true")
	t.Setenv(EnvACMEEmail, "platform@example.com")
	t.Setenv(EnvHCloudServerType, "cpx21")
	t.Setenv(EnvHCloudLocation, "fsn1")
	t.Setenv(EnvHCloudPrivateNetCIDR, "10.99.0.0/24")
	t.Setenv(EnvStorageBoxPlan, "BX11")
	t.Setenv(EnvStorageBoxLocation, "nbg1")

	cfg := &Config{}
	cfg.ApplyDefaults()

	if cfg.Infisical.SiteURL != "https://eu.infisical.com" {
		t.Fatalf("unexpected SiteURL: %q", cfg.Infisical.SiteURL)
	}
	if cfg.Infisical.ProjectID != "project-id" {
		t.Fatalf("unexpected ProjectID: %q", cfg.Infisical.ProjectID)
	}
	if cfg.Infisical.ProjectSlug != "project-slug" {
		t.Fatalf("unexpected ProjectSlug: %q", cfg.Infisical.ProjectSlug)
	}
	if cfg.Infisical.Environment != "prod" {
		t.Fatalf("unexpected Environment: %q", cfg.Infisical.Environment)
	}
	if cfg.Infisical.PathRoot != "/from-env" {
		t.Fatalf("unexpected PathRoot: %q", cfg.Infisical.PathRoot)
	}
	if cfg.Infisical.ClientID != "client-id" {
		t.Fatalf("unexpected ClientID: %q", cfg.Infisical.ClientID)
	}
	if cfg.Infisical.ClientSecret != "client-secret" {
		t.Fatalf("unexpected ClientSecret: %q", cfg.Infisical.ClientSecret)
	}
	if cfg.DNS.Zone != "example.com" {
		t.Fatalf("unexpected DNS zone: %q", cfg.DNS.Zone)
	}
	if cfg.Cluster.ACMEEmail != "platform@example.com" {
		t.Fatalf("unexpected ACME email: %q", cfg.Cluster.ACMEEmail)
	}
	if cfg.DNS.APIHostname != "api.example.com" {
		t.Fatalf("unexpected DNS API hostname: %q", cfg.DNS.APIHostname)
	}
	if !cfg.DNS.ManageNodeRecords {
		t.Fatalf("expected ManageNodeRecords to be true")
	}
	if !cfg.DNS.ManageNodeRecordsSet {
		t.Fatalf("expected ManageNodeRecordsSet to be true")
	}
	if cfg.Hetzner.ServerType != "cpx21" {
		t.Fatalf("unexpected Hetzner server type: %q", cfg.Hetzner.ServerType)
	}
	if cfg.Hetzner.Location != "fsn1" {
		t.Fatalf("unexpected Hetzner location: %q", cfg.Hetzner.Location)
	}
	if cfg.Hetzner.PrivateNetworkCIDR != "10.99.0.0/24" {
		t.Fatalf("unexpected default network CIDR: %q", cfg.Hetzner.PrivateNetworkCIDR)
	}
	if cfg.Storage.StorageBoxPlan != "BX11" {
		t.Fatalf("unexpected storage box plan: %q", cfg.Storage.StorageBoxPlan)
	}
	if cfg.Storage.StorageBoxLocation != "nbg1" {
		t.Fatalf("unexpected storage box location: %q", cfg.Storage.StorageBoxLocation)
	}
	if cfg.Storage.StorageClassName != DefaultStorageClassName {
		t.Fatalf("unexpected default storage class: %q", cfg.Storage.StorageClassName)
	}
}

func TestLoadPreservesExplicitFalseManageNodeRecords(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cluster.yaml")
	data := []byte(`
cluster:
  name: prod
  nodeCount: 3
  talosVersion: v1.12.6
  kubernetesVersion: 1.35.3
  acmeEmail: platform@example.com
nodes:
  - name: cp-1
    serverId: 1
    role: control-plane
    privateIPv4: 10.42.0.10
  - name: cp-2
    serverId: 2
    role: control-plane
    privateIPv4: 10.42.0.11
  - name: cp-3
    serverId: 3
    role: control-plane
    privateIPv4: 10.42.0.12
dns:
  provider: cloudflare
  zone: example.com
  apiHostname: api.example.com
  manageNodeRecords: false
hetzner:
  serverType: cax11
  location: fsn1
  privateNetworkCIDR: 10.42.0.0/24
storage:
  storageBoxPlan: BX11
  storageBoxLocation: fsn1
infisical:
  siteUrl: https://eu.infisical.com
  projectId: project-id
  projectSlug: project-slug
  environment: prod
  pathRoot: /stardrive
`)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.DNS.ManageNodeRecords {
		t.Fatalf("expected ManageNodeRecords to remain false")
	}
	if !cfg.DNS.ManageNodeRecordsSet {
		t.Fatalf("expected ManageNodeRecordsSet to be true")
	}
}

func TestLoadPartialAllowsBootstrapDraft(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cluster.yaml")
	data := []byte(`
cluster:
  name: intar
  acmeEmail: platform@example.com
infisical:
  siteUrl: https://eu.infisical.com
  projectId: project-id
  projectSlug: project-slug
  environment: prod
  pathRoot: /stardrive
`)
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cfg, err := LoadPartial(path)
	if err != nil {
		t.Fatalf("LoadPartial returned error: %v", err)
	}
	if cfg.Cluster.Name != "intar" {
		t.Fatalf("unexpected cluster name: %q", cfg.Cluster.Name)
	}
	if cfg.Cluster.NodeCount != 3 {
		t.Fatalf("expected default node count 3, got %d", cfg.Cluster.NodeCount)
	}

	if _, err := Load(path); err == nil {
		t.Fatalf("expected Load to fail for incomplete bootstrap draft")
	}
}

func TestAppWildcardHostnameUsesZoneName(t *testing.T) {
	cfg := &Config{
		DNS: DNSConfig{
			Zone:        "intar.app",
			APIHostname: "api.intar.app",
		},
	}

	if got := cfg.AppWildcardHostname(); got != "*.intar.app" {
		t.Fatalf("unexpected wildcard hostname: %q", got)
	}
}

func TestAppWildcardHostnameFallsBackToAPIHostnameWhenZoneIsID(t *testing.T) {
	cfg := &Config{
		DNS: DNSConfig{
			Zone:        "cd5aa63e949cca2558dc73daa657759e",
			APIHostname: "api.intar.app",
		},
	}

	if got := cfg.AppWildcardHostname(); got != "*.intar.app" {
		t.Fatalf("unexpected wildcard hostname: %q", got)
	}
}

func TestEffectiveRegistryAddress(t *testing.T) {
	cfg := &Config{
		Storage: StorageConfig{
			RegistryNamespace: "Registry-System",
			RegistryName:      "OCI Registry",
			RegistryPort:      5001,
		},
	}
	cfg.ApplyDefaults()

	if got := cfg.EffectiveRegistryAddress(); got != "oci-registry.registry-system.svc.cluster.local:5001" {
		t.Fatalf("unexpected registry address: %s", got)
	}
}
