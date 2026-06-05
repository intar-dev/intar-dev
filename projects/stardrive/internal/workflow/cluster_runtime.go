package workflow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/apricote/hcloud-upload-image/hcloudimages"
	"github.com/cosi-project/runtime/pkg/safe"
	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"github.com/intar-dev/stardrive/internal/infisical"
	"github.com/intar-dev/stardrive/internal/names"
	"github.com/intar-dev/stardrive/internal/talos"
	"github.com/siderolabs/talos/pkg/cluster"
	"github.com/siderolabs/talos/pkg/cluster/check"
	clientconfig "github.com/siderolabs/talos/pkg/machinery/client/config"
	clusterres "github.com/siderolabs/talos/pkg/machinery/resources/cluster"
	"golang.org/x/sync/errgroup"
	"gopkg.in/yaml.v3"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	registryPVCName          = "registry-data"
	registryStorageSecret    = "storagebox-credentials"
	registryTLSSecret        = "stardrive-registry-tls"
	fluxRegistryCASecret     = "stardrive-registry-ca"
	hetznerCloudSecretName   = "hcloud"
	registryBootstrapPVName  = "storagebox-registry"
	publicEdgeNamespace      = "gateway-system"
	publicGatewayName        = "stardrive-public"
	publicWildcardCertName   = "stardrive-wildcard"
	publicWildcardTLSSecret  = "stardrive-wildcard-tls"
	resourceManagedByKey     = "stardrive.dev-managed-by"
	resourceManagedByValue   = "stardrive"
	resourceClusterKey       = "stardrive.dev-cluster"
	resourceNodeKey          = "stardrive.dev-node"
	resourceImageIDKey       = "stardrive.dev-image-id"
	resourceRepositoryPrefix = "gitops"
	hetznerUserDataByteLimit = 32 * 1024
	gatewayAPIVersion        = "v1.4.1"
)

type inlineManifest struct {
	Name     string
	Contents string
}

func (a *App) regenerateTalosAssets(ctx context.Context, cfg *config.Config, infClient *infisical.Client, existingSecrets []byte) (clusterAccessSecrets, error) {
	secretsYAML := bytes.TrimSpace(existingSecrets)
	if len(secretsYAML) == 0 {
		generated, err := talos.GenerateSecretsYAML(ctx)
		if err != nil {
			return clusterAccessSecrets{}, err
		}
		secretsYAML = generated
	}

	sans := []string{cfg.DNS.APIHostname}
	for _, node := range cfg.Nodes {
		sans = append(sans, node.Name)
		if cfg.DNS.ManageNodeRecords {
			sans = append(sans, nodeDNSName(cfg, node))
		}
		if node.PublicIPv4 != "" {
			sans = append(sans, node.PublicIPv4)
		}
	}

	generated, err := talos.GenerateConfig(ctx, talos.GenConfigParams{
		ClusterName:                 cfg.Cluster.Name,
		Endpoint:                    cfg.DNS.APIHostname,
		TalosEndpoints:              controlPlaneIPs(cfg),
		TalosVersion:                cfg.Cluster.TalosVersion,
		TalosSchematic:              cfg.Cluster.TalosSchematic,
		KubernetesVersion:           cfg.Cluster.KubernetesVersion,
		ControlPlaneTaints:          cfg.Cluster.ControlPlaneTaints,
		KubernetesAPIServerCertSANs: uniqueNonEmpty(sans),
		SecretsYAML:                 secretsYAML,
	})
	if err != nil {
		return clusterAccessSecrets{}, err
	}

	secrets := clusterAccessSecrets{
		TalosSecretsYAML:       slicesClone(secretsYAML),
		ControlPlaneConfigYAML: slicesClone(generated.ControlPlane),
		WorkerConfigYAML:       slicesClone(generated.Worker),
		TalosconfigYAML:        slicesClone(generated.Talosconfig),
	}

	if infClient != nil {
		if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterAccess, map[string]string{
			secretTalosSecretsYAML:      string(secrets.TalosSecretsYAML),
			secretTalosControlPlaneYAML: string(secrets.ControlPlaneConfigYAML),
			secretTalosWorkerYAML:       string(secrets.WorkerConfigYAML),
			secretTalosconfigYAML:       string(secrets.TalosconfigYAML),
		}); err != nil {
			return clusterAccessSecrets{}, err
		}
	}

	if err := a.writeLocalStateFile(cfg.Cluster.Name, "talos-secrets.yaml", secrets.TalosSecretsYAML, 0o600); err != nil {
		return clusterAccessSecrets{}, err
	}
	if err := a.writeLocalStateFile(cfg.Cluster.Name, "controlplane.yaml", secrets.ControlPlaneConfigYAML, 0o600); err != nil {
		return clusterAccessSecrets{}, err
	}
	if err := a.writeLocalStateFile(cfg.Cluster.Name, "worker.yaml", secrets.WorkerConfigYAML, 0o600); err != nil {
		return clusterAccessSecrets{}, err
	}
	if err := a.writeLocalStateFile(cfg.Cluster.Name, "talosconfig", secrets.TalosconfigYAML, 0o600); err != nil {
		return clusterAccessSecrets{}, err
	}

	return secrets, nil
}

func slicesClone(data []byte) []byte {
	if len(data) == 0 {
		return nil
	}
	return append([]byte(nil), data...)
}

