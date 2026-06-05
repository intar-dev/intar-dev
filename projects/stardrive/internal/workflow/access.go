package workflow

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/intar-dev/stardrive/internal/config"
)

func (a *App) Access(ctx context.Context, req AccessRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}

	client, err := a.infisicalClient(ctx, cfg)
	if err != nil {
		return err
	}
	paths := cfg.Secrets()
	secrets, err := client.GetSecrets(ctx, cfg.Infisical.ProjectID, cfg.Infisical.Environment, paths.ClusterAccess)
	if err != nil {
		return err
	}

	outDir := strings.TrimSpace(req.OutputDir)
	if outDir == "" {
		outDir = a.clusterStateDir(cfg.Cluster.Name)
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return fmt.Errorf("create output directory %s: %w", outDir, err)
	}

	talosconfig := []byte(secrets[secretTalosconfigYAML])
	kubeconfig := []byte(secrets[secretKubeconfigYAML])
	if len(talosconfig) == 0 || len(kubeconfig) == 0 {
		return fmt.Errorf("talosconfig or kubeconfig are missing from Infisical path %s", paths.ClusterAccess)
	}

	talosPath := filepath.Join(outDir, "talosconfig")
	kubePath := filepath.Join(outDir, "kubeconfig")
	if err := a.writeLocalStateFile(cfg.Cluster.Name, "talosconfig", talosconfig, 0o600); err != nil {
		return err
	}
	if err := a.writeLocalStateFile(cfg.Cluster.Name, "kubeconfig", kubeconfig, 0o600); err != nil {
		return err
	}
	if err := os.WriteFile(talosPath, talosconfig, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", talosPath, err)
	}
	if err := os.WriteFile(kubePath, kubeconfig, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", kubePath, err)
	}

	a.Printf("Wrote talosconfig to %s\n", talosPath)
	a.Printf("Wrote kubeconfig to %s\n", kubePath)
	return nil
}

func (a *App) Exec(ctx context.Context, req ExecRequest) error {
	cfg, err := config.Load(req.ConfigPath)
	if err != nil {
		return err
	}

	tempDir, err := os.MkdirTemp("", "stardrive-exec-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)

	if err := a.Access(ctx, AccessRequest{ConfigPath: req.ConfigPath, OutputDir: tempDir}); err != nil {
		return err
	}

	shell := strings.TrimSpace(req.Shell)
	if shell == "" {
		shell = defaultExecShell()
	}

	cmd := exec.CommandContext(ctx, shell)
	cmd.Env = append(os.Environ(),
		"TALOSCONFIG="+filepath.Join(tempDir, "talosconfig"),
		"KUBECONFIG="+filepath.Join(tempDir, "kubeconfig"),
	)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = commandSysProcAttr()

	a.Printf("Opening shell for cluster %s\n", cfg.Cluster.Name)
	return cmd.Run()
}
