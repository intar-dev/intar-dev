package workflow

import (
	"context"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"github.com/intar-dev/stardrive/internal/infisical"
	"github.com/intar-dev/stardrive/internal/operation"
	"github.com/intar-dev/stardrive/internal/prompts"
	"github.com/intar-dev/stardrive/internal/talos"
	"golang.org/x/sync/errgroup"
)

var bootstrapPhases = []string{
	"load-config",
	"prompt-missing",
	"seed-infisical",
	"preflight-capacity",
	"ensure-storage-box",
	"build-image",
	"ensure-networking",
	"generate-talos-assets",
	"create-servers",
	"wait-secure",
	"bootstrap-etcd",
	"fetch-access",
	"install-cilium",
	"wait-registry",
	"install-flux",
	"publish-gitops",
	"reconcile-gitops",
	"bootstrap-secrets",
	"verify",
}

func (a *App) Bootstrap(ctx context.Context, req BootstrapRequest) error {
	clusterName := strings.TrimSpace(req.ClusterName)
	if clusterName == "" && strings.TrimSpace(req.ConfigPath) != "" {
		clusterName = strings.TrimSuffix(filepath.Base(req.ConfigPath), filepath.Ext(req.ConfigPath))
	}
	if clusterName == "" {
		clusterName = "cluster"
	}

	op, resumed, err := a.store.StartOrResume(clusterName, operation.TypeBootstrap, bootstrapPhases)
	if err != nil {
		return err
	}

	if resumed {
		a.Printf("Resuming bootstrap from phase %s\n", op.ResumePhase())
		a.logInfo("resuming bootstrap", "operation", op.ID, "cluster", clusterName, "phase", op.ResumePhase())
	} else {
		a.Printf("Created bootstrap operation %s\n", op.ID)
		a.logInfo("created bootstrap operation", "operation", op.ID, "cluster", clusterName)
	}

	var cfg *config.Config
	if err := a.runPhase(op, "load-config", func() (any, error) {
		var loadErr error
		cfg, loadErr = loadOrInitConfig(req.ConfigPath, clusterName)
		if loadErr != nil {
			return nil, loadErr
		}
		return map[string]string{"configPath": req.ConfigPath}, nil
	}); err != nil {
		return err
	}
	if cfg == nil {
		cfg, err = loadOrInitConfig(req.ConfigPath, clusterName)
		if err != nil {
			return err
		}
	}

	var infra infraSecrets
	var infClient *infisical.Client
	var hzClient *hetzner.Client
	if err := a.runPhase(op, "prompt-missing", func() (any, error) {
		var promptErr error
		infClient, infra, promptErr = a.promptBootstrapInputs(ctx, cfg, req.Edit)
		if promptErr != nil {
			return nil, promptErr
		}
		hzClient, promptErr = hetzner.NewClient(infra.Hetzner)
		if promptErr != nil {
			return nil, promptErr
		}
		if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
			return nil, err
		}
		return map[string]any{
			"configPath": req.ConfigPath,
			"nodeCount":  cfg.Cluster.NodeCount,
			"serverType": cfg.Hetzner.ServerType,
			"location":   cfg.Hetzner.Location,
		}, nil
	}); err != nil {
		return err
	}
	if infClient == nil {
		infClient, err = a.infisicalClient(ctx, cfg)
		if err != nil {
			return err
		}
	}
	if hzClient == nil {
		if infra.Hetzner.Token == "" {
			infra, err = a.loadInfraSecrets(ctx, cfg)
			if err != nil {
				return err
			}
		}
		hzClient, err = hetzner.NewClient(infra.Hetzner)
		if err != nil {
			return err
		}
	}

	if err := a.runPhase(op, "seed-infisical", func() (any, error) {
		paths := cfg.Secrets()
		if err := infClient.EnsureSecretPath(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.OperatorShared); err != nil {
			return nil, err
		}
		if err := infClient.EnsureSecretPath(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.ClusterBootstrap); err != nil {
			return nil, err
		}
		if err := infClient.EnsureSecretPath(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.ClusterAccess); err != nil {
			return nil, err
		}
		if err := infClient.EnsureSecretPath(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.ClusterRuntime); err != nil {
			return nil, err
		}
		if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.OperatorShared, map[string]string{
			secretHetznerToken:         infra.Hetzner.Token,
			secretCloudflareAPIToken:   infra.CloudflareToken,
			secretCloudflareAccountID:  infra.CloudflareAccountID,
			secretCloudflareTunnelName: infra.CloudflareTunnelName,
		}); err != nil {
			return nil, err
		}
		return nil, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "preflight-capacity", func() (any, error) {
		_, resolvedLocation, err := hzClient.ValidateServerTypeAtLocation(ctx, cfg.Hetzner.ServerType, cfg.Hetzner.Location)
		if err != nil {
			return nil, err
		}
		cfg.Hetzner.NetworkZone = resolvedLocation.NetworkZone
		if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
			return nil, err
		}
		return map[string]any{
			"location":    cfg.Hetzner.Location,
			"networkZone": cfg.Hetzner.NetworkZone,
		}, nil
	}); err != nil {
		return err
	}

	var box storageBoxSecrets
	if err := a.runPhase(op, "ensure-storage-box", func() (any, error) {
		var boxErr error
		box, boxErr = a.ensureStorageBox(ctx, cfg, hzClient, infClient)
		if boxErr != nil {
			return nil, boxErr
		}
		return map[string]any{
			"storageBoxID":       box.ID,
			"storageBoxPlan":     box.Plan,
			"storageBoxLocation": box.Location,
			"storageBoxName":     box.Name,
		}, nil
	}); err != nil {
		return err
	}
	if box.ID == 0 {
		box, err = a.loadStorageBoxSecrets(ctx, cfg)
		if err != nil {
			return err
		}
	}

	var runtime runtimeSecrets
	if err := a.runPhase(op, "build-image", func() (any, error) {
		built, buildErr := a.ensureHetznerTalosImage(ctx, cfg, hzClient, infClient, box)
		if buildErr != nil {
			return nil, buildErr
		}
		runtime = built
		return map[string]any{
			"imageId":      built.BootImageID,
			"imageURL":     built.BootImageURL,
			"installerRef": built.InstallerImage,
		}, nil
	}); err != nil {
		return err
	}
	if runtime.BootImageID == 0 {
		runtime, err = a.loadRuntimeSecrets(ctx, cfg)
		if err != nil {
			return err
		}
	}
	runtime, err = a.ensureRegistryTLSMaterial(ctx, cfg, infClient, runtime)
	if err != nil {
		return err
	}

	if err := a.runPhase(op, "ensure-networking", func() (any, error) {
		nextRuntime, netErr := a.ensureHetznerNetworking(ctx, cfg, hzClient, infClient)
		if netErr != nil {
			return nil, netErr
		}
		runtime.NetworkID = nextRuntime.NetworkID
		runtime.PlacementGroupID = nextRuntime.PlacementGroupID
		runtime.FirewallID = nextRuntime.FirewallID
		return map[string]any{
			"networkId":        runtime.NetworkID,
			"placementGroupId": runtime.PlacementGroupID,
			"firewallId":       runtime.FirewallID,
		}, nil
	}); err != nil {
		return err
	}

	var accessSecrets clusterAccessSecrets
	renderedConfigs := map[string][]byte{}
	if err := a.runPhase(op, "generate-talos-assets", func() (any, error) {
		accessSecrets, renderedConfigs, err = a.generateBootstrapTalosAssets(ctx, cfg, infClient, infra, box, runtime)
		if err != nil {
			return nil, err
		}
		return map[string]int{"renderedConfigs": len(renderedConfigs)}, nil
	}); err != nil {
		return err
	}
	accessSecrets, err = a.ensureClusterAccessSecrets(ctx, cfg, accessSecrets, false)
	if err != nil {
		return err
	}

	if err := a.runPhase(op, "create-servers", func() (any, error) {
		if err := a.ensureClusterServers(ctx, cfg, hzClient, infClient, runtime, renderedConfigs); err != nil {
			return nil, err
		}
		if strings.TrimSpace(infra.CloudflareToken) != "" {
			if err := syncClusterDNS(ctx, cfg, infra.CloudflareToken); err != nil {
				return nil, err
			}
			if err := syncClusterReverseDNS(ctx, cfg, hzClient); err != nil {
				return nil, err
			}
		}
		if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
			return nil, err
		}
		return map[string]int{"servers": len(cfg.Nodes)}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "wait-secure", func() (any, error) {
		group, groupCtx := errgroup.WithContext(ctx)
		group.SetLimit(parallelNodeLimit(len(cfg.Nodes)))
		for _, node := range cfg.Nodes {
			node := node
			group.Go(func() error {
				waitCtx, cancel := context.WithTimeout(groupCtx, 30*time.Minute)
				defer cancel()
				return a.waitForTalosSecure(waitCtx, node.PublicIPv4, accessSecrets.TalosconfigYAML)
			})
		}
		return nil, group.Wait()
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "bootstrap-etcd", func() (any, error) {
		first, err := a.firstReachableControlPlaneIP(ctx, cfg, accessSecrets.TalosconfigYAML)
		if err != nil {
			return nil, err
		}
		client, err := talos.NewClient(first, accessSecrets.TalosconfigYAML)
		if err != nil {
			return nil, err
		}
		defer client.Close()
		if err := client.Bootstrap(ctx); err != nil {
			return nil, err
		}
		return map[string]string{"endpoint": first}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "fetch-access", func() (any, error) {
		first, err := a.firstReachableControlPlaneIP(ctx, cfg, accessSecrets.TalosconfigYAML)
		if err != nil {
			return nil, err
		}
		kubeconfig, err := a.fetchKubeconfig(ctx, first, accessSecrets.TalosconfigYAML)
		if err != nil {
			return nil, err
		}
		accessSecrets.KubeconfigYAML = kubeconfig
		if err := a.persistKubeconfig(ctx, cfg, infClient, kubeconfig); err != nil {
			return nil, err
		}
		return map[string]bool{"kubeconfig": true}, nil
	}); err != nil {
		return err
	}
	accessSecrets, err = a.ensureClusterAccessSecrets(ctx, cfg, accessSecrets, true)
	if err != nil {
		return err
	}

	if err := a.runPhase(op, "install-cilium", func() (any, error) {
		kubeconfigPath, cleanup, err := a.writeTempKubeconfig(accessSecrets)
		if err != nil {
			return nil, err
		}
		defer cleanup()
		waitCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
		defer cancel()
		if err := a.waitForKubernetesAPI(waitCtx, cfg, kubeconfigPath); err != nil {
			return nil, err
		}
		if err := a.installCilium(ctx, cfg, kubeconfigPath); err != nil {
			return nil, err
		}
		return nil, a.waitForKubernetesNodes(ctx, cfg, kubeconfigPath)
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "wait-registry", func() (any, error) {
		kubeconfigPath, cleanup, err := a.writeTempKubeconfig(accessSecrets)
		if err != nil {
			return nil, err
		}
		defer cleanup()
		if err := a.waitForBootstrapRegistry(ctx, cfg, kubeconfigPath, box, infra, runtime); err != nil {
			return nil, err
		}
		return map[string]string{"registry": cfg.EffectiveRegistryAddress()}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "install-flux", func() (any, error) {
		kubeconfigPath, cleanup, err := a.writeTempKubeconfig(accessSecrets)
		if err != nil {
			return nil, err
		}
		defer cleanup()
		return nil, a.installFlux(ctx, cfg, kubeconfigPath)
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "publish-gitops", func() (any, error) {
		if err := a.GitOpsPublish(ctx, GitOpsPublishRequest{ConfigPath: req.ConfigPath}); err != nil {
			return nil, err
		}
		return nil, nil
	}); err != nil {
		return err
	}
	runtime, err = a.loadRuntimeSecrets(ctx, cfg)
	if err != nil {
		return err
	}

	if err := a.runPhase(op, "reconcile-gitops", func() (any, error) {
		kubeconfigPath, cleanup, err := a.writeTempKubeconfig(accessSecrets)
		if err != nil {
			return nil, err
		}
		defer cleanup()
		if err := a.applyFluxBootstrapOCI(ctx, cfg, kubeconfigPath, runtime); err != nil {
			return nil, err
		}
		return nil, a.waitForFluxBootstrapOCI(ctx, cfg, kubeconfigPath)
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "bootstrap-secrets", func() (any, error) {
		return nil, a.BootstrapSecrets(ctx, BootstrapSecretsRequest{ConfigPath: req.ConfigPath})
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "verify", func() (any, error) {
		if err := a.verifyTalosHealth(ctx, cfg, accessSecrets.TalosconfigYAML); err != nil {
			return nil, err
		}
		kubeconfigPath, cleanup, err := a.writeTempKubeconfig(accessSecrets)
		if err != nil {
			return nil, err
		}
		defer cleanup()
		if err := a.waitForDeferredFluxBootstrapOCI(ctx, cfg, kubeconfigPath); err != nil {
			return nil, err
		}
		if err := a.waitForKubernetesNodes(ctx, cfg, kubeconfigPath); err != nil {
			return nil, err
		}
		if err := a.waitForPublicEdge(ctx, cfg, kubeconfigPath); err != nil {
			return nil, err
		}
		return map[string]bool{"healthy": true}, nil
	}); err != nil {
		return err
	}

	a.Printf("Bootstrapped cluster %s\n", cfg.Cluster.Name)
	return nil
}

func loadOrInitConfig(path, clusterName string) (*config.Config, error) {
	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return config.LoadPartial(path)
	}

	cfg := &config.Config{
		Cluster: config.ClusterConfig{
			Name:               clusterName,
			NodeCount:          3,
			ControlPlaneTaints: false,
		},
	}
	cfg.ApplyDefaults()
	return cfg, nil
}

func (a *App) promptBootstrapInputs(ctx context.Context, cfg *config.Config, edit bool) (*infisical.Client, infraSecrets, error) {
	if cfg == nil {
		return nil, infraSecrets{}, fmt.Errorf("config is required")
	}

	var err error
	cfg.Infisical.SiteURL, err = promptStringIfNeeded(ctx, edit, cfg.Infisical.SiteURL, "Infisical site URL", "Example: https://eu.infisical.com")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.ProjectID, err = promptStringIfNeeded(ctx, edit, cfg.Infisical.ProjectID, "Infisical project ID", "Project UUID")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.ProjectSlug, err = promptStringIfNeeded(ctx, edit, cfg.Infisical.ProjectSlug, "Infisical project slug", "Human-friendly project slug")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.Environment, err = promptStringIfNeeded(ctx, edit, cfg.Infisical.Environment, "Infisical environment", "Example: prod")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.PathRoot, err = promptStringIfNeeded(ctx, edit, cfg.Infisical.PathRoot, "Infisical path root", "Example: /stardrive")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.ClientID, err = promptSecretIfNeeded(ctx, edit, cfg.Infisical.ClientID, "INFISICAL_CLIENT_ID", "Session-only Universal Auth client ID")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Infisical.ClientSecret, err = promptSecretIfNeeded(ctx, edit, cfg.Infisical.ClientSecret, "INFISICAL_CLIENT_SECRET", "Session-only Universal Auth client secret")
	if err != nil {
		return nil, infraSecrets{}, err
	}

	infClient, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return nil, infraSecrets{}, err
	}

	existing, _ := infClient.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().OperatorShared)
	infra := infraSecretsFromValues(existing)
	infra.Hetzner.Token, err = promptSecretIfNeeded(ctx, edit, infra.Hetzner.Token, "HCLOUD_TOKEN", "Hetzner Cloud project API token")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	infra.CloudflareToken, err = promptSecretIfNeeded(ctx, edit, infra.CloudflareToken, "Cloudflare API token", "Token with Zone read, DNS edit, and Cloudflare Tunnel edit permissions")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	infra.CloudflareAccountID, err = promptStringIfNeeded(ctx, edit, infra.CloudflareAccountID, "Cloudflare account ID", "Account that owns the tunnel and DNS zones")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	infra.CloudflareTunnelName, err = promptStringIfNeeded(ctx, edit, infra.CloudflareTunnelName, "Cloudflare Tunnel name", "Tunnel to create or reuse for public app ingress")
	if err != nil {
		return nil, infraSecrets{}, err
	}

	if err := a.resolveBootstrapVersionDefaults(ctx, cfg); err != nil {
		a.logWarn("failed to resolve latest supported Talos and Kubernetes versions automatically", "error", err)
	}

	talosNeedsSelection := edit || strings.TrimSpace(cfg.Cluster.TalosVersion) == ""
	kubernetesNeedsSelection := edit || strings.TrimSpace(cfg.Cluster.KubernetesVersion) == ""
	if talosNeedsSelection {
		cfg.Cluster.TalosVersion, err = a.selectTalosVersion(ctx, cfg.Cluster.TalosVersion)
		if err != nil {
			return nil, infraSecrets{}, err
		}
	}
	if kubernetesNeedsSelection || talosNeedsSelection {
		cfg.Cluster.KubernetesVersion, err = a.selectKubernetesVersion(ctx, cfg.Cluster.TalosVersion, cfg.Cluster.KubernetesVersion)
		if err != nil {
			return nil, infraSecrets{}, err
		}
	}

	hzClient, err := hetzner.NewClient(infra.Hetzner)
	if err != nil {
		return nil, infraSecrets{}, err
	}
	serverTypes, err := hzClient.ListServerTypes(ctx)
	if err != nil {
		return nil, infraSecrets{}, err
	}
	locations, err := hzClient.ListLocations(ctx)
	if err != nil {
		return nil, infraSecrets{}, err
	}

	cfg.Hetzner.Location, err = selectStringIfNeeded(ctx, edit, cfg.Hetzner.Location, "Hetzner location", "Choose the Hetzner Cloud location for the cluster nodes", locationChoiceValues(locations))
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Hetzner.ServerType, err = selectStringIfNeeded(ctx, edit, cfg.Hetzner.ServerType, "Hetzner server type", "Choose the Hetzner Cloud server type for all nodes", serverTypeChoicesForLocation(serverTypes, cfg.Hetzner.Location))
	if err != nil {
		return nil, infraSecrets{}, err
	}

	nodeCountValue := fmt.Sprintf("%d", maxInt(cfg.Cluster.NodeCount, 3))
	nodeCountValue, err = promptStringIfNeeded(ctx, edit, nodeCountValue, "Node count", "Odd number of schedulable control-plane nodes (3, 5, 7, ...)")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Cluster.NodeCount, err = parseOddNodeCount(nodeCountValue)
	if err != nil {
		return nil, infraSecrets{}, err
	}

	cfg.DNS.Zone, err = promptStringIfNeeded(ctx, edit, cfg.DNS.Zone, "Cloudflare zone", "Example: example.com")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.DNS.APIHostname, err = promptStringIfNeeded(ctx, edit, cfg.DNS.APIHostname, "Cluster API hostname", "Example: api.example.com")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Cluster.ACMEEmail, err = promptStringIfNeeded(ctx, edit, cfg.Cluster.ACMEEmail, "ACME email", "Contact email for Let's Encrypt and cert-manager")
	if err != nil {
		return nil, infraSecrets{}, err
	}
	if edit || !cfg.DNS.ManageNodeRecordsSet {
		cfg.DNS.ManageNodeRecords, err = prompts.Confirm(ctx, "Manage node DNS records?", "Create A records for individual node hostnames too.", cfg.DNS.ManageNodeRecords)
		if err != nil {
			return nil, infraSecrets{}, err
		}
		cfg.DNS.ManageNodeRecordsSet = true
	}

	cfg.Storage.StorageBoxPlan, err = selectStringIfNeeded(ctx, edit, cfg.Storage.StorageBoxPlan, "Storage Box plan", "Choose the Hetzner Storage Box plan", storageBoxPlanChoices())
	if err != nil {
		return nil, infraSecrets{}, err
	}
	cfg.Storage.StorageBoxLocation, err = selectStringIfNeeded(ctx, edit, cfg.Storage.StorageBoxLocation, "Storage Box location", "Choose the Hetzner Storage Box location", storageBoxLocationChoices())
	if err != nil {
		return nil, infraSecrets{}, err
	}

	cfg.Nodes = desiredNodes(cfg.Cluster.NodeCount, cfg.Hetzner.PrivateNetworkCIDR)
	for i := range cfg.Nodes {
		cfg.Nodes[i].Name, err = promptStringIfNeeded(ctx, edit, cfg.Nodes[i].Name, fmt.Sprintf("Node %d name", i+1), fmt.Sprintf("Name for private IP %s", cfg.Nodes[i].PrivateIPv4))
		if err != nil {
			return nil, infraSecrets{}, err
		}
	}

	_, err = prompts.Input(ctx, "Destructive confirmation", fmt.Sprintf("Type %s to confirm Stardrive may create and destroy Hetzner resources for this cluster.", cfg.Cluster.Name), "", func(v string) error {
		if strings.TrimSpace(v) != cfg.Cluster.Name {
			return fmt.Errorf("enter %s to continue", cfg.Cluster.Name)
		}
		return nil
	})
	if err != nil {
		return nil, infraSecrets{}, err
	}

	return infClient, infra, nil
}

func (a *App) selectTalosVersion(ctx context.Context, current string) (string, error) {
	resolver := talos.NewReleaseResolver()
	versions, err := resolver.StableTalosVersions(ctx, 8)
	if err != nil {
		return "", err
	}

	current = strings.TrimSpace(current)
	if current == "" && len(versions) > 0 {
		current = versions[0]
	}

	choices := make([]prompts.Choice[string], 0, len(versions))
	for index, version := range versions {
		label := version
		if index == 0 {
			label += " (latest stable)"
		}
		choices = append(choices, prompts.Choice[string]{Label: label, Value: version})
	}
	return prompts.Select(ctx, "Talos version", "Select the Talos release to install", choices, current)
}

func (a *App) selectKubernetesVersion(ctx context.Context, talosVersion, current string) (string, error) {
	resolver := talos.NewReleaseResolver()
	versions, err := resolver.SupportedKubernetesPatches(ctx, talosVersion)
	if err != nil {
		return "", err
	}

	current = strings.TrimSpace(strings.TrimPrefix(current, "v"))
	if current == "" && len(versions) > 0 {
		current = versions[0]
	}

	choices := make([]prompts.Choice[string], 0, len(versions))
	for index, version := range versions {
		label := version
		if index == 0 {
			label += fmt.Sprintf(" (latest supported by %s)", talosVersion)
		}
		choices = append(choices, prompts.Choice[string]{Label: label, Value: version})
	}
	return prompts.Select(ctx, "Kubernetes version", fmt.Sprintf("Select a Kubernetes version supported by Talos %s", talosVersion), choices, current)
}

func (a *App) resolveBootstrapVersionDefaults(ctx context.Context, cfg *config.Config) error {
	if cfg == nil {
		return fmt.Errorf("config is required")
	}
	if strings.TrimSpace(cfg.Cluster.TalosVersion) != "" && strings.TrimSpace(cfg.Cluster.KubernetesVersion) != "" {
		return nil
	}

	resolver := talos.NewReleaseResolver()
	talosVersion, kubernetesVersion, err := resolver.ResolveBootstrapVersions(ctx, cfg.Cluster.TalosVersion, cfg.Cluster.KubernetesVersion)
	if err != nil {
		return err
	}
	if strings.TrimSpace(cfg.Cluster.TalosVersion) == "" {
		cfg.Cluster.TalosVersion = talosVersion
	}
	if strings.TrimSpace(cfg.Cluster.KubernetesVersion) == "" {
		cfg.Cluster.KubernetesVersion = kubernetesVersion
	}
	return nil
}

func promptStringIfNeeded(ctx context.Context, edit bool, current, title, description string) (string, error) {
	if !edit && strings.TrimSpace(current) != "" {
		return strings.TrimSpace(current), nil
	}
	return prompts.Input(ctx, title, description, current, nonEmpty)
}

func promptSecretIfNeeded(ctx context.Context, edit bool, current, title, description string) (string, error) {
	if !edit && strings.TrimSpace(current) != "" {
		return strings.TrimSpace(current), nil
	}
	return prompts.Secret(ctx, title, description, current, nonEmpty)
}

func selectStringIfNeeded(ctx context.Context, edit bool, current, title, description string, choices []prompts.Choice[string]) (string, error) {
	if !edit && strings.TrimSpace(current) != "" {
		return strings.TrimSpace(current), nil
	}
	if len(choices) == 0 {
		return "", fmt.Errorf("%s has no choices", title)
	}
	initial := choices[0].Value
	for _, choice := range choices {
		if choice.Value == current {
			initial = current
			break
		}
	}
	return prompts.Select(ctx, title, description, choices, initial)
}

func nonEmpty(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("value is required")
	}
	return nil
}

func parseOddNodeCount(value string) (int, error) {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil {
		return 0, fmt.Errorf("parse node count: %w", err)
	}
	if parsed < 3 || parsed%2 == 0 {
		return 0, fmt.Errorf("node count must be an odd number >= 3")
	}
	return parsed, nil
}

func desiredNodes(count int, cidr string) []config.NodeConfig {
	nodes := make([]config.NodeConfig, 0, count)
	for i := 0; i < count; i++ {
		nodes = append(nodes, config.NodeConfig{
			Name:        fmt.Sprintf("control-plane-%02d", i+1),
			Role:        config.RoleControlPlane,
			PrivateIPv4: nthPrivateIPv4(cidr, i+10),
		})
	}
	return nodes
}

func nthPrivateIPv4(cidr string, hostOffset int) string {
	prefix, err := netip.ParsePrefix(strings.TrimSpace(cidr))
	if err != nil {
		return ""
	}
	addr := prefix.Addr()
	if !addr.Is4() {
		return ""
	}
	value := addr.As4()
	ip := netip.AddrFrom4([4]byte{value[0], value[1], value[2], byte(hostOffset)})
	return ip.String()
}

func locationChoiceValues(locations []hetzner.Location) []prompts.Choice[string] {
	choices := make([]prompts.Choice[string], 0, len(locations))
	for _, location := range locations {
		label := location.Name
		if location.Description != "" {
			label = fmt.Sprintf("%s (%s)", location.Name, location.Description)
		}
		choices = append(choices, prompts.Choice[string]{Label: label, Value: location.Name})
	}
	return choices
}

func serverTypeChoicesForLocation(serverTypes []hetzner.ServerType, location string) []prompts.Choice[string] {
	choices := make([]prompts.Choice[string], 0, len(serverTypes))
	for _, serverType := range serverTypes {
		if location != "" && !slices.Contains(serverType.AvailableAtLocations, location) {
			continue
		}
		label := fmt.Sprintf("%s (%d vCPU, %.0f GB RAM, %d GB disk)", serverType.Name, serverType.Cores, serverType.MemoryGB, serverType.DiskGB)
		choices = append(choices, prompts.Choice[string]{Label: label, Value: serverType.Name})
	}
	return choices
}

func storageBoxPlanChoices() []prompts.Choice[string] {
	return []prompts.Choice[string]{
		{Label: "BX11 (1 TB)", Value: "BX11"},
		{Label: "BX21 (5 TB)", Value: "BX21"},
		{Label: "BX31 (10 TB)", Value: "BX31"},
		{Label: "BX41 (20 TB)", Value: "BX41"},
	}
}

func storageBoxLocationChoices() []prompts.Choice[string] {
	return []prompts.Choice[string]{
		{Label: "fsn1 (Falkenstein)", Value: "fsn1"},
		{Label: "nbg1 (Nuremberg)", Value: "nbg1"},
		{Label: "hel1 (Helsinki)", Value: "hel1"},
	}
}

func maxInt(values ...int) int {
	max := 0
	for _, value := range values {
		if value > max {
			max = value
		}
	}
	return max
}

func (a *App) ensureStorageBox(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client, infClient *infisical.Client) (storageBoxSecrets, error) {
	boxName := clusterResourceName(cfg, "storage-box")
	if strings.TrimSpace(cfg.Hetzner.Location) != "" && strings.TrimSpace(cfg.Storage.StorageBoxLocation) != "" && !strings.EqualFold(strings.TrimSpace(cfg.Hetzner.Location), strings.TrimSpace(cfg.Storage.StorageBoxLocation)) {
		a.logWarn("cluster nodes and Storage Box use different Hetzner locations", "cluster_location", cfg.Hetzner.Location, "storage_box_location", cfg.Storage.StorageBoxLocation)
	}
	existing, _ := a.loadStorageBoxSecrets(ctx, cfg)
	if existing.ID > 0 && existing.Name == boxName {
		return existing, nil
	}

	boxes, err := hzClient.ListStorageBoxes(ctx)
	if err != nil {
		return storageBoxSecrets{}, err
	}
	for _, box := range boxes {
		if box.Name != boxName {
			continue
		}
		if strings.TrimSpace(existing.Password) == "" {
			ready, err := hzClient.WaitForStorageBoxReady(ctx, box.ID, 10*time.Minute)
			if err != nil {
				return storageBoxSecrets{}, err
			}
			existing.Password = generateStorageBoxPassword()
			if err := hzClient.ResetStorageBoxPassword(ctx, ready.ID, existing.Password); err != nil {
				return storageBoxSecrets{}, err
			}
			box = *ready
		}
		secrets := storageBoxSecrets{
			ID:        box.ID,
			Name:      box.Name,
			Plan:      cfg.Storage.StorageBoxPlan,
			Location:  box.Location,
			Username:  box.Username,
			Password:  existing.Password,
			SMBSource: hzClient.StorageBoxSMBSource(box.Username),
		}
		if err := hzClient.UpdateStorageBoxAccessSettings(ctx, secrets.ID, true); err != nil {
			return storageBoxSecrets{}, err
		}
		if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterBootstrap, map[string]string{
			secretStorageBoxID:        fmt.Sprintf("%d", secrets.ID),
			secretStorageBoxName:      secrets.Name,
			secretStorageBoxPlan:      cfg.Storage.StorageBoxPlan,
			secretStorageBoxLocation:  secrets.Location,
			secretStorageBoxUsername:  secrets.Username,
			secretStorageBoxPassword:  secrets.Password,
			secretStorageBoxSMBSource: secrets.SMBSource,
		}); err != nil {
			return storageBoxSecrets{}, err
		}
		return secrets, nil
	}

	password := generateStorageBoxPassword()
	created, err := hzClient.CreateStorageBox(ctx, boxName, cfg.Storage.StorageBoxPlan, cfg.Storage.StorageBoxLocation, password)
	if err != nil {
		return storageBoxSecrets{}, err
	}
	ready, err := hzClient.WaitForStorageBoxReady(ctx, created.ID, 10*time.Minute)
	if err != nil {
		return storageBoxSecrets{}, err
	}

	secrets := storageBoxSecrets{
		ID:        ready.ID,
		Name:      ready.Name,
		Plan:      cfg.Storage.StorageBoxPlan,
		Location:  ready.Location,
		Username:  ready.Username,
		Password:  password,
		SMBSource: hzClient.StorageBoxSMBSource(ready.Username),
	}
	if err := hzClient.UpdateStorageBoxAccessSettings(ctx, secrets.ID, true); err != nil {
		return storageBoxSecrets{}, err
	}
	if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterBootstrap, map[string]string{
		secretStorageBoxID:        fmt.Sprintf("%d", secrets.ID),
		secretStorageBoxName:      secrets.Name,
		secretStorageBoxPlan:      secrets.Plan,
		secretStorageBoxLocation:  secrets.Location,
		secretStorageBoxUsername:  secrets.Username,
		secretStorageBoxPassword:  secrets.Password,
		secretStorageBoxSMBSource: secrets.SMBSource,
	}); err != nil {
		return storageBoxSecrets{}, err
	}
	return secrets, nil
}