func (a *App) ensureHetznerTalosImage(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client, infClient *infisical.Client, _ storageBoxSecrets) (runtimeSecrets, error) {
	current, _ := a.loadRuntimeSecrets(ctx, cfg)
	expectedBootImageURL, err := talos.BuildFactoryDiskImageURL(cfg.Cluster.TalosVersion, cfg.Cluster.TalosSchematic, "hcloud-amd64.raw.xz")
	if err != nil {
		return runtimeSecrets{}, err
	}
	expectedInstallerImage := installerImageForVersion(cfg.Cluster.TalosVersion, cfg.Cluster.TalosSchematic)

	if current.BootImageID > 0 && strings.TrimSpace(current.InstallerImage) != "" &&
		strings.TrimSpace(current.BootImageURL) == expectedBootImageURL &&
		strings.TrimSpace(current.InstallerImage) == expectedInstallerImage {
		return current, nil
	}

	imageID := talosImageIdentity(cfg)
	labels := map[string]string{
		resourceManagedByKey: resourceManagedByValue,
		resourceClusterKey:   hetznerLabelValue(names.Slugify(cfg.Cluster.Name)),
		resourceImageIDKey:   hetznerLabelValue(imageID),
	}
	images, err := hzClient.ListImages(ctx, labels)
	if err != nil {
		return runtimeSecrets{}, err
	}
	for _, image := range images {
		if image.ID <= 0 {
			continue
		}
		current.BootImageID = image.ID
		current.BootImageURL = expectedBootImageURL
		current.InstallerImage = expectedInstallerImage
		current.Repository = gitOpsRepository(cfg)
		current.RegistryAddress = cfg.EffectiveRegistryAddress()
		if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime, map[string]string{
			secretTalosBootImageID:    fmt.Sprintf("%d", current.BootImageID),
			secretTalosBootImageURL:   current.BootImageURL,
			secretTalosInstallerImage: current.InstallerImage,
			secretRegistryAddress:     current.RegistryAddress,
			secretRegistryRepository:  current.Repository,
		}); err != nil {
			return runtimeSecrets{}, err
		}
		return current, nil
	}

	artifactReader, compression, cleanup, err := a.openRemoteTalosDiskArtifact(ctx, expectedBootImageURL)
	if err != nil {
		return runtimeSecrets{}, err
	}
	defer cleanup()

	description := fmt.Sprintf("Stardrive Talos %s for %s (%s)", cfg.Cluster.TalosVersion, cfg.Cluster.Name, imageID[:12])
	image, err := hzClient.UploadImageFromReader(ctx, artifactReader, clusterResourceName(cfg, "talos"), description, labels, compression, "amd64", cfg.Hetzner.Location)
	if err != nil {
		return runtimeSecrets{}, err
	}
	available, err := hzClient.WaitForImageAvailable(ctx, image.ID, 45*time.Minute)
	if err != nil {
		return runtimeSecrets{}, err
	}

	current.BootImageID = available.ID
	current.BootImageURL = expectedBootImageURL
	current.InstallerImage = expectedInstallerImage
	current.RegistryAddress = cfg.EffectiveRegistryAddress()
	current.Repository = gitOpsRepository(cfg)
	if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime, map[string]string{
		secretTalosBootImageID:    fmt.Sprintf("%d", current.BootImageID),
		secretTalosBootImageURL:   current.BootImageURL,
		secretTalosInstallerImage: current.InstallerImage,
		secretRegistryAddress:     current.RegistryAddress,
		secretRegistryRepository:  current.Repository,
	}); err != nil {
		return runtimeSecrets{}, err
	}
	return current, nil
}

func (a *App) openRemoteTalosDiskArtifact(ctx context.Context, artifactURL string) (io.ReadCloser, hcloudimages.Compression, func(), error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSpace(artifactURL), nil)
	if err != nil {
		return nil, hcloudimages.CompressionNone, nil, fmt.Errorf("build Talos image request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, hcloudimages.CompressionNone, nil, fmt.Errorf("download Talos disk artifact %s: %w", artifactURL, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		defer resp.Body.Close()
		return nil, hcloudimages.CompressionNone, nil, fmt.Errorf("download Talos disk artifact %s: unexpected status %s", artifactURL, resp.Status)
	}

	compression, err := imageCompressionForPath(artifactURL)
	if err != nil {
		resp.Body.Close()
		return nil, hcloudimages.CompressionNone, nil, err
	}
	a.logInfo("streaming Talos boot image from Image Factory", "url", artifactURL, "compression", compression)
	return resp.Body, compression, func() { _ = resp.Body.Close() }, nil
}

func imageCompressionForPath(path string) (hcloudimages.Compression, error) {
	switch {
	case strings.HasSuffix(path, ".xz"):
		return hcloudimages.CompressionXZ, nil
	case strings.HasSuffix(path, ".zst"):
		return hcloudimages.CompressionZSTD, nil
	case strings.HasSuffix(path, ".raw"):
		return hcloudimages.CompressionNone, nil
	default:
		return hcloudimages.CompressionNone, fmt.Errorf("unsupported Talos disk artifact format: %s", path)
	}
}

func talosImageIdentity(cfg *config.Config) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{
		"hcloud-amd64.raw.xz",
		strings.TrimSpace(cfg.Cluster.TalosVersion),
		strings.TrimSpace(cfg.Cluster.TalosSchematic),
	}, "|")))
	return hex.EncodeToString(sum[:])
}

func (a *App) ensureHetznerNetworking(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client, infClient *infisical.Client) (runtimeSecrets, error) {
	network, err := hzClient.EnsureNetwork(ctx, clusterResourceName(cfg, "network"), cfg.Hetzner.PrivateNetworkCIDR)
	if err != nil {
		return runtimeSecrets{}, err
	}
	if err := hzClient.EnsureSubnet(ctx, network, cfg.Hetzner.NetworkZone, cfg.Hetzner.PrivateNetworkCIDR); err != nil {
		return runtimeSecrets{}, err
	}
	placementGroup, err := hzClient.EnsurePlacementGroup(ctx, clusterResourceName(cfg, "placement-group"))
	if err != nil {
		return runtimeSecrets{}, err
	}
	firewall, err := hzClient.EnsureFirewall(ctx, clusterResourceName(cfg, "firewall"), nil)
	if err != nil {
		return runtimeSecrets{}, err
	}

	runtime := runtimeSecrets{
		NetworkID:        network.ID,
		PlacementGroupID: placementGroup.ID,
		FirewallID:       firewall.ID,
	}
	if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterRuntime, map[string]string{
		secretHetznerNetworkID:        fmt.Sprintf("%d", runtime.NetworkID),
		secretHetznerPlacementGroupID: fmt.Sprintf("%d", runtime.PlacementGroupID),
		secretHetznerFirewallID:       fmt.Sprintf("%d", runtime.FirewallID),
	}); err != nil {
		return runtimeSecrets{}, err
	}
	return runtime, nil
}

