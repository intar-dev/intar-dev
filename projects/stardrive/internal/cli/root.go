package cli

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/intar-dev/stardrive/internal/buildinfo"
	"github.com/intar-dev/stardrive/internal/config"
	"github.com/intar-dev/stardrive/internal/envfile"
	"github.com/intar-dev/stardrive/internal/workflow"
	"github.com/spf13/cobra"
)

type rootOptions struct {
	Paths   config.Paths
	EnvFile string
	Verbose bool
}

func NewRootCommand() *cobra.Command {
	opts := &rootOptions{}

	cmd := &cobra.Command{
		Use:           "stardrive",
		Short:         "Manage Hetzner-hosted Talos clusters with Infisical-backed GitOps",
		Version:       buildinfo.Report("stardrive"),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			if shouldSkipEnvLoad(cmd) {
				return nil
			}

			level := slog.LevelInfo
			if opts.Verbose {
				level = slog.LevelDebug
			}
			logger := slog.New(slog.NewTextHandler(cmd.ErrOrStderr(), &slog.HandlerOptions{Level: level}))
			slog.SetDefault(logger)
			loaded, err := envfile.Load(opts.EnvFile, false)
			if err != nil {
				return err
			}
			if loaded > 0 {
				slog.Info("loaded environment file", "path", opts.EnvFile, "keys", loaded)
			} else if strings.TrimSpace(opts.EnvFile) != "" {
				slog.Debug("no environment file values loaded", "path", opts.EnvFile)
			}
			return nil
		},
	}
	cmd.SetVersionTemplate("{{printf \"%s\\n\" .Version}}")

	wd, _ := os.Getwd()
	cmd.PersistentFlags().StringVar(&opts.Paths.ClustersDir, "clusters-dir", filepath.Join(wd, "clusters"), "Directory containing cluster config YAML files")
	cmd.PersistentFlags().StringVar(&opts.Paths.StateDir, "state-dir", filepath.Join(wd, ".stardrive"), "Directory for operation journals and local state")
	cmd.PersistentFlags().StringVar(&opts.Paths.GitOpsDir, "gitops-dir", filepath.Join(wd, "gitops"), "Directory containing the local GitOps catalog")
	cmd.PersistentFlags().StringVar(&opts.EnvFile, "env-file", filepath.Join(wd, ".env"), "Environment file to load before running commands")
	cmd.PersistentFlags().BoolVarP(&opts.Verbose, "verbose", "v", false, "Enable verbose logs")

	cmd.AddCommand(newClusterCommand(opts))
	cmd.AddCommand(newUpgradeCommand(opts))
	cmd.AddCommand(newEtcdCommand(opts))
	cmd.AddCommand(newGitOpsCommand(opts))
	cmd.AddCommand(newVersionCommand())

	return cmd
}

func newApp(ctx context.Context, opts *rootOptions) *workflow.App {
	return workflow.NewApp(ctx, workflow.Options{
		Paths: opts.Paths.WithDefaults(),
	})
}

func resolveConfigPath(opts *rootOptions, clusterName, explicitFile string) (string, error) {
	explicitFile = strings.TrimSpace(explicitFile)
	clusterName = strings.TrimSpace(clusterName)

	switch {
	case explicitFile != "":
		return explicitFile, nil
	case clusterName != "":
		return opts.Paths.WithDefaults().ConfigPath(clusterName), nil
	default:
		return "", fmt.Errorf("either --cluster or --file is required")
	}
}

func shouldSkipEnvLoad(cmd *cobra.Command) bool {
	if cmd.Name() == "version" {
		return true
	}

	versionFlag, err := cmd.Flags().GetBool("version")
	return err == nil && versionFlag
}
