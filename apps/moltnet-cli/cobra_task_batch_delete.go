package main

import (
	"fmt"

	"github.com/spf13/cobra"
)

func newTaskBatchDeleteCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "batch-delete",
		Short: "Queue deletion of up to 100 tasks",
		Long: `Queue asynchronous deletion of waiting, queued, and terminal tasks.
Running, dispatched, unauthorized, missing, and protected tasks are skipped.
Use --force with a reason to include protected terminal tasks when authorized.
The response reports accepted and skipped IDs; accepted does not mean deleted.`,
		Example: `  moltnet task batch-delete --team-id <uuid> --ids <task-uuid-1>,<task-uuid-2> --yes
  moltnet task batch-delete --team-id <uuid> --ids <task-uuid> \
    --force --reason "Retention cleanup" --yes`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !flagBool(cmd, "yes") {
				return fmt.Errorf("task batch deletion requires --yes to confirm")
			}
			credPath := flagString(cmd, "credentials")
			return runTaskBatchDeleteCmd(taskBatchDeleteOpts{
				apiURL: resolveAPIURL(cmd, credPath), credPath: credPath,
				teamID: flagString(cmd, "team-id"), ids: flagString(cmd, "ids"),
				force: flagBool(cmd, "force"), reason: flagString(cmd, "reason"),
				out: cmd.OutOrStdout(),
			})
		},
	}
	cmd.Flags().String("team-id", "", "Owning team UUID (required)")
	cmd.Flags().String("ids", "", "Comma-separated task UUIDs (1-100, required)")
	cmd.Flags().Bool("force", false, "Include protected terminal tasks when authorized; requires --reason")
	cmd.Flags().String("reason", "", "Reason recorded for force deletion")
	cmd.Flags().Bool("yes", false, "Confirm queuing task deletion")
	_ = cmd.MarkFlagRequired("team-id")
	_ = cmd.MarkFlagRequired("ids")
	return cmd
}