func (a *App) ensureClusterServers(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client, _ *infisical.Client, runtime runtimeSecrets, renderedConfigs map[string][]byte) error {
	network, err := hzClient.EnsureNetwork(ctx, clusterResourceName(cfg, "network"), cfg.Hetzner.PrivateNetworkCIDR)
	if err != nil {
		return err
	}
	placementGroup, err := hzClient.EnsurePlacementGroup(ctx, clusterResourceName(cfg, "placement-group"))
	if err != nil {
		return err
	}
	firewall, err := hzClient.EnsureFirewall(ctx, clusterResourceName(cfg, "firewall"), nil)
	if err != nil {
		return err
	}

	existing, err := hzClient.ListServers(ctx, clusterResourceLabels(cfg))
	if err != nil {
		return err
	}
	byNode := map[string]hetzner.Server{}
	for _, server := range existing {
		if value := strings.TrimSpace(server.Name); value != "" {
			byNode[value] = server
		}
	}

	for i := range cfg.Nodes {
		node := &cfg.Nodes[i]
		if existingServer, ok := byNode[node.Name]; ok {
			reconciled, err := a.reconcileExistingServer(ctx, cfg, hzClient, existingServer, *node, network.ID, placementGroup.ID, firewall.ID)
			if err != nil {
				return err
			}
			byNode[node.Name] = reconciled
			node.ServerID = reconciled.ID
			node.InstanceID = reconciled.ID
			node.PublicIPv4 = reconciled.PublicIPv4
			if strings.TrimSpace(reconciled.PrivateIPv4) != "" {
				node.PrivateIPv4 = reconciled.PrivateIPv4
			}
			node.PublicIPv6 = reconciled.PublicIPv6
		}
	}

	type pendingServer struct {
		index    int
		node     config.NodeConfig
		userData string
	}

	pending := make([]pendingServer, 0, len(cfg.Nodes))
	for i := range cfg.Nodes {
		node := cfg.Nodes[i]
		if _, ok := byNode[node.Name]; ok {
			continue
		}
		userData, ok := renderedConfigs[node.Name]
		if !ok {
			return fmt.Errorf("rendered Talos config for node %s is missing", node.Name)
		}
		pending = append(pending, pendingServer{
			index:    i,
			node:     node,
			userData: string(userData),
		})
	}

	if len(pending) == 0 {
		return nil
	}

	created := make([]*hetzner.Server, len(cfg.Nodes))
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(parallelNodeLimit(len(pending)))
	for _, request := range pending {
		request := request
		group.Go(func() error {
			server, err := hzClient.CreateServer(groupCtx, hetzner.ServerCreateRequest{
				Name:           request.node.Name,
				ServerType:     cfg.Hetzner.ServerType,
				Location:       cfg.Hetzner.Location,
				ImageID:        runtime.BootImageID,
				UserData:       request.userData,
				PrivateIPv4:    request.node.PrivateIPv4,
				Network:        network,
				PlacementGroup: placementGroup,
				Firewall:       firewall,
				Labels:         nodeResourceLabels(cfg, request.node),
				PublicIPv6:     cfg.Hetzner.PublicIPv6,
			})
			if err != nil {
				return err
			}
			created[request.index] = server
			return nil
		})
	}
	if err := group.Wait(); err != nil {
		return err
	}

	for _, request := range pending {
		server := created[request.index]
		if server == nil {
			return fmt.Errorf("server creation for node %s returned no result", request.node.Name)
		}
		node := &cfg.Nodes[request.index]
		node.ServerID = server.ID
		node.InstanceID = server.ID
		node.PublicIPv4 = server.PublicIPv4
		if strings.TrimSpace(server.PrivateIPv4) != "" {
			node.PrivateIPv4 = server.PrivateIPv4
		}
		node.PublicIPv6 = server.PublicIPv6
	}
	return nil
}

func (a *App) waitForTalosSecure(ctx context.Context, nodeAddress string, talosconfig []byte) error {
	a.logInfo("waiting for Talos secure API", "node", nodeAddress, "timeout", time.Until(deadlineOrNow(ctx)).String())
	return waitFor(ctx, 5*time.Second, func(ctx context.Context) error {
		client, err := talos.NewClient(nodeAddress, talosconfig)
		if err != nil {
			return err
		}
		defer client.Close()
		_, err = client.Version(ctx)
		return err
	})
}

func (a *App) reconcileExistingServer(ctx context.Context, cfg *config.Config, hzClient *hetzner.Client, existing hetzner.Server, node config.NodeConfig, networkID, placementGroupID, firewallID int64) (hetzner.Server, error) {
	if strings.TrimSpace(existing.ServerType) != strings.TrimSpace(cfg.Hetzner.ServerType) {
		return hetzner.Server{}, fmt.Errorf("existing server %s has server type %s, expected %s", node.Name, existing.ServerType, cfg.Hetzner.ServerType)
	}
	if strings.TrimSpace(existing.Location) != strings.TrimSpace(cfg.Hetzner.Location) {
		return hetzner.Server{}, fmt.Errorf("existing server %s is in location %s, expected %s", node.Name, existing.Location, cfg.Hetzner.Location)
	}

	if placementGroupID != 0 {
		reconciled, reconcileErr := hzClient.EnsureServerInPlacementGroup(ctx, existing.ID, placementGroupID)
		if reconcileErr != nil {
			return hetzner.Server{}, fmt.Errorf("ensure placement group for server %s: %w", node.Name, reconcileErr)
		}
		existing = *reconciled
	}
	if networkID != 0 {
		reconciled, reconcileErr := hzClient.EnsureServerAttachedToNetwork(ctx, existing.ID, networkID, node.PrivateIPv4)
		if reconcileErr != nil {
			return hetzner.Server{}, fmt.Errorf("ensure private network for server %s: %w", node.Name, reconcileErr)
		}
		existing = *reconciled
	}
	if firewallID != 0 {
		reconciled, reconcileErr := hzClient.EnsureFirewallAppliedToServer(ctx, firewallID, existing.ID)
		if reconcileErr != nil {
			return hetzner.Server{}, fmt.Errorf("ensure firewall for server %s: %w", node.Name, reconcileErr)
		}
		existing = *reconciled
	}

	if placementGroupID != 0 && existing.PlacementGroupID != placementGroupID {
		return hetzner.Server{}, fmt.Errorf("existing server %s is attached to placement group %d, expected %d", node.Name, existing.PlacementGroupID, placementGroupID)
	}
	if networkID != 0 && !slices.Contains(existing.NetworkIDs, networkID) {
		return hetzner.Server{}, fmt.Errorf("existing server %s is not attached to required network %d", node.Name, networkID)
	}
	if firewallID != 0 && !slices.Contains(existing.FirewallIDs, firewallID) {
		return hetzner.Server{}, fmt.Errorf("existing server %s is not attached to required firewall %d", node.Name, firewallID)
	}
	if wantIP := strings.TrimSpace(node.PrivateIPv4); wantIP != "" && strings.TrimSpace(existing.PrivateIPv4) != wantIP {
		return hetzner.Server{}, fmt.Errorf("existing server %s has private IPv4 %s, expected %s", node.Name, existing.PrivateIPv4, wantIP)
	}
	return existing, nil
}

