package cli

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/intar-dev/stardrive/internal/workflow"
	"github.com/spf13/cobra"
)

func newClusterCommand(opts *rootOptions) *cobra.Command {
	clusterCmd := &cobra.Command{
		Use:   "cluster",
		Short: "Cluster lifecycle management",
	}

	clusterCmd.AddCommand(newClusterBootstrapCommand(opts))
	clusterCmd.AddCommand(newClusterStatusCommand(opts))
	clusterCmd.AddCommand(newClusterAccessCommand(opts))
	clusterCmd.AddCommand(newClusterExecCommand(opts))
	clusterCmd.AddCommand(newClusterBootstrapSecretsCommand(opts))
	clusterCmd.AddCommand(newClusterScaleCommand(opts))
	clusterCmd.AddCommand(newClusterDestroyCommand(opts))
	return clusterCmd
}

func newClusterBootstrapCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string
	var edit bool

	cmd := &cobra.Command{
		Use:   "bootstrap",
		Short: "Bootstrap or resume a Hetzner Talos cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			if strings.TrimSpace(clusterName) == "" && strings.TrimSpace(cfgFile) == "" {
				return fmt.Errorf("either --cluster or --file is required")
			}
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			if clusterName == "" {
				clusterName = strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			}
			return app.Bootstrap(cmd.Context(), workflow.BootstrapRequest{
				ClusterName: clusterName,
				ConfigPath:  path,
				Edit:        edit,
			})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	cmd.Flags().BoolVar(&edit, "edit", false, "Prompt for editable values even if already set")
	return cmd
}

func newClusterScaleCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string
	var count int

	cmd := &cobra.Command{
		Use:   "scale",
		Short: "Scale the control-plane set to a new odd node count",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			return app.Scale(cmd.Context(), workflow.ScaleRequest{ConfigPath: path, Count: count})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	cmd.Flags().IntVar(&count, "count", 0, "Target odd control-plane node count")
	return cmd
}

func newClusterStatusCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show cluster health, versions, and drift summary",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			result, err := app.Status(cmd.Context(), workflow.StatusRequest{ConfigPath: path})
			if err != nil {
				return err
			}
			app.Printf("%s", result.String())
			return nil
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	return cmd
}

func newClusterAccessCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string
	var outDir string

	cmd := &cobra.Command{
		Use:   "access",
		Short: "Write talosconfig and kubeconfig for a cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			return app.Access(cmd.Context(), workflow.AccessRequest{ConfigPath: path, OutputDir: outDir})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	cmd.Flags().StringVar(&outDir, "out-dir", "", "Directory to write talosconfig and kubeconfig into")
	return cmd
}

func newClusterExecCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string
	var shell string

	cmd := &cobra.Command{
		Use:   "exec",
		Short: "Open a shell with TALOSCONFIG and KUBECONFIG wired for the cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			return app.Exec(cmd.Context(), workflow.ExecRequest{ConfigPath: path, Shell: shell})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	cmd.Flags().StringVar(&shell, "shell", "", "Shell to execute, defaults to the platform shell")
	return cmd
}

func newClusterBootstrapSecretsCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string

	cmd := &cobra.Command{
		Use:   "bootstrap-secrets",
		Short: "Bootstrap Infisical Universal Auth for External Secrets Operator",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			return app.BootstrapSecrets(cmd.Context(), workflow.BootstrapSecretsRequest{ConfigPath: path})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	return cmd
}

func newClusterDestroyCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var cfgFile string
	var force bool

	cmd := &cobra.Command{
		Use:   "destroy",
		Short: "Destroy the Hetzner provider-side resources for a cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			app := newApp(cmd.Context(), opts)
			path, err := resolveConfigPath(opts, clusterName, cfgFile)
			if err != nil {
				return err
			}
			return app.Destroy(cmd.Context(), workflow.DestroyRequest{ConfigPath: path, Force: force})
		},
	}

	cmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	cmd.Flags().StringVarP(&cfgFile, "file", "f", "", "Path to cluster config YAML")
	cmd.Flags().BoolVar(&force, "force", false, "Skip interactive confirmation")
	return cmd
}
