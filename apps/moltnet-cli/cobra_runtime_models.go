package main

import "github.com/spf13/cobra"

func newRuntimeModelsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "runtime-models",
		Short: "Manage the runtime model catalog",
		Long: `List global and team runtime models, or manage a team's catalog entries.
Creating an entry requires --team-id. Global entries cannot be changed.`,
	}
	list := &cobra.Command{
		Use: "list", Short: "List visible runtime models", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cred, _ := cmd.Flags().GetString("credentials")
			team, _ := cmd.Flags().GetString("team-id")
			provider, _ := cmd.Flags().GetString("provider")
			return runRuntimeModelsListCmd(cmd.OutOrStdout(), resolveAPIURL(cmd, cred), cred, team, provider)
		},
	}
	list.Flags().String("team-id", "", "Team UUID; include team entries alongside global entries")
	list.Flags().String("provider", "", "Filter by provider")
	get := &cobra.Command{
		Use: "get <model-id>", Short: "Get a runtime model", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cred, _ := cmd.Flags().GetString("credentials")
			team, _ := cmd.Flags().GetString("team-id")
			return runRuntimeModelsGetCmd(cmd.OutOrStdout(), resolveAPIURL(cmd, cred), cred, args[0], team)
		},
	}
	get.Flags().String("team-id", "", "Team UUID for credential selection")
	create := &cobra.Command{
		Use: "create --team-id <team-id> --from-file <path>", Short: "Create a team runtime model from JSON", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cred, _ := cmd.Flags().GetString("credentials")
			team, _ := cmd.Flags().GetString("team-id")
			path, _ := cmd.Flags().GetString("from-file")
			return runRuntimeModelsCreateCmd(cmd.OutOrStdout(), resolveAPIURL(cmd, cred), cred, team, path)
		},
	}
	create.Flags().String("team-id", "", "Team UUID that owns the model (required)")
	create.Flags().String("from-file", "", `JSON definition path, or "-" for stdin (required)`)
	_ = create.MarkFlagRequired("team-id")
	_ = create.MarkFlagRequired("from-file")
	update := &cobra.Command{
		Use: "update <model-id> --from-file <path>", Short: "Update a team runtime model from a partial JSON file", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cred, _ := cmd.Flags().GetString("credentials")
			team, _ := cmd.Flags().GetString("team-id")
			path, _ := cmd.Flags().GetString("from-file")
			return runRuntimeModelsUpdateCmd(cmd.OutOrStdout(), resolveAPIURL(cmd, cred), cred, args[0], path, team)
		},
	}
	update.Flags().String("team-id", "", "Team UUID for credential selection")
	update.Flags().String("from-file", "", `JSON patch path, or "-" for stdin (required)`)
	_ = update.MarkFlagRequired("from-file")
	deleteCmd := &cobra.Command{
		Use: "delete <model-id>", Short: "Delete a team runtime model", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			cred, _ := cmd.Flags().GetString("credentials")
			team, _ := cmd.Flags().GetString("team-id")
			return runRuntimeModelsDeleteCmd(cmd.ErrOrStderr(), resolveAPIURL(cmd, cred), cred, args[0], team)
		},
	}
	deleteCmd.Flags().String("team-id", "", "Team UUID for credential selection")
	cmd.AddCommand(list, get, create, update, deleteCmd)
	return cmd
}