func (a *App) fetchKubeconfig(ctx context.Context, nodeAddress string, talosconfig []byte) ([]byte, error) {
	client, err := talos.NewClient(nodeAddress, talosconfig)
	if err != nil {
		return nil, err
	}
	defer client.Close()
	return client.Kubeconfig(ctx)
}

func (a *App) waitForKubernetesAPI(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	a.logInfo("waiting for Kubernetes API endpoint",
		"cluster", cfg.Cluster.Name,
		"endpoint", cfg.DNS.APIHostname,
		"timeout", time.Until(deadlineOrNow(ctx)).String(),
	)
	restConfig, err := clientcmd.BuildConfigFromFlags("", strings.TrimSpace(kubeconfigPath))
	if err != nil {
		return fmt.Errorf("load kubeconfig: %w", err)
	}
	restConfig.Timeout = 10 * time.Second
	discoveryClient, err := discovery.NewDiscoveryClientForConfig(restConfig)
	if err != nil {
		return fmt.Errorf("create kubernetes discovery client: %w", err)
	}
	lastError := ""
	return waitFor(ctx, 5*time.Second, func(ctx context.Context) error {
		_, err := discoveryClient.ServerVersion()
		if err != nil {
			if err.Error() != lastError {
				a.logInfo("Kubernetes API not ready yet",
					"cluster", cfg.Cluster.Name,
					"endpoint", cfg.DNS.APIHostname,
					"error", err,
				)
				lastError = err.Error()
			}
			return err
		}
		return nil
	})
}

func (a *App) persistKubeconfig(ctx context.Context, cfg *config.Config, infClient *infisical.Client, kubeconfig []byte) error {
	if err := infClient.SetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterAccess, map[string]string{
		secretKubeconfigYAML: string(kubeconfig),
	}); err != nil {
		return err
	}
	return a.writeLocalStateFile(cfg.Cluster.Name, "kubeconfig", kubeconfig, 0o600)
}

func (a *App) verifyTalosHealth(ctx context.Context, cfg *config.Config, talosconfig []byte) error {
	endpoint, err := a.firstReachableControlPlaneIP(ctx, cfg, talosconfig)
	if err != nil {
		return err
	}
	kubernetesEndpoint := strings.TrimSpace(cfg.DNS.APIHostname)
	if kubernetesEndpoint == "" {
		kubernetesEndpoint = endpoint
	}
	cfgBytes := bytes.TrimSpace(talosconfig)
	if len(cfgBytes) == 0 {
		return fmt.Errorf("talosconfig is missing")
	}
	parsedTalosconfig, err := clientconfig.FromBytes(cfgBytes)
	if err != nil {
		return fmt.Errorf("parse talosconfig: %w", err)
	}
	clientProvider := &cluster.ConfigClientProvider{TalosConfig: parsedTalosconfig}
	defaultClient, err := clientProvider.Client(endpoint)
	if err != nil {
		return fmt.Errorf("create Talos health client: %w", err)
	}
	clientProvider.DefaultClient = defaultClient
	defer clientProvider.Close() //nolint:errcheck

	items, err := safe.StateListAll[*clusterres.Member](ctx, defaultClient.COSI)
	if err != nil {
		return fmt.Errorf("discover Talos cluster members: %w", err)
	}
	var members []*clusterres.Member
	items.ForEach(func(item *clusterres.Member) {
		members = append(members, item)
	})
	if len(members) == 0 {
		return fmt.Errorf("no Talos cluster members discovered")
	}

	clusterInfo, err := check.NewDiscoveredClusterInfo(members)
	if err != nil {
		return fmt.Errorf("build Talos cluster info: %w", err)
	}

	state := struct {
		cluster.ClientProvider
		cluster.K8sProvider
		cluster.Info
	}{
		ClientProvider: clientProvider,
		K8sProvider: &cluster.KubernetesClient{
			ClientProvider: clientProvider,
			ForceEndpoint:  kubernetesEndpoint,
		},
		Info: clusterInfo,
	}

	checkCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	a.logInfo("verifying Talos cluster health", "endpoint", endpoint, "kubernetes_endpoint", kubernetesEndpoint, "mode", "client-side")
	return check.Wait(checkCtx, &state, append(check.DefaultClusterChecks(), check.ExtraClusterChecks()...), check.StderrReporter())
}

func (a *App) installCilium(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	a.logInfo("installing Cilium", "cluster", cfg.Cluster.Name, "version", cfg.EffectiveCiliumVersion())
	ciliumBinary, err := a.ensureCiliumCLI(ctx)
	if err != nil {
		return err
	}
	env := a.kubectlEnv(kubeconfigPath)
	if err := a.installGatewayAPICRDs(ctx, kubeconfigPath); err != nil {
		return err
	}
	statusCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	installMode := "install"
	if _, err := a.probeCommand(statusCtx, env, nil, ciliumBinary, "status", "--wait-duration", "30s"); err == nil {
		installMode = "upgrade"
		a.logInfo("reconciling existing Cilium installation", "cluster", cfg.Cluster.Name, "version", cfg.EffectiveCiliumVersion())
	} else {
		a.logInfo("Cilium is not installed yet; proceeding with install", "cluster", cfg.Cluster.Name)
	}
	args := append([]string{installMode, "--version", trimVersionPrefix(cfg.EffectiveCiliumVersion())}, talosCiliumInstallFlags()...)
	args = append(args, "--wait")
	if err := a.runCommand(ctx, env, nil, ciliumBinary, args...); err != nil {
		return fmt.Errorf("%s Cilium: %w", installMode, err)
	}
	if err := a.runCommand(ctx, env, nil, "kubectl", "rollout", "status", "--namespace", "kube-system", "daemonset/cilium-envoy", "--timeout=15m"); err != nil {
		return fmt.Errorf("wait for Cilium Envoy daemonset: %w", err)
	}
	return a.runCommand(ctx, env, nil, ciliumBinary, "status", "--wait")
}

