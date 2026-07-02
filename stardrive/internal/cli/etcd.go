package cli

import (
	"github.com/intar-dev/stardrive/internal/workflow"
	"github.com/spf13/cobra"
)

func newEtcdCommand(opts *rootOptions) *cobra.Command {
	etcdCmd := &cobra.Command{
		Use:   "etcd",
		Short: "etcd snapshot and restore helpers",
	}

	var snapshotReq workflow.EtcdSnapshotRequest
	snapshotCmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Take an etcd snapshot from the first healthy control-plane node",
		RunE: func(cmd *cobra.Command, args []string) error {
			return newApp(cmd.Context(), opts).EtcdSnapshot(cmd.Context(), snapshotReq)
		},
	}
	snapshotCmd.Flags().StringVarP(&snapshotReq.ConfigPath, "file", "f", "", "Path to cluster config YAML")
	snapshotCmd.Flags().StringVar(&snapshotReq.OutputPath, "output", "", "Path to write the snapshot file")

	var restoreReq workflow.EtcdRestoreRequest
	restoreCmd := &cobra.Command{
		Use:   "restore",
		Short: "Restore etcd from a snapshot onto the first healthy control-plane node",
		RunE: func(cmd *cobra.Command, args []string) error {
			return newApp(cmd.Context(), opts).EtcdRestore(cmd.Context(), restoreReq)
		},
	}
	restoreCmd.Flags().StringVarP(&restoreReq.ConfigPath, "file", "f", "", "Path to cluster config YAML")
	restoreCmd.Flags().StringVar(&restoreReq.SnapshotPath, "input", "", "Snapshot file to restore")

	etcdCmd.AddCommand(snapshotCmd, restoreCmd)
	return etcdCmd
}
