package workflow

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/hetzner"
	"github.com/intar-dev/stardrive/internal/infisical"
	"github.com/intar-dev/stardrive/internal/operation"
	"github.com/intar-dev/stardrive/internal/prompts"
	"golang.org/x/sync/errgroup"
)

var destroyPhases = []string{
	"load-config",
	"confirm",
	"delete-dns",
	"delete-servers",
	"delete-image",
	"delete-firewall",
	"delete-placement-group",
	"delete-network",
	"delete-storage-box",
	"delete-infisical",
	"cleanup-local",
}

func (a *App) Destroy(ctx context.Context, req DestroyRequest) error {
	cfgPath := strings.TrimSpace(req.ConfigPath)
	if cfgPath == "" {
		return fmt.Errorf("config path is required")
	}

	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}

	op, resumed, err := a.store.StartOrResume(cfg.Cluster.Name, operation.TypeDestroy, destroyPhases)
	if err != nil {
		return err
	}
	if resumed {
		a.Printf("Resuming destroy from phase %s\n", op.ResumePhase())
		a.logInfo("resuming destroy", "operation", op.ID, "cluster", cfg.Cluster.Name, "phase", op.ResumePhase())
	} else {
		a.Printf("Created destroy operation %s\n", op.ID)
		a.logInfo("created destroy operation", "operation", op.ID, "cluster", cfg.Cluster.Name)
	}

	if err := a.runPhase(op, "load-config", func() (any, error) {
		return map[string]any{
			"configPath": cfgPath,
			"nodes":      len(cfg.Nodes),
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "confirm", func() (any, error) {
		if req.Force {
			return map[string]bool{"forced": true}, nil
		}
		_, err := prompts.Input(ctx, "Destroy confirmation", fmt.Sprintf("Type %s to destroy this Hetzner cluster's provider-side resources.", cfg.Cluster.Name), "", func(v string) error {
			if strings.TrimSpace(v) != cfg.Cluster.Name {
				return fmt.Errorf("enter %s to continue", cfg.Cluster.Name)
			}
			return nil
		})
		return nil, err
	}); err != nil {
		return err
	}

	infClient, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return err
	}
	infra, err := a.loadInfraSecrets(ctx, cfg)
	if err != nil {
		return err
	}
	hzClient, err := hetzner.NewClient(infra.Hetzner)
	if err != nil {
		return err
	}

	runtimeState, _ := a.loadRuntimeSecrets(ctx, cfg)
	storageState, _ := a.loadStorageBoxSecrets(ctx, cfg)

	if err := a.runPhase(op, "delete-dns", func() (any, error) {
		if strings.TrimSpace(infra.CloudflareToken) == "" {
			return map[string]string{"skipped": "cloudflare token missing"}, nil
		}
		if err := deleteClusterDNS(ctx, cfg, infra.CloudflareToken); err != nil {
			return nil, err
		}
		return map[string]string{
			"apiHostname": cfg.DNS.APIHostname,
			"appWildcard": cfg.AppWildcardHostname(),
			"nodeRecords": fmt.Sprintf("%t", cfg.DNS.ManageNodeRecords),
		}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-servers", func() (any, error) {
		servers, err := hzClient.ListServers(ctx, clusterResourceLabels(cfg))
		if err != nil {
			return nil, err
		}
		if len(servers) == 0 {
			for _, node := range cfg.Nodes {
				if node.ProviderID() <= 0 {
					continue
				}
				servers = append(servers, hetzner.Server{
					ID:         node.ProviderID(),
					Name:       node.Name,
					PublicIPv4: node.PublicIPv4,
				})
			}
		}
		if len(servers) == 0 {
			return map[string]int{"deleted": 0}, nil
		}

		group, groupCtx := errgroup.WithContext(ctx)
		group.SetLimit(parallelNodeLimit(len(servers)))
		for _, server := range servers {
			server := server
			group.Go(func() error {
				nodeCtx, cancel := context.WithTimeout(groupCtx, 10*time.Minute)
				defer cancel()

				if err := hzClient.DeleteServer(nodeCtx, server.ID); err != nil {
					return err
				}
				return nil
			})
		}
		if err := group.Wait(); err != nil {
			return nil, err
		}
		return map[string]int{"deleted": len(servers)}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-image", func() (any, error) {
		images, err := hzClient.ListImages(ctx, clusterResourceLabels(cfg))
		if err != nil {
			return nil, err
		}
		deleted := 0
		for _, image := range images {
			if err := hzClient.DeleteImage(ctx, image.ID); err != nil {
				return nil, err
			}
			deleted++
		}
		if deleted == 0 && runtimeState.BootImageID > 0 {
			if err := hzClient.DeleteImage(ctx, runtimeState.BootImageID); err != nil {
				return nil, err
			}
			deleted = 1
		}
		return map[string]int{"deleted": deleted}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-firewall", func() (any, error) {
		firewallID := runtimeState.FirewallID
		if firewallID == 0 {
			firewall, err := hzClient.GetFirewallByName(ctx, clusterResourceName(cfg, "firewall"))
			if err != nil {
				return nil, err
			}
			if firewall != nil {
				firewallID = firewall.ID
			}
		}
		if firewallID == 0 {
			return map[string]bool{"deleted": false}, nil
		}
		if err := hzClient.DeleteFirewall(ctx, firewallID); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "id": firewallID}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-placement-group", func() (any, error) {
		placementGroupID := runtimeState.PlacementGroupID
		if placementGroupID == 0 {
			group, err := hzClient.GetPlacementGroupByName(ctx, clusterResourceName(cfg, "placement-group"))
			if err != nil {
				return nil, err
			}
			if group != nil {
				placementGroupID = group.ID
			}
		}
		if placementGroupID == 0 {
			return map[string]bool{"deleted": false}, nil
		}
		if err := hzClient.DeletePlacementGroup(ctx, placementGroupID); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "id": placementGroupID}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-network", func() (any, error) {
		networkID := runtimeState.NetworkID
		if networkID == 0 {
			network, err := hzClient.GetNetworkByName(ctx, clusterResourceName(cfg, "network"))
			if err != nil {
				return nil, err
			}
			if network != nil {
				networkID = network.ID
			}
		}
		if networkID == 0 {
			return map[string]bool{"deleted": false}, nil
		}
		if err := hzClient.DeleteNetwork(ctx, networkID); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "id": networkID}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-storage-box", func() (any, error) {
		boxID := storageState.ID
		if boxID == 0 {
			boxes, err := hzClient.ListStorageBoxes(ctx)
			if err != nil {
				return nil, err
			}
			for _, box := range boxes {
				if strings.TrimSpace(box.Name) == clusterResourceName(cfg, "storage-box") {
					boxID = box.ID
					break
				}
			}
		}
		if boxID == 0 {
			return map[string]bool{"deleted": false}, nil
		}
		if err := hzClient.DeleteStorageBox(ctx, boxID); err != nil {
			return nil, err
		}
		return map[string]any{"deleted": true, "id": boxID}, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "delete-infisical", func() (any, error) {
		for _, path := range []string{
			cfg.Secrets().ClusterBootstrap,
			cfg.Secrets().ClusterAccess,
			cfg.Secrets().ClusterRuntime,
		} {
			if err := infClient.DeleteSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, path); err != nil && !infisical.IsNotFound(err) {
				return nil, err
			}
		}

		return nil, nil
	}); err != nil {
		return err
	}

	if err := a.runPhase(op, "cleanup-local", func() (any, error) {
		if err := os.RemoveAll(a.clusterStateDir(cfg.Cluster.Name)); err != nil {
			return nil, err
		}
		_ = removeFileIfExists(cfgPath)
		for _, name := range []string{"talosconfig", "kubeconfig"} {
			_ = removeFileIfExists(filepath.Join(filepath.Dir(cfgPath), name))
		}
		return nil, nil
	}); err != nil {
		return err
	}

	if err := a.store.DeleteCluster(cfg.Cluster.Name); err != nil {
		return err
	}

	a.Printf("Destroyed cluster resources for %s\n", cfg.Cluster.Name)
	return nil
}