func (a *App) installGatewayAPICRDs(ctx context.Context, kubeconfigPath string) error {
	env := a.kubectlEnv(kubeconfigPath)
	url := fmt.Sprintf("https://github.com/kubernetes-sigs/gateway-api/releases/download/%s/standard-install.yaml", gatewayAPIVersion)
	if err := a.runCommand(ctx, env, nil, "kubectl", "apply", "--server-side", "-f", url); err != nil {
		return fmt.Errorf("install Gateway API CRDs: %w", err)
	}
	for _, crd := range []string{
		"gatewayclasses.gateway.networking.k8s.io",
		"gateways.gateway.networking.k8s.io",
		"httproutes.gateway.networking.k8s.io",
		"referencegrants.gateway.networking.k8s.io",
		"grpcroutes.gateway.networking.k8s.io",
		"backendtlspolicies.gateway.networking.k8s.io",
	} {
		if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--for=condition=Established", "crd/"+crd, "--timeout=5m"); err != nil {
			return fmt.Errorf("wait for Gateway API CRD %s: %w", crd, err)
		}
	}
	return nil
}

func talosCiliumInstallFlags() []string {
	return []string{
		"--set", "ipam.mode=kubernetes",
		"--set", "kubeProxyReplacement=true",
		"--set", `securityContext.capabilities.ciliumAgent={CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}`,
		"--set", `securityContext.capabilities.cleanCiliumState={NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}`,
		"--set", "cgroup.autoMount.enabled=false",
		"--set", "cgroup.hostRoot=/sys/fs/cgroup",
		"--set", "k8sServiceHost=localhost",
		"--set", "k8sServicePort=7445",
		"--set", "gatewayAPI.enabled=true",
		"--set", "gatewayAPI.enableAlpn=true",
		"--set", "gatewayAPI.enableAppProtocol=true",
		"--set", "gatewayAPI.hostNetwork.enabled=true",
		"--set", "envoy.enabled=true",
		"--set", "envoy.securityContext.capabilities.keepCapNetBindService=true",
		"--set", `envoy.securityContext.capabilities.envoy={NET_ADMIN,SYS_ADMIN,NET_BIND_SERVICE}`,
	}
}

func (a *App) waitForBootstrapRegistry(ctx context.Context, cfg *config.Config, kubeconfigPath string, storage storageBoxSecrets, infra infraSecrets, runtime runtimeSecrets) error {
	env := a.kubectlEnv(kubeconfigPath)
	if err := a.applyBootstrapClusterManifests(ctx, cfg, kubeconfigPath, storage, infra, runtime); err != nil {
		return err
	}
	if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", "kube-system", "--for=condition=Available", "deployment/hcloud-cloud-controller-manager", "--timeout=15m"); err != nil {
		return err
	}
	if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", "kube-system", "--for=condition=Available", "deployment/csi-smb-controller", "--timeout=15m"); err != nil {
		return err
	}
	if err := a.runCommand(ctx, env, nil, "kubectl", "rollout", "status", "--namespace", "kube-system", "daemonset/csi-smb-node", "--timeout=15m"); err != nil {
		return err
	}
	if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", cfg.RegistryNamespace(), "--for=jsonpath={.status.phase}=Bound", "pvc/"+registryPVCName, "--timeout=15m"); err != nil {
		return err
	}
	return a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", cfg.RegistryNamespace(), "--for=condition=Available", "deployment/"+cfg.RegistryServiceName(), "--timeout=15m")
}

func (a *App) applyBootstrapClusterManifests(ctx context.Context, cfg *config.Config, kubeconfigPath string, storage storageBoxSecrets, infra infraSecrets, runtime runtimeSecrets) error {
	env := a.kubectlEnv(kubeconfigPath)
	for _, manifestURL := range smbDriverManifestURLs(cfg) {
		if err := a.runCommand(ctx, env, nil, "kubectl", "apply", "-f", manifestURL); err != nil {
			return fmt.Errorf("apply SMB CSI manifest %s: %w", manifestURL, err)
		}
	}

	manifests, err := a.bootstrapInlineManifests(cfg, storage, infra, runtime)
	if err != nil {
		return err
	}
	return a.runCommand(ctx, env, renderInlineManifestBundle(manifests), "kubectl", "apply", "-f", "-")
}

func (a *App) installFlux(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	a.logInfo("installing Flux", "cluster", cfg.Cluster.Name, "version", cfg.EffectiveFluxVersion())
	env := a.kubectlEnv(kubeconfigPath)
	if err := a.runCommand(ctx, env, nil, "kubectl", "apply", "-f", fluxInstallURL(cfg.EffectiveFluxVersion())); err != nil {
		return fmt.Errorf("install Flux: %w", err)
	}
	for _, deployment := range []string{"source-controller", "kustomize-controller", "helm-controller", "notification-controller"} {
		if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", fluxNamespace, "--for=condition=Available", "deployment/"+deployment, "--timeout=10m"); err != nil {
			return fmt.Errorf("wait for Flux deployment %s: %w", deployment, err)
		}
	}
	return nil
}

func (a *App) applyFluxBootstrapOCI(ctx context.Context, cfg *config.Config, kubeconfigPath string, runtime runtimeSecrets) error {
	return a.runCommand(ctx, a.kubectlEnv(kubeconfigPath), a.fluxOCIBootstrapManifestWithCA(cfg, runtime.RegistryCACertPEM, runtime.GitOpsArtifactTag), "kubectl", "apply", "-f", "-")
}