func generateStorageBoxPassword() string {
	return "Sd1!" + strings.ReplaceAll(uuid.NewString(), "-", "")
}

func (a *App) generateBootstrapTalosAssets(ctx context.Context, cfg *config.Config, infClient *infisical.Client, infra infraSecrets, storage storageBoxSecrets, runtime runtimeSecrets) (clusterAccessSecrets, map[string][]byte, error) {
	accessSecrets, err := a.regenerateTalosAssets(ctx, cfg, infClient, nil)
	if err != nil {
		return clusterAccessSecrets{}, nil, err
	}

	manifests, err := a.bootstrapInlineManifests(cfg, storage, infra, runtime)
	if err != nil {
		return clusterAccessSecrets{}, nil, err
	}
	_ = manifests

	rendered := make(map[string][]byte, len(cfg.Nodes))
	for _, node := range cfg.Nodes {
		configBytes, err := renderTalosConfigForNode(accessSecrets.ControlPlaneConfigYAML, node)
		if err != nil {
			return clusterAccessSecrets{}, nil, err
		}
		configBytes, err = injectBootstrapManifests(configBytes, cfg, runtime.InstallerImage)
		if err != nil {
			return clusterAccessSecrets{}, nil, err
		}
		if len(configBytes) > hetznerUserDataByteLimit {
			return clusterAccessSecrets{}, nil, fmt.Errorf("rendered Talos user-data for node %s is %d bytes, exceeding Hetzner's 32 KiB limit", node.Name, len(configBytes))
		}
		rendered[node.Name] = configBytes
	}
	return accessSecrets, rendered, nil
}
