package cli

import (
	"github.com/intar-dev/stardrive/internal/workflow"
	"github.com/spf13/cobra"
)

func newGitOpsCommand(opts *rootOptions) *cobra.Command {
	var clusterName string
	var req workflow.GitOpsPublishRequest

	cmd := &cobra.Command{
		Use:   "gitops",
		Short: "GitOps content management",
	}

	publishCmd := &cobra.Command{
		Use:   "publish",
		Short: "Package the local gitops/ directory and push it to the cluster OCI registry",
		RunE: func(cmd *cobra.Command, args []string) error {
			path, err := resolveConfigPath(opts, clusterName, req.ConfigPath)
			if err != nil {
				return err
			}
			req.ConfigPath = path
			return newApp(cmd.Context(), opts).GitOpsPublish(cmd.Context(), req)
		},
	}
	publishCmd.Flags().StringVar(&clusterName, "cluster", "", "Cluster name")
	publishCmd.Flags().StringVarP(&req.ConfigPath, "file", "f", "", "Path to cluster config YAML")

	cmd.AddCommand(publishCmd)
	return cmd
}