func (a *App) waitForFluxBootstrapOCI(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	env := a.kubectlEnv(kubeconfigPath)
	if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", fluxNamespace, "--for=condition=Ready", "ocirepository/"+fluxOCIRepositoryName, "--timeout=10m"); err != nil {
		return err
	}
	for _, name := range []string{fluxKustomizationName, fluxCertManagerKustomizationName} {
		if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", fluxNamespace, "--for=condition=Ready", "kustomization/"+name, "--timeout=15m"); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) waitForDeferredFluxBootstrapOCI(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	env := a.kubectlEnv(kubeconfigPath)
	for _, name := range []string{fluxIssuerKustomizationName, fluxClusterSecretsKustomizationName, fluxPublicEdgeKustomizationName, fluxCloudflareTunnelKustomizationName, fluxAppsKustomizationName} {
		if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--namespace", fluxNamespace, "--for=condition=Ready", "kustomization/"+name, "--timeout=15m"); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) waitForPublicEdge(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	env := a.kubectlEnv(kubeconfigPath)
	for _, args := range [][]string{
		{"wait", "--namespace", publicEdgeNamespace, "--for=condition=Ready", "certificate/" + publicWildcardCertName, "--timeout=15m"},
		{"wait", "--namespace", publicEdgeNamespace, "--for=condition=Accepted", "gateway/" + publicGatewayName, "--timeout=15m"},
	} {
		if err := a.runCommand(ctx, env, nil, "kubectl", args...); err != nil {
			return err
		}
	}
	lastError := ""
	return waitFor(ctx, 5*time.Second, func(ctx context.Context) error {
		err := a.probePublicEdge(ctx, cfg)
		if err != nil && err.Error() != lastError {
			a.logInfo("public edge not ready yet", "cluster", cfg.Cluster.Name, "error", err)
			lastError = err.Error()
		}
		return err
	})
}

func (a *App) publicEdgeStatus(ctx context.Context, cfg *config.Config, kubeconfigPath string) (bool, bool) {
	env := a.kubectlEnv(kubeconfigPath)
	check := func(args ...string) bool {
		waitCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err := a.probeCommand(waitCtx, env, nil, "kubectl", args...)
		return err == nil
	}
	certReady := check("wait", "--namespace", publicEdgeNamespace, "--for=condition=Ready", "certificate/"+publicWildcardCertName, "--timeout=5s")
	gatewayAccepted := check("wait", "--namespace", publicEdgeNamespace, "--for=condition=Accepted", "gateway/"+publicGatewayName, "--timeout=5s")
	if !certReady || !gatewayAccepted {
		return false, certReady
	}
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return a.probePublicEdge(probeCtx, cfg) == nil, certReady
}

func (a *App) probePublicEdge(ctx context.Context, cfg *config.Config) error {
	hostname := publicEdgeProbeHostname(cfg)
	if hostname == "" {
		return fmt.Errorf("public edge hostname is missing")
	}
	publicIPs := publicNodeIPs(cfg)
	if len(publicIPs) == 0 {
		return fmt.Errorf("no public node IPs available for public edge probe")
	}
	for _, ip := range publicIPs {
		if err := a.probePublicEdgeNode(ctx, hostname, ip); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) probePublicEdgeNode(ctx context.Context, hostname, ip string) error {
	httpResp, err := publicEdgeHTTPClient(hostname, ip, 80, false).Do(mustNewHTTPRequest(ctx, http.MethodGet, "http://"+hostname+"/"))
	if err != nil {
		return fmt.Errorf("probe public edge HTTP on %s: %w", ip, err)
	}
	defer httpResp.Body.Close()
	if httpResp.StatusCode < 300 || httpResp.StatusCode > 399 {
		return fmt.Errorf("probe public edge HTTP on %s: unexpected status %d", ip, httpResp.StatusCode)
	}
	location := strings.TrimSpace(httpResp.Header.Get("Location"))
	if !strings.HasPrefix(location, "https://"+hostname) {
		return fmt.Errorf("probe public edge HTTP on %s: unexpected redirect location %q", ip, location)
	}

	httpsResp, err := publicEdgeHTTPClient(hostname, ip, 443, true).Do(mustNewHTTPRequest(ctx, http.MethodGet, "https://"+hostname+"/"))
	if err != nil {
		return fmt.Errorf("probe public edge HTTPS on %s: %w", ip, err)
	}
	defer httpsResp.Body.Close()
	if httpsResp.TLS == nil {
		return fmt.Errorf("probe public edge HTTPS on %s: missing TLS state", ip)
	}
	if httpsResp.StatusCode >= 500 {
		return fmt.Errorf("probe public edge HTTPS on %s: unexpected status %d", ip, httpsResp.StatusCode)
	}
	return nil
}

func publicEdgeProbeHostname(cfg *config.Config) string {
	if cfg == nil {
		return ""
	}
	wildcard := strings.TrimSpace(cfg.AppWildcardHostname())
	if strings.HasPrefix(wildcard, "*.") {
		return "stardrive-probe." + strings.TrimPrefix(wildcard, "*.")
	}
	return ""
}

func publicEdgeHTTPClient(hostname, ip string, port int, useTLS bool) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, net.JoinHostPort(strings.TrimSpace(ip), fmt.Sprintf("%d", port)))
	}
	if useTLS {
		transport.TLSClientConfig = &tls.Config{
			MinVersion: tls.VersionTLS12,
			ServerName: strings.TrimSpace(hostname),
		}
	}
	return &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func mustNewHTTPRequest(ctx context.Context, method, url string) *http.Request {
	req, err := http.NewRequestWithContext(ctx, method, url, nil)
	if err != nil {
		panic(err)
	}
	return req
}

func (a *App) deleteFluxBootstrapResources(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	_ = a.runCommand(ctx, a.kubectlEnv(kubeconfigPath), a.fluxOCIBootstrapManifest(cfg), "kubectl", "delete", "--ignore-not-found=true", "-f", "-")
	return nil
}

func (a *App) waitForKubernetesNodes(ctx context.Context, cfg *config.Config, kubeconfigPath string) error {
	a.logInfo("waiting for Kubernetes nodes to become Ready", "cluster", cfg.Cluster.Name, "nodes", sortedNodeNames(cfg))
	env := a.kubectlEnv(kubeconfigPath)
	for _, node := range sortedNodeNames(cfg) {
		if err := a.runCommand(ctx, env, nil, "kubectl", "wait", "--for=condition=Ready", "node/"+node, "--timeout=15m"); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) loadKubeconfigFromStateOrSecrets(ctx context.Context, cfg *config.Config) ([]byte, error) {
	statePath := filepath.Join(a.clusterStateDir(cfg.Cluster.Name), "kubeconfig")
	if data, err := os.ReadFile(statePath); err == nil && len(bytes.TrimSpace(data)) > 0 {
		return data, nil
	}
	access, err := a.loadClusterAccessSecrets(ctx, cfg)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(access.KubeconfigYAML)) == 0 {
		return nil, fmt.Errorf("kubeconfig is not available")
	}
	return access.KubeconfigYAML, nil
}

