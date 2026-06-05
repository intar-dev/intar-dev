package workflow

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/intar-dev/stardrive/internal/cloudflare"
	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"github.com/intar-dev/stardrive/internal/infisical"
	"github.com/intar-dev/stardrive/internal/operation"
	"github.com/intar-dev/stardrive/internal/talos"
	"golang.org/x/sync/errgroup"
)

var scalePhases = []string{
	"load-config",
	"validate-target",
	"preflight",
	"reconcile-topology",
	"update-dns",
	"persist-config",
	"verify",
}

func (a *App) Scale(ctx context.Context, req ScaleRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}
	if req.Count < 3 || req.Count%2 == 0 {
		return fmt.Errorf("target count must be an odd number >= 3")
	}
	if req.Count == len(cfg.Nodes) {
		a.Printf("Cluster %s is already at %d nodes\n", cfg.Cluster.Name, req.Count)
		return nil
	}

	op, resumed, err := a.store.StartOrResume(cfg.Cluster.Name, operation.TypeScale, scalePhases)
	if err != nil {
		return err
	}
	if resumed {
		a.Printf("Resuming scale from phase %s\n", op.ResumePhase())
		a.logInfo("resuming scale", "operation", op.ID, "cluster", cfg.Cluster.Name, "phase", op.ResumePhase())
	} else {
		a.Printf("Created scale operation %s\n", op.ID)
		a.logInfo("created scale operation", "operation", op.ID, "cluster", cfg.Cluster.Name, "targetCount", req.Count)
	}

	currentCount := len(cfg.Nodes)
	var targetCfg *config.Config
	var removedNodes []config.NodeConfig
	var addedNodeNames []string
	var infra infraSecrets
	var infClient *infisical.Client
	var hzClient *hetzner.Client
	var storage storageBoxSecrets
	var runtime runtimeSecrets
	var access clusterAccessSecrets

	if err := a.runPhase(op, "load-config", func() (any, error) {
		return map[string]any{
			"configPath":  req.ConfigPath,
			"current":     currentCount,
			"targetCount": req.Count,
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "validate-target", func() (any, error) {
		targetCfg, removedNodes, addedNodeNames, err = scaledConfig(cfg, req.Count)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"currentCount": currentCount,
			"targetCount":  req.Count,
			"added":        len(addedNodeNames),
			"removed":      len(removedNodes),
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "preflight", func() (any, error) {
		infClient, err = a.infisicalClient(ctx, cfg)
		if err != nil {
			return nil, err
		}
		infra, err = a.loadInfraSecrets(ctx, cfg)
		if err != nil {
			return nil, err
		}
		hzClient, err = hetzner.NewClient(infra.Hetzner)
		if err != nil {
			return nil, err
		}
		if _, _, err := hzClient.ValidateServerTypeAtLocation(ctx, cfg.Hetzner.ServerType, cfg.Hetzner.Location); err != nil {
			return nil, err
		}
		access, _ = a.loadClusterAccessSecrets(ctx, cfg)
		storage, _ = a.loadStorageBoxSecrets(ctx, cfg)
		runtime, _ = a.loadRuntimeSecrets(ctx, cfg)
		return map[string]any{
			"location":   cfg.Hetzner.Location,
			"serverType": cfg.Hetzner.ServerType,
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "reconcile-topology", func() (any, error) {
		if req.Count > currentCount {
			if storage.ID == 0 {
				return nil, fmt.Errorf("storage box secrets are required to scale up")
			}
			if runtime.BootImageID == 0 || strings.TrimSpace(runtime.InstallerImage) == "" {
				runtime, err = a.ensureHetznerTalosImage(ctx, targetCfg, hzClient, infClient, storage)
				if err != nil {
					return nil, err
				}
			}
			if runtime.NetworkID == 0 {
				nextRuntime, err := a.ensureHetznerNetworking(ctx, targetCfg, hzClient, infClient)
				if err != nil {
					return nil, err
				}
				mergeRuntimeSecrets(&runtime, nextRuntime)
			}

			generated, renderedConfigs, err := a.generateBootstrapTalosAssets(ctx, targetCfg, infClient, infra, storage, runtime)
			if err != nil {
				return nil, err
			}
			generated.KubeconfigYAML = access.KubeconfigYAML
			access = generated

			if err := a.ensureClusterServers(ctx, targetCfg, hzClient, infClient, runtime, renderedConfigs); err != nil {
				return nil, err
			}

			if len(addedNodeNames) > 0 {
				group, groupCtx := errgroup.WithContext(ctx)
				group.SetLimit(parallelNodeLimit(len(addedNodeNames)))
				for _, nodeName := range addedNodeNames {
					node, ok := findNodeByName(targetCfg, nodeName)
					if !ok || strings.TrimSpace(node.PublicIPv4) == "" {
						return nil, fmt.Errorf("scaled-up node %s does not have a public IPv4 address", nodeName)
					}
					selectedNode := node
					group.Go(func() error {
						waitCtx, cancel := context.WithTimeout(groupCtx, 30*time.Minute)
						defer cancel()
						return a.waitForTalosSecure(waitCtx, selectedNode.PublicIPv4, access.TalosconfigYAML)
					})
				}
				if err := group.Wait(); err != nil {
					return nil, err
				}
			}
		} else {
			kubeconfig, _ := a.loadKubeconfigFromStateOrSecrets(ctx, cfg)
			var kubeconfigPath string
			var cleanup func()
			if len(strings.TrimSpace(string(kubeconfig))) > 0 {
				kubeconfigPath, cleanup, err = a.writeTempFile("stardrive-scale-kubeconfig-*.yaml", kubeconfig, 0o600)
				if err != nil {
					return nil, err
				}
				defer cleanup()
			}

			servers, err := hzClient.ListServers(ctx, clusterResourceLabels(cfg))
			if err != nil {
				return nil, err
			}
			byName := map[string]hetzner.Server{}
			for _, server := range servers {
				byName[server.Name] = server
			}

			for _, node := range removedNodes {
				if kubeconfigPath != "" {
					_ = a.runCommand(ctx, a.kubectlEnv(kubeconfigPath), nil, "kubectl", "drain", node.Name, "--ignore-daemonsets", "--delete-emptydir-data", "--force", "--timeout=5m")
					_ = a.runCommand(ctx, a.kubectlEnv(kubeconfigPath), nil, "kubectl", "delete", "node", node.Name, "--ignore-not-found=true", "--timeout=2m")
				}

				nodeIP := strings.TrimSpace(node.PublicIPv4)
				if server, ok := byName[node.Name]; ok {
					if node.ProviderID() == 0 {
						node.ServerID = server.ID
						node.InstanceID = server.ID
					}
					if nodeIP == "" {
						nodeIP = strings.TrimSpace(server.PublicIPv4)
					}
				}
				if len(access.TalosconfigYAML) > 0 && nodeIP != "" {
					client, clientErr := talos.NewClient(nodeIP, access.TalosconfigYAML)
					if clientErr == nil {
						_ = client.Reset(ctx, true, true)
						_ = client.Close()
					}
				}
				if node.ProviderID() > 0 {
					if err := hzClient.DeleteServer(ctx, node.ProviderID()); err != nil {
						return nil, err
					}
				}
			}
		}

		cfg = targetCfg
		return map[string]any{
			"count":   len(cfg.Nodes),
			"added":   len(addedNodeNames),
			"removed": len(removedNodes),
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "update-dns", func() (any, error) {
		if strings.TrimSpace(infra.CloudflareToken) == "" {
			return map[string]string{"skipped": "cloudflare token missing"}, nil
		}
		if cfg.DNS.ManageNodeRecords {
			cfClient := cloudflare.New(infra.CloudflareToken)
			for _, node := range removedNodes {
				if err := cfClient.DeleteARecords(ctx, cfg.DNS.Zone, nodeDNSName(cfg, node)); err != nil {
					return nil, err
				}
			}
		}
		if err := syncClusterDNS(ctx, cfg, infra.CloudflareToken); err != nil {
			return nil, err
		}
		if err := syncClusterReverseDNS(ctx, cfg, hzClient); err != nil {
			return nil, err
		}
		return map[string]any{"updated": len(cfg.Nodes), "removed": len(removedNodes), "publicRecords": len(desiredPublicDNSRecords(cfg))}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "persist-config", func() (any, error) {
		if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
			return nil, err
		}
		return map[string]any{"nodeCount": len(cfg.Nodes)}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "verify", func() (any, error) {
		if len(access.TalosconfigYAML) > 0 {
			if err := a.verifyTalosHealth(ctx, cfg, access.TalosconfigYAML); err != nil {
				return nil, err
			}
		}
		if len(access.KubeconfigYAML) > 0 {
			kubeconfigPath, cleanup, err := a.writeTempKubeconfig(access)
			if err != nil {
				return nil, err
			}
			defer cleanup()
			if err := a.waitForKubernetesNodes(ctx, cfg, kubeconfigPath); err != nil {
				return nil, err
			}
			if err := a.waitForPublicEdge(ctx, cfg, kubeconfigPath); err != nil {
				return nil, err
			}
		}
		return map[string]bool{"healthy": true}, nil
	}); err != nil {
		return err
	}

	a.Printf("Scaled cluster %s to %d nodes\n", cfg.Cluster.Name, len(cfg.Nodes))
	return nil
}

func mergeRuntimeSecrets(dst *runtimeSecrets, src runtimeSecrets) {
	if dst == nil {
		return
	}
	if src.NetworkID > 0 {
		dst.NetworkID = src.NetworkID
	}
	if src.PlacementGroupID > 0 {
		dst.PlacementGroupID = src.PlacementGroupID
	}
	if src.FirewallID > 0 {
		dst.FirewallID = src.FirewallID
	}
	if src.BootImageID > 0 {
		dst.BootImageID = src.BootImageID
	}
	if strings.TrimSpace(src.InstallerImage) != "" {
		dst.InstallerImage = src.InstallerImage
	}
	if strings.TrimSpace(src.RegistryAddress) != "" {
		dst.RegistryAddress = src.RegistryAddress
	}
	if strings.TrimSpace(src.Repository) != "" {
		dst.Repository = src.Repository
	}
}

func scaledConfig(current *config.Config, targetCount int) (*config.Config, []config.NodeConfig, []string, error) {
	if current == nil {
		return nil, nil, nil, fmt.Errorf("config is required")
	}

	target := *current
	target.Cluster.NodeCount = targetCount
	target.Nodes = append([]config.NodeConfig(nil), current.Nodes...)

	if targetCount < len(target.Nodes) {
		removed := append([]config.NodeConfig(nil), target.Nodes[targetCount:]...)
		target.Nodes = append([]config.NodeConfig(nil), target.Nodes[:targetCount]...)
		target.ApplyDefaults()
		if err := target.Validate(); err != nil {
			return nil, nil, nil, err
		}
		return &target, removed, nil, nil
	}

	usedNames := map[string]struct{}{}
	usedPrivateIPs := map[string]struct{}{}
	for _, node := range target.Nodes {
		usedNames[node.Name] = struct{}{}
		if strings.TrimSpace(node.PrivateIPv4) != "" {
			usedPrivateIPs[node.PrivateIPv4] = struct{}{}
		}
	}

	added := []string{}
	hostOffset := 10 + len(target.Nodes)
	for len(target.Nodes) < targetCount {
		index := len(target.Nodes) + 1
		name := fmt.Sprintf("control-plane-%02d", index)
		for {
			if _, exists := usedNames[name]; !exists {
				break
			}
			name = fmt.Sprintf("control-plane-%02d-%d", index, len(usedNames)+1)
		}

		privateIP := nthPrivateIPv4(current.Hetzner.PrivateNetworkCIDR, hostOffset)
		for privateIP == "" || hasStringKey(usedPrivateIPs, privateIP) {
			hostOffset++
			privateIP = nthPrivateIPv4(current.Hetzner.PrivateNetworkCIDR, hostOffset)
		}
		hostOffset++

		target.Nodes = append(target.Nodes, config.NodeConfig{
			Name:        name,
			Role:        config.RoleControlPlane,
			PrivateIPv4: privateIP,
		})
		usedNames[name] = struct{}{}
		usedPrivateIPs[privateIP] = struct{}{}
		added = append(added, name)
	}

	target.ApplyDefaults()
	if err := target.Validate(); err != nil {
		return nil, nil, nil, err
	}
	return &target, nil, added, nil
}

func hasStringKey(values map[string]struct{}, key string) bool {
	_, ok := values[key]
	return ok
}

func findNodeByName(cfg *config.Config, name string) (config.NodeConfig, bool) {
	if cfg == nil {
		return config.NodeConfig{}, false
	}
	for _, node := range cfg.Nodes {
		if strings.TrimSpace(node.Name) == strings.TrimSpace(name) {
			return node, true
		}
	}
	return config.NodeConfig{}, false
}
