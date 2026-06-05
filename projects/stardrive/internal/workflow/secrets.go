package workflow

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/fs"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"github.com/intar-dev/stardrive/internal/infisical"
	"github.com/intar-dev/stardrive/internal/names"
)

const (
	secretHetznerToken         = "HCLOUD_TOKEN"
	secretCloudflareAPIToken   = "CLOUDFLARE_API_TOKEN"
	secretCloudflareAccountID  = "CLOUDFLARE_ACCOUNT_ID"
	secretCloudflareTunnelName = "CLOUDFLARE_TUNNEL_NAME"

	secretStorageBoxID        = "STORAGE_BOX_ID"
	secretStorageBoxName      = "STORAGE_BOX_NAME"
	secretStorageBoxPlan      = "STORAGE_BOX_PLAN"
	secretStorageBoxLocation  = "STORAGE_BOX_LOCATION"
	secretStorageBoxUsername  = "STORAGE_BOX_USERNAME"
	secretStorageBoxPassword  = "STORAGE_BOX_PASSWORD"
	secretStorageBoxSMBSource = "STORAGE_BOX_SMB_SOURCE"

	secretHetznerNetworkID        = "HETZNER_NETWORK_ID"
	secretHetznerPlacementGroupID = "HETZNER_PLACEMENT_GROUP_ID"
	secretHetznerFirewallID       = "HETZNER_FIREWALL_ID"
	secretTalosBootImageID        = "TALOS_BOOT_IMAGE_ID"
	secretTalosBootImageURL       = "TALOS_BOOT_IMAGE_URL"
	secretTalosInstallerImage     = "TALOS_INSTALLER_IMAGE"
	secretTalosInstallerImageRef  = "TALOS_INSTALLER_IMAGE_REF"
	secretRegistryAddress         = "REGISTRY_ADDRESS"
	secretRegistryRepository      = "REGISTRY_REPOSITORY"
	secretGitOpsArtifactTag       = "GITOPS_ARTIFACT_TAG"
	secretRegistryCACertPEM       = "REGISTRY_CA_CERT_PEM"
	secretRegistryTLSCertPEM      = "REGISTRY_TLS_CERT_PEM"
	secretRegistryTLSKeyPEM       = "REGISTRY_TLS_KEY_PEM"
	secretSMBManifestJSON         = "SMB_BOOTSTRAP_MANIFESTS_JSON"

	secretTalosSecretsYAML      = "TALOS_SECRETS_YAML"
	secretTalosControlPlaneYAML = "TALOS_CONTROL_PLANE_CONFIG_YAML"
	secretTalosWorkerYAML       = "TALOS_WORKER_CONFIG_YAML"
	secretTalosconfigYAML       = "TALOSCONFIG_YAML"
	secretKubeconfigYAML        = "KUBECONFIG_YAML"
)

type infraSecrets struct {
	Hetzner              hetzner.Credentials
	CloudflareToken      string
	CloudflareAccountID  string
	CloudflareTunnelName string
}

type storageBoxSecrets struct {
	ID        int64
	Name      string
	Plan      string
	Location  string
	Username  string
	Password  string
	SMBSource string
}

type runtimeSecrets struct {
	NetworkID          int64
	PlacementGroupID   int64
	FirewallID         int64
	BootImageID        int64
	BootImageURL       string
	InstallerImage     string
	RegistryAddress    string
	Repository         string
	GitOpsArtifactTag  string
	RegistryCACertPEM  string
	RegistryTLSCertPEM string
	RegistryTLSKeyPEM  string
}

func (a *App) infisicalClient(ctx context.Context, cfg *config.Config) (*infisical.Client, error) {
	if cfg == nil {
		return nil, fmt.Errorf("config is required")
	}

	clientID := strings.TrimSpace(cfg.Infisical.ClientID)
	if clientID == "" {
		clientID = strings.TrimSpace(os.Getenv(config.EnvInfisicalClientID))
	}
	clientSecret := strings.TrimSpace(cfg.Infisical.ClientSecret)
	if clientSecret == "" {
		clientSecret = strings.TrimSpace(os.Getenv(config.EnvInfisicalClientSecret))
	}

	return infisical.NewClient(ctx, cfg.Infisical.SiteURL, clientID, clientSecret)
}