func (a *App) bootstrapInlineManifests(cfg *config.Config, storage storageBoxSecrets, infra infraSecrets, runtime runtimeSecrets) ([]inlineManifest, error) {
	if strings.TrimSpace(runtime.RegistryCACertPEM) == "" || strings.TrimSpace(runtime.RegistryTLSCertPEM) == "" || strings.TrimSpace(runtime.RegistryTLSKeyPEM) == "" {
		return nil, fmt.Errorf("registry TLS material is missing")
	}
	sharePath := strings.Trim(strings.TrimSpace(cfg.Storage.ShareName), "/")
	if sharePath == "" {
		sharePath = config.DefaultStorageShareName
	}
	clusterSlug := names.Slugify(cfg.Cluster.Name)
	smbSource := storage.SMBSource
	registryRootDirectory := "/var/lib/registry/" + sharePath + "/" + clusterSlug + "/registry"

	providerSecretManifest := fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: kube-system
type: Opaque
stringData:
  token: %q
  network: %q
`, hetznerCloudSecretName, infra.Hetzner.Token, fmt.Sprintf("%d", runtime.NetworkID))

	secretManifest := fmt.Sprintf(`apiVersion: v1
kind: Namespace
metadata:
  name: %s
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: Opaque
stringData:
  username: %q
  password: %q
---
apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: kubernetes.io/tls
stringData:
  tls.crt: |
%s
  tls.key: |
%s
`, cfg.RegistryNamespace(), registryStorageSecret, cfg.RegistryNamespace(), storage.Username, storage.Password, registryTLSSecret, cfg.RegistryNamespace(), indentBlock(runtime.RegistryTLSCertPEM, 4), indentBlock(runtime.RegistryTLSKeyPEM, 4))

	storageManifest := fmt.Sprintf(`apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: %s
provisioner: smb.csi.k8s.io
reclaimPolicy: Retain
volumeBindingMode: Immediate
allowVolumeExpansion: true
parameters:
  source: %s
  csi.storage.k8s.io/node-stage-secret-name: %s
  csi.storage.k8s.io/node-stage-secret-namespace: %s
mountOptions:
  - dir_mode=0770
  - file_mode=0660
  - vers=3.0
  - noperm
  - mfsymlinks
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: %s
spec:
  capacity:
    storage: %s
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: %s
  csi:
    driver: smb.csi.k8s.io
    volumeHandle: %s
    volumeAttributes:
      source: %s
    nodeStageSecretRef:
      name: %s
      namespace: %s
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: %s
  namespace: %s
spec:
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: %s
  storageClassName: %s
  volumeName: %s
`, cfg.Storage.StorageClassName, smbSource, registryStorageSecret, cfg.RegistryNamespace(), registryBootstrapPVName, cfg.Storage.BootstrapPVCSize, cfg.Storage.StorageClassName, clusterSlug+"-registry", smbSource, registryStorageSecret, cfg.RegistryNamespace(), registryPVCName, cfg.RegistryNamespace(), cfg.Storage.BootstrapPVCSize, cfg.Storage.StorageClassName, registryBootstrapPVName)

	registryManifest := fmt.Sprintf(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: %s
  namespace: %s
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: %s
  template:
    metadata:
      labels:
        app.kubernetes.io/name: %s
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: registry
          image: registry:2.8.3
          imagePullPolicy: IfNotPresent
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          env:
            - name: REGISTRY_STORAGE_DELETE_ENABLED
              value: "true"
            - name: REGISTRY_STORAGE_FILESYSTEM_ROOTDIRECTORY
              value: %q
            - name: REGISTRY_HTTP_TLS_CERTIFICATE
              value: /certs/tls.crt
            - name: REGISTRY_HTTP_TLS_KEY
              value: /certs/tls.key
          ports:
            - containerPort: %d
              name: registry
          livenessProbe:
            httpGet:
              path: /v2/
              port: registry
              scheme: HTTPS
          readinessProbe:
            httpGet:
              path: /v2/
              port: registry
              scheme: HTTPS
          volumeMounts:
            - name: data
              mountPath: /var/lib/registry
            - name: tls
              mountPath: /certs
              readOnly: true
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: %s
        - name: tls
          secret:
            secretName: %s
---
apiVersion: v1
kind: Service
metadata:
  name: %s
  namespace: %s
spec:
  selector:
    app.kubernetes.io/name: %s
  ports:
    - name: registry
      port: %d
      targetPort: registry
`, cfg.RegistryServiceName(), cfg.RegistryNamespace(), cfg.RegistryServiceName(), cfg.RegistryServiceName(), registryRootDirectory, cfg.Storage.RegistryPort, registryPVCName, registryTLSSecret, cfg.RegistryServiceName(), cfg.RegistryNamespace(), cfg.RegistryServiceName(), cfg.Storage.RegistryPort)

	return []inlineManifest{
		{Name: "hcloud-secret", Contents: providerSecretManifest},
		{Name: "registry-bootstrap", Contents: secretManifest},
		{Name: "storagebox-registry", Contents: storageManifest},
		{Name: "registry-deployment", Contents: registryManifest},
	}, nil
}

func injectBootstrapManifests(base []byte, cfg *config.Config, installerImage string) ([]byte, error) {
	var document map[string]any
	if err := yaml.Unmarshal(base, &document); err != nil {
		return nil, fmt.Errorf("parse Talos config: %w", err)
	}

	clusterSection := ensureConfigMap(document, "cluster")
	clusterSection["externalCloudProvider"] = map[string]any{
		"enabled":   true,
		"manifests": []string{hetznerCCMManifestURL()},
	}

	etcdSection := ensureConfigMap(clusterSection, "etcd")
	etcdSection["advertisedSubnets"] = []string{cfg.Hetzner.PrivateNetworkCIDR}

	machineSection := ensureConfigMap(document, "machine")
	kubeletSection := ensureConfigMap(machineSection, "kubelet")
	kubeletSection["nodeIP"] = map[string]any{"validSubnets": []string{cfg.Hetzner.PrivateNetworkCIDR}}
	if installerImage != "" {
		installSection := ensureConfigMap(machineSection, "install")
		installSection["image"] = installerImage
	}

	rendered, err := yaml.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("render Talos bootstrap manifests: %w", err)
	}
	return rendered, nil
}

func renderInlineManifestBundle(manifests []inlineManifest) []byte {
	var builder strings.Builder
	for _, manifest := range manifests {
		contents := strings.TrimSpace(manifest.Contents)
		if contents == "" {
			continue
		}
		if builder.Len() > 0 {
			builder.WriteString("\n---\n")
		}
		builder.WriteString(contents)
		builder.WriteByte('\n')
	}
	return []byte(builder.String())
}

