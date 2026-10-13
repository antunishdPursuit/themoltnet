package main

import "github.com/spf13/cobra"

func newTeamsGroupsCmd() *cobra.Command {
	groups := &cobra.Command{Use: "groups", Short: "Manage named groups within teams"}
	groups.AddCommand(newTeamsGroupsCreateCmd())
	groups.AddCommand(newTeamsGroupsListCmd())
	groups.AddCommand(newTeamsGroupsGetCmd())
	groups.AddCommand(newTeamsGroupsDeleteCmd())
	groups.AddCommand(newTeamsGroupsMembersCmd())
	return groups
}

func newTeamsGroupsCreateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use: "create <team-id>", Short: "Create a group in a team", Args: cobra.ExactArgs(1),
		Example: `  moltnet teams groups create <team-id> --name Reviewers`,
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsCreateCmd(resolveAPIURL(cmd, credPath), credPath, args[0], flagString(cmd, "name"))
		},
	}
	cmd.Flags().String("name", "", "Group name (required)")
	_ = cmd.MarkFlagRequired("name")
	return cmd
}

func newTeamsGroupsListCmd() *cobra.Command {
	return &cobra.Command{
		Use: "list <team-id>", Short: "List groups in a team", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsListCmd(resolveAPIURL(cmd, credPath), credPath, args[0])
		},
	}
}

func newTeamsGroupsGetCmd() *cobra.Command {
	return &cobra.Command{
		Use: "get <group-id>", Short: "Get a group and its members", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsGetCmd(resolveAPIURL(cmd, credPath), credPath, args[0])
		},
	}
}

func newTeamsGroupsDeleteCmd() *cobra.Command {
	return &cobra.Command{
		Use: "delete <group-id>", Short: "Delete a group (owner/manager only)", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsDeleteCmd(resolveAPIURL(cmd, credPath), credPath, args[0])
		},
	}
}

func newTeamsGroupsMembersCmd() *cobra.Command {
	members := &cobra.Command{Use: "members", Short: "Manage group members"}
	members.AddCommand(&cobra.Command{
		Use: "list <group-id>", Short: "List members of a group", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsMembersListCmd(resolveAPIURL(cmd, credPath), credPath, args[0])
		},
	})
	add := &cobra.Command{
		Use: "add <group-id> <subject-id>", Short: "Add a team member to a group (owner/manager only)", Args: cobra.ExactArgs(2),
		Example: `  moltnet teams groups members add <group-id> <subject-id> --subject-ns Agent`,
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsMembersAddCmd(resolveAPIURL(cmd, credPath), credPath, args[0], args[1], flagString(cmd, "subject-ns"))
		},
	}
	add.Flags().String("subject-ns", "", "Subject namespace: Agent or Human (required)")
	_ = add.MarkFlagRequired("subject-ns")
	members.AddCommand(add)
	members.AddCommand(&cobra.Command{
		Use: "remove <group-id> <subject-id>", Short: "Remove a member from a group (owner/manager only)", Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			credPath, _ := cmd.Flags().GetString("credentials")
			return runGroupsMembersRemoveCmd(resolveAPIURL(cmd, credPath), credPath, args[0], args[1])
		},
	})
	return members
}
