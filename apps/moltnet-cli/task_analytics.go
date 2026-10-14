package main

import (
	"context"
	"fmt"
	"io"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

type taskAnalyticsActivityOpts struct {
	apiURL, credPath, teamID                string
	completedAfter, completedBefore         string
	tags, taskTypes                         []string
	profileIDs, diaryIDs, claimedByAgentIDs []string
	groupBy                                 string
	out                                     io.Writer
}

func runTaskAnalyticsActivityCmd(opts taskAnalyticsActivityOpts) error {
	params, err := buildTaskAnalyticsActivityParams(opts)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskAnalyticsActivityWithClient(context.Background(), client, params, opts.out)
}

func runTaskAnalyticsActivityWithClient(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskActivityAnalyticsParams, out io.Writer) error {
	res, err := client.GetTaskActivityAnalytics(ctx, params)
	if err != nil {
		return fmt.Errorf("task analytics activity: %w", formatTransportError(err))
	}
	analytics, ok := res.(*moltnetapi.TaskActivityAnalyticsResponse)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, analytics)
}

func buildTaskAnalyticsActivityParams(opts taskAnalyticsActivityOpts) (moltnetapi.GetTaskActivityAnalyticsParams, error) {
	teamID, err := uuid.Parse(opts.teamID)
	if err != nil {
		return moltnetapi.GetTaskActivityAnalyticsParams{}, fmt.Errorf("invalid --team-id %q: %w", opts.teamID, err)
	}
	params := moltnetapi.GetTaskActivityAnalyticsParams{XMoltnetTeamID: teamID}
	if opts.completedAfter != "" {
		params.CompletedAfter, err = parseOptRFC3339Flag("completed-after", opts.completedAfter)
		if err != nil {
			return params, err
		}
	}
	if opts.completedBefore != "" {
		params.CompletedBefore, err = parseOptRFC3339Flag("completed-before", opts.completedBefore)
		if err != nil {
			return params, err
		}
	}
	if params.CompletedAfter.Set && params.CompletedBefore.Set && !params.CompletedAfter.Value.Before(params.CompletedBefore.Value) {
		return params, fmt.Errorf("--completed-after must precede --completed-before")
	}
	if params.Tags, err = analyticsValues("tags", opts.tags, 128); err != nil {
		return params, err
	}
	if params.TaskTypes, err = analyticsValues("task-types", opts.taskTypes, 0); err != nil {
		return params, err
	}
	if params.ProfileIds, err = analyticsUUIDs("profile-ids", opts.profileIDs); err != nil {
		return params, err
	}
	if params.DiaryIds, err = analyticsUUIDs("diary-ids", opts.diaryIDs); err != nil {
		return params, err
	}
	if params.ClaimedByAgentIds, err = analyticsUUIDs("claimed-by-agent-ids", opts.claimedByAgentIDs); err != nil {
		return params, err
	}
	if opts.groupBy != "" {
		var groupBy moltnetapi.GetTaskActivityAnalyticsGroupBy
		if err := groupBy.UnmarshalText([]byte(opts.groupBy)); err != nil {
			return params, fmt.Errorf("invalid --group-by %q: %w", opts.groupBy, err)
		}
		params.GroupBy = moltnetapi.NewOptGetTaskActivityAnalyticsGroupBy(groupBy)
	}
	return params, nil
}

func analyticsValues(flag string, values []string, maxLength int) ([]string, error) {
	parsed := cleanCSVValues(values)
	if len(parsed) > 20 {
		return nil, fmt.Errorf("--%s accepts at most 20 values", flag)
	}
	for _, value := range parsed {
		if maxLength > 0 && len(value) > maxLength {
			return nil, fmt.Errorf("--%s value exceeds %d characters", flag, maxLength)
		}
	}
	return parsed, nil
}

func analyticsUUIDs(flag string, values []string) ([]uuid.UUID, error) {
	parts, err := analyticsValues(flag, values, 0)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(parts))
	for _, value := range parts {
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, fmt.Errorf("invalid --%s UUID %q: %w", flag, value, err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}