func manifestList(manifests []inlineManifest) []map[string]any {
	out := make([]map[string]any, 0, len(manifests))
	for _, manifest := range manifests {
		if strings.TrimSpace(manifest.Name) == "" || strings.TrimSpace(manifest.Contents) == "" {
			continue
		}
		out = append(out, map[string]any{
			"name":     manifest.Name,
			"contents": strings.TrimSpace(manifest.Contents),
		})
	}
	return out
}

func smbDriverManifestURLs(cfg *config.Config) []string {
	version := strings.TrimSpace(cfg.Storage.SMBDriverVersion)
	if version == "" {
		version = config.DefaultSMBDriverVersion
	}
	base := fmt.Sprintf("https://raw.githubusercontent.com/kubernetes-csi/csi-driver-smb/%s/deploy/%s", version, version)
	return []string{
		base + "/rbac-csi-smb.yaml",
		base + "/csi-smb-driver.yaml",
		base + "/csi-smb-controller.yaml",
		base + "/csi-smb-node.yaml",
	}
}

func hetznerCCMManifestURL() string {
	return fmt.Sprintf("https://github.com/hetznercloud/hcloud-cloud-controller-manager/releases/download/%s/ccm-networks.yaml", config.DefaultHetznerCCMVersion)
}

func (a *App) fluxOCIBootstrapManifest(cfg *config.Config) []byte {
	return a.fluxOCIBootstrapManifestWithCA(cfg, "", "")
}

func (a *App) fluxOCIBootstrapManifestWithCA(cfg *config.Config, registryCACertPEM, gitOpsTag string) []byte {
	gitOpsTag = strings.TrimSpace(gitOpsTag)
	if gitOpsTag == "" {
		gitOpsTag = "latest"
	}
	caSecretManifest := ""
	if strings.TrimSpace(registryCACertPEM) != "" {
		caSecretManifest = fmt.Sprintf(`apiVersion: v1
kind: Secret
metadata:
  name: %s
  namespace: %s
type: Opaque
stringData:
  ca.crt: |
%s
---
`, fluxRegistryCASecret, fluxNamespace, indentBlock(registryCACertPEM, 4))
	}
	return []byte(fmt.Sprintf(`%sapiVersion: source.toolkit.fluxcd.io/v1
kind: OCIRepository
metadata:
  name: %s
  namespace: %s
spec:
  interval: 1m0s
  url: oci://%s/%s
  ref:
    tag: %s
  certSecretRef:
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/external-secrets"
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/cert-manager"
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/cert-manager-issuer"
  dependsOn:
    - name: %s
    - name: %s
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/cluster-secrets"
  dependsOn:
    - name: %s
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/public-edge"
  dependsOn:
    - name: %s
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./core/cloudflare-tunnel-ingress-controller"
  dependsOn:
    - name: %s
  sourceRef:
    kind: OCIRepository
    name: %s
---
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: %s
  namespace: %s
spec:
  interval: 5m0s
  prune: true
  wait: true
  path: "./apps"
  dependsOn:
    - name: %s
    - name: %s
  sourceRef:
    kind: OCIRepository
    name: %s
`,
		caSecretManifest,
		fluxOCIRepositoryName,
		fluxNamespace,
		cfg.EffectiveRegistryAddress(),
		gitOpsRepository(cfg),
		gitOpsTag,
		fluxRegistryCASecret,
		fluxKustomizationName,
		fluxNamespace,
		fluxOCIRepositoryName,
		fluxCertManagerKustomizationName,
		fluxNamespace,
		fluxOCIRepositoryName,
		fluxIssuerKustomizationName,
		fluxNamespace,
		fluxKustomizationName,
		fluxCertManagerKustomizationName,
		fluxOCIRepositoryName,
		fluxClusterSecretsKustomizationName,
		fluxNamespace,
		fluxKustomizationName,
		fluxOCIRepositoryName,
		fluxPublicEdgeKustomizationName,
		fluxNamespace,
		fluxIssuerKustomizationName,
		fluxOCIRepositoryName,
		fluxCloudflareTunnelKustomizationName,
		fluxNamespace,
		fluxKustomizationName,
		fluxOCIRepositoryName,
		fluxAppsKustomizationName,
		fluxNamespace,
		fluxPublicEdgeKustomizationName,
		fluxCloudflareTunnelKustomizationName,
		fluxOCIRepositoryName,
	))
}

func indentBlock(value string, spaces int) string {
	value = strings.TrimRight(value, "\n")
	if value == "" {
		return strings.Repeat(" ", spaces)
	}
	prefix := strings.Repeat(" ", spaces)
	lines := strings.Split(value, "\n")
	for i := range lines {
		lines[i] = prefix + lines[i]
	}
	return strings.Join(lines, "\n")
}

func clusterResourceName(cfg *config.Config, suffix string) string {
	return fmt.Sprintf("stardrive-%s-%s", names.Slugify(cfg.Cluster.Name), names.Slugify(suffix))
}

func clusterResourceLabels(cfg *config.Config) map[string]string {
	return map[string]string{
		resourceManagedByKey: resourceManagedByValue,
		resourceClusterKey:   hetznerLabelValue(names.Slugify(cfg.Cluster.Name)),
	}
}

func nodeResourceLabels(cfg *config.Config, node config.NodeConfig) map[string]string {
	labels := clusterResourceLabels(cfg)
	labels[resourceNodeKey] = hetznerLabelValue(names.Slugify(node.Name))
	return labels
}

func hetznerLabelValue(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 63 {
		return value
	}
	return names.HashSuffix(value, 32)
}

func gitOpsRepository(cfg *config.Config) string {
	return filepath.ToSlash(filepath.Join(resourceRepositoryPrefix, names.Slugify(cfg.Cluster.Name)))
}

func nodeDNSName(cfg *config.Config, node config.NodeConfig) string {
	if strings.Contains(node.Name, ".") {
		return node.Name
	}
	baseDomain := strings.TrimSpace(cfg.AppBaseDomain())
	if baseDomain == "" {
		baseDomain = strings.TrimSpace(cfg.DNS.Zone)
	}
	return node.Name + "." + baseDomain
}

func deadlineOrNow(ctx context.Context) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return time.Now()
}
