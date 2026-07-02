package workflow

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/intar-dev/stardrive/internal/config"
)

type StatusResult struct {
	Config            *config.Config
	Runtime           runtimeSecrets
	Storage           storageBoxSecrets
	TalosHealthy      bool
	KubernetesOut     string
	PublicEdgeChecked bool
	GatewayReady      bool
	WildcardCertReady bool
}

func (r *StatusResult) String() string {
	if r == nil || r.Config == nil {
		return "no status"
	}

	cfg := r.Config
	talosStatus := "unknown"
	if r.TalosHealthy {
		talosStatus = "healthy"
	}

	base := fmt.Sprintf(
		"Cluster:  %s\nTalos:    %s (%s)\nK8s:      %s\nCilium:   %s\nFlux:     %s\nNodes:    %d\nServer:   %s @ %s\nStorage:  %s @ %s\nRegistry: %s\nAPI:      %s -> %s\nApps:     %s -> %s\n",
		cfg.Cluster.Name,
		cfg.Cluster.TalosVersion,
		talosStatus,
		cfg.Cluster.KubernetesVersion,
		cfg.EffectiveCiliumVersion(),
		cfg.EffectiveFluxVersion(),
		len(cfg.Nodes),
		cfg.Hetzner.ServerType,
		cfg.Hetzner.Location,
		cfg.Storage.StorageBoxPlan,
		cfg.Storage.StorageBoxLocation,
		cfg.EffectiveRegistryAddress(),
		cfg.DNS.APIHostname,
		joinCSV(publicNodeIPs(cfg)),
		cfg.AppWildcardHostname(),
		joinCSV(publicNodeIPs(cfg)),
	)
	if r.PublicEdgeChecked {
		gatewayStatus := "pending"
		if r.GatewayReady {
			gatewayStatus = "ready"
		}
		tlsStatus := "pending"
		if r.WildcardCertReady {
			tlsStatus = "ready"
		}
		base += fmt.Sprintf("Gateway:  %s\nTLS:      %s\n", gatewayStatus, tlsStatus)
	} else {
		base += "Gateway:  unknown\nTLS:      unknown\n"
	}
	if strings.TrimSpace(r.KubernetesOut) != "" {
		base += "\nKubernetes Nodes:\n" + strings.TrimSpace(r.KubernetesOut) + "\n"
	}
	return base
}

func (a *App) Status(ctx context.Context, req StatusRequest) (*StatusResult, error) {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return nil, err
	}

	result := &StatusResult{Config: cfg}
	result.Runtime, _ = a.loadRuntimeSecrets(ctx, cfg)
	result.Storage, _ = a.loadStorageBoxSecrets(ctx, cfg)

	accessSecrets, err := a.loadClusterAccessSecrets(ctx, cfg)
	if err == nil && len(strings.TrimSpace(string(accessSecrets.TalosconfigYAML))) > 0 {
		healthCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		result.TalosHealthy = a.verifyTalosHealth(healthCtx, cfg, accessSecrets.TalosconfigYAML) == nil
		cancel()

		if len(strings.TrimSpace(string(accessSecrets.KubeconfigYAML))) > 0 {
			kubeconfigPath, cleanup, writeErr := a.writeTempKubeconfig(accessSecrets)
			if writeErr == nil {
				defer cleanup()
				out, cmdErr := a.captureCommand(ctx, a.kubectlEnv(kubeconfigPath), nil, "kubectl", "get", "nodes", "-o", "wide")
				if cmdErr == nil {
					result.KubernetesOut = string(out)
				}
				result.GatewayReady, result.WildcardCertReady = a.publicEdgeStatus(ctx, cfg, kubeconfigPath)
				result.PublicEdgeChecked = true
			}
		}
	}

	return result, nil
}