func (a *App) loadInfraSecrets(ctx context.Context, cfg *config.Config) (infraSecrets, error) {
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return infraSecrets{}, err
	}

	values, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().OperatorShared)
	if err != nil {
		return infraSecrets{}, err
	}

	infra := infraSecretsFromValues(values)
	if infra.Hetzner.Token == "" {
		return infraSecrets{}, fmt.Errorf("Hetzner token is missing from Infisical path %s", cfg.Secrets().OperatorShared)
	}
	return infra, nil
}

func infraSecretsFromValues(values map[string]string) infraSecrets {
	return infraSecrets{
		Hetzner: hetzner.Credentials{
			Token: defaultSecret(values[secretHetznerToken], os.Getenv(secretHetznerToken)),
		},
		CloudflareToken:      defaultSecret(values[secretCloudflareAPIToken], os.Getenv(secretCloudflareAPIToken)),
		CloudflareAccountID:  defaultSecret(values[secretCloudflareAccountID], os.Getenv(secretCloudflareAccountID)),
		CloudflareTunnelName: defaultSecret(values[secretCloudflareTunnelName], os.Getenv(secretCloudflareTunnelName)),
	}
}

func (a *App) loadStorageBoxSecrets(ctx context.Context, cfg *config.Config) (storageBoxSecrets, error) {
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return storageBoxSecrets{}, err
	}

	values, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterBootstrap)
	if err != nil {
		return storageBoxSecrets{}, err
	}

	parsedID, _ := parseInt64(values[secretStorageBoxID])
	secrets := storageBoxSecrets{
		ID:        parsedID,
		Name:      values[secretStorageBoxName],
		Plan:      values[secretStorageBoxPlan],
		Location:  values[secretStorageBoxLocation],
		Username:  values[secretStorageBoxUsername],
		Password:  values[secretStorageBoxPassword],
		SMBSource: values[secretStorageBoxSMBSource],
	}
	if secrets.ID <= 0 || secrets.Username == "" || secrets.Password == "" || secrets.SMBSource == "" {
		return storageBoxSecrets{}, fmt.Errorf("storage box secrets are missing from Infisical path %s", cfg.Secrets().ClusterBootstrap)
	}
	return secrets, nil
}

func (a *App) loadRuntimeSecrets(ctx context.Context, cfg *config.Config) (runtimeSecrets, error) {
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return runtimeSecrets{}, err
	}

	values, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime)
	if err != nil {
		return runtimeSecrets{}, err
	}

	networkID, _ := parseInt64(values[secretHetznerNetworkID])
	placementGroupID, _ := parseInt64(values[secretHetznerPlacementGroupID])
	firewallID, _ := parseInt64(values[secretHetznerFirewallID])
	bootImageID, _ := parseInt64(values[secretTalosBootImageID])
	return runtimeSecrets{
		NetworkID:          networkID,
		PlacementGroupID:   placementGroupID,
		FirewallID:         firewallID,
		BootImageID:        bootImageID,
		BootImageURL:       values[secretTalosBootImageURL],
		InstallerImage:     firstNonEmpty(values[secretTalosInstallerImage], values[secretTalosInstallerImageRef]),
		RegistryAddress:    values[secretRegistryAddress],
		Repository:         values[secretRegistryRepository],
		GitOpsArtifactTag:  values[secretGitOpsArtifactTag],
		RegistryCACertPEM:  values[secretRegistryCACertPEM],
		RegistryTLSCertPEM: values[secretRegistryTLSCertPEM],
		RegistryTLSKeyPEM:  values[secretRegistryTLSKeyPEM],
	}, nil
}

func (a *App) saveConfig(cfgPath string, cfg *config.Config) error {
	if cfg == nil {
		return fmt.Errorf("config is required")
	}

	copy := *cfg
	copy.Infisical.ClientID = ""
	copy.Infisical.ClientSecret = ""
	return config.Save(cfgPath, &copy)
}

func (a *App) clusterStateDir(cluster string) string {
	return filepath.Join(a.opts.Paths.StateDir, "clusters", names.Slugify(cluster))
}

func (a *App) writeLocalStateFile(cluster, name string, data []byte, mode os.FileMode) error {
	return fs.WriteFileAtomic(filepath.Join(a.clusterStateDir(cluster), name), data, mode)
}

func defaultSecret(primary, fallback string) string {
	primary = strings.TrimSpace(primary)
	if primary != "" {
		return primary
	}
	return strings.TrimSpace(fallback)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			return value
		}
	}
	return ""
}

func parseInt64(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, nil
	}
	var parsed int64
	err := json.Unmarshal([]byte(value), &parsed)
	if err == nil {
		return parsed, nil
	}
	return strconv.ParseInt(value, 10, 64)
}
