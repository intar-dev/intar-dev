package workflow

import (
	"context"
	"fmt"
	"strings"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/talos"
	machineapi "github.com/siderolabs/talos/pkg/machinery/api/machine"
)

func (a *App) UpgradeTalos(ctx context.Context, req UpgradeTalosRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}
	version := strings.TrimSpace(req.Version)
	if version == "" {
		return fmt.Errorf("target Talos version is required")
	}

	infClient, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return err
	}
	existingAccess, err := a.loadClusterAccessSecrets(ctx, cfg)
	if err != nil {
		return err
	}

	cfg.Cluster.TalosVersion = version
	if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
		return err
	}
	accessSecrets, err := a.regenerateTalosAssets(ctx, cfg, infClient, existingAccess.TalosSecretsYAML)
	if err != nil {
		return err
	}

	for _, node := range cfg.Nodes {
		client, err := talos.NewClient(node.PublicIPv4, accessSecrets.TalosconfigYAML)
		if err != nil {
			return err
		}
		if err := client.Upgrade(ctx, installerImageForVersion(cfg.Cluster.TalosVersion, cfg.Cluster.TalosSchematic), false); err != nil {
			client.Close()
			return err
		}
		if err := client.Close(); err != nil {
			return err
		}
		if err := a.waitForTalosSecure(ctx, node.PublicIPv4, accessSecrets.TalosconfigYAML); err != nil {
			return err
		}
		if err := a.verifyTalosHealth(ctx, cfg, accessSecrets.TalosconfigYAML); err != nil {
			return err
		}
	}

	a.Printf("Upgraded Talos to %s for cluster %s\n", version, cfg.Cluster.Name)
	return nil
}

func (a *App) UpgradeKubernetes(ctx context.Context, req UpgradeKubernetesRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}
	version := strings.TrimSpace(req.Version)
	if version == "" {
		return fmt.Errorf("target Kubernetes version is required")
	}

	infClient, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return err
	}
	existingAccess, err := a.loadClusterAccessSecrets(ctx, cfg)
	if err != nil {
		return err
	}

	cfg.Cluster.KubernetesVersion = version
	if err := a.saveConfig(req.ConfigPath, cfg); err != nil {
		return err
	}
	accessSecrets, err := a.regenerateTalosAssets(ctx, cfg, infClient, existingAccess.TalosSecretsYAML)
	if err != nil {
		return err
	}

	for _, node := range cfg.Nodes {
		rendered, err := renderTalosConfigForNode(accessSecrets.ControlPlaneConfigYAML, node)
		if err != nil {
			return err
		}
		client, err := talos.NewClient(node.PublicIPv4, accessSecrets.TalosconfigYAML)
		if err != nil {
			return err
		}
		if err := client.ApplyConfig(ctx, rendered, machineapi.ApplyConfigurationRequest_AUTO); err != nil {
			client.Close()
			return err
		}
		if err := client.Close(); err != nil {
			return err
		}
		if err := a.waitForTalosSecure(ctx, node.PublicIPv4, accessSecrets.TalosconfigYAML); err != nil {
			return err
		}
	}

	kubeconfigPath, cleanup, err := a.writeTempKubeconfig(existingAccess)
	if err == nil {
		defer cleanup()
		_ = a.waitForKubernetesNodes(ctx, cfg, kubeconfigPath)
	}
	if err := a.verifyTalosHealth(ctx, cfg, accessSecrets.TalosconfigYAML); err != nil {
		return err
	}

	a.Printf("Updated Kubernetes to %s for cluster %s\n", version, cfg.Cluster.Name)
	return nil
}

func installerImageForVersion(talosVersion, schematic string) string {
	installerImage, err := talos.BuildInstallerImageRef(talosVersion, schematic)
	if err != nil {
		return ""
	}
	return installerImage
}
