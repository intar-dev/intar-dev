package workflow

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/talos"
)

func (a *App) EtcdSnapshot(ctx context.Context, req EtcdSnapshotRequest) error {
	cfg, client, cleanup, err := a.talosClientFromInfisical(ctx, req.ConfigPath)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := client.EtcdSnapshot(ctx, req.OutputPath); err != nil {
		return err
	}
	a.Printf("Wrote etcd snapshot for %s to %s\n", cfg.Cluster.Name, req.OutputPath)
	return nil
}

func (a *App) EtcdRestore(ctx context.Context, req EtcdRestoreRequest) error {
	cfg, client, cleanup, err := a.talosClientFromInfisical(ctx, req.ConfigPath)
	if err != nil {
		return err
	}
	defer cleanup()

	if err := client.EtcdRestore(ctx, req.SnapshotPath); err != nil {
		return err
	}
	a.Printf("Restored etcd snapshot for %s from %s\n", cfg.Cluster.Name, req.SnapshotPath)
	return nil
}

func (a *App) talosClientFromInfisical(ctx context.Context, cfgPath string) (*config.Config, *talos.Client, func(), error) {
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return nil, nil, nil, err
	}
	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return nil, nil, nil, err
	}
	secrets, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, cfg.Secrets().ClusterAccess)
	if err != nil {
		return nil, nil, nil, err
	}
	talosconfigBytes := []byte(secrets[secretTalosconfigYAML])
	if len(talosconfigBytes) == 0 {
		return nil, nil, nil, fmt.Errorf("talosconfig is missing from Infisical path %s", cfg.Secrets().ClusterAccess)
	}

	tempDir, err := os.MkdirTemp("", "stardrive-talossession-*")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create temp dir: %w", err)
	}
	cleanup := func() {
		_ = os.RemoveAll(tempDir)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "talosconfig"), talosconfigBytes, 0o600); err != nil {
		cleanup()
		return nil, nil, nil, fmt.Errorf("write temp talosconfig: %w", err)
	}

	controlPlanes := cfg.ControlPlaneNodes()
	if len(controlPlanes) == 0 || controlPlanes[0].PublicIPv4 == "" {
		cleanup()
		return nil, nil, nil, fmt.Errorf("first control-plane node has no resolved public IPv4")
	}

	talosClient, err := talos.NewClient(controlPlanes[0].PublicIPv4, talosconfigBytes)
	if err != nil {
		cleanup()
		return nil, nil, nil, err
	}
	return cfg, talosClient, func() {
		_ = talosClient.Close()
		cleanup()
	}, nil
}
