package main

import "github.com/spf13/cobra"

func newTaskAnalyticsCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "analytics", Short: "Read task analytics"}
	cmd.AddCommand(newTaskAnalyticsActivityCmd())
	return cmd
}

func newTaskAnalyticsActivityCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "activity",
		Short: "Read bounded task attempt activity for a team",
		Example: `  moltnet task analytics activity --team-id <uuid>
  moltnet task analytics activity --team-id <uuid> \
    --completed-after 2026-10-01T00:00:00Z --group-by taskType \
    --tags review --task-types fulfill_brief`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			credPath := flagString(cmd, "credentials")
			return runTaskAnalyticsActivityCmd(taskAnalyticsActivityOpts{
				apiURL: resolveAPIURL(cmd, credPath), credPath: credPath,
				teamID:            flagString(cmd, "team-id"),
				completedAfter:    flagString(cmd, "completed-after"),
				completedBefore:   flagString(cmd, "completed-before"),
				tags:              flagStringSlice(cmd, "tags"),
				taskTypes:         flagStringSlice(cmd, "task-types"),
				profileIDs:        flagStringSlice(cmd, "profile-ids"),
				diaryIDs:          flagStringSlice(cmd, "diary-ids"),
				claimedByAgentIDs: flagStringSlice(cmd, "claimed-by-agent-ids"),
				groupBy:           flagString(cmd, "group-by"),
				out:               cmd.OutOrStdout(),
			})
		},
	}
	cmd.Flags().String("team-id", "", "Team UUID (required)")
	cmd.Flags().String("completed-after", "", "Completed at or after RFC3339 timestamp (default: 30 days ago)")
	cmd.Flags().String("completed-before", "", "Completed before RFC3339 timestamp (default: now)")
	cmd.Flags().StringSlice("tags", nil, "Task tags, all required; comma-separated or repeated")
	cmd.Flags().StringSlice("task-types", nil, "Task types; comma-separated or repeated")
	cmd.Flags().StringSlice("profile-ids", nil, "Runtime profile UUIDs; comma-separated or repeated")
	cmd.Flags().StringSlice("diary-ids", nil, "Diary UUIDs; comma-separated or repeated")
	cmd.Flags().StringSlice("claimed-by-agent-ids", nil, "Claiming agent UUIDs; comma-separated or repeated")
	cmd.Flags().String("group-by", "", "Group by none, day, tag, taskType, profile, diary, agent, or providerModel")
	_ = cmd.MarkFlagRequired("team-id")
	return cmd
}
