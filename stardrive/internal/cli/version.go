package cli

import (
	"fmt"

	"github.com/intar-dev/stardrive/internal/buildinfo"
	"github.com/spf13/cobra"
)

func newVersionCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print build version information",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), buildinfo.Report(cmd.Root().Name()))
			return err
		},
	}
}
