package cli

import (
	"github.com/intar-dev/stardrive/internal/workflow"
	"github.com/spf13/cobra"
)

func newUpgradeCommand(opts *rootOptions) *cobra.Command {
	upgradeCmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Cluster upgrade operations",
	}

	var talosReq workflow.UpgradeTalosRequest
	talosCmd := &cobra.Command{
		Use:   "talos",
		Short: "Upgrade Talos sequentially across the cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			return newApp(cmd.Context(), opts).UpgradeTalos(cmd.Context(), talosReq)
		},
	}
	talosCmd.Flags().StringVarP(&talosReq.ConfigPath, "file", "f", "", "Path to cluster config YAML")
	talosCmd.Flags().StringVar(&talosReq.Version, "version", "", "Target Talos version")

	var k8sReq workflow.UpgradeKubernetesRequest
	k8sCmd := &cobra.Command{
		Use:   "k8s",
		Short: "Upgrade Kubernetes sequentially across the cluster",
		RunE: func(cmd *cobra.Command, args []string) error {
			return newApp(cmd.Context(), opts).UpgradeKubernetes(cmd.Context(), k8sReq)
		},
	}
	k8sCmd.Flags().StringVarP(&k8sReq.ConfigPath, "file", "f", "", "Path to cluster config YAML")
	k8sCmd.Flags().StringVar(&k8sReq.Version, "version", "", "Target Kubernetes version")

	upgradeCmd.AddCommand(talosCmd, k8sCmd)
	return upgradeCmd
}
