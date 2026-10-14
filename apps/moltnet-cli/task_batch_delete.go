package main

import (
	"context"
	"fmt"
	"io"
	"strings"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

type taskBatchDeleteOpts struct {
	apiURL, credPath, teamID, ids string
	force                         bool
	reason                        string
	out                           io.Writer
}

func runTaskBatchDeleteCmd(opts taskBatchDeleteOpts) error {
	req, params, err := buildTaskBatchDeleteRequest(opts)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskBatchDeleteWithClient(context.Background(), client, req, params, opts.out)
}

func runTaskBatchDeleteWithClient(ctx context.Context, client *moltnetapi.Client, req *moltnetapi.BatchDeleteTasksReq, params moltnetapi.BatchDeleteTasksParams, out io.Writer) error {
	res, err := client.BatchDeleteTasks(ctx, req, params)
	if err != nil {
		return fmt.Errorf("task batch-delete: %w", formatTransportError(err))
	}
	accepted, ok := res.(*moltnetapi.BatchDeleteTasksAcceptedResponse)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, accepted)
}

func buildTaskBatchDeleteRequest(opts taskBatchDeleteOpts) (*moltnetapi.BatchDeleteTasksReq, moltnetapi.BatchDeleteTasksParams, error) {
	teamID, err := uuid.Parse(opts.teamID)
	if err != nil {
		return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("invalid --team-id %q: %w", opts.teamID, err)
	}
	parts := splitAndTrim(opts.ids, ",")
	if len(parts) == 0 || len(parts) > 100 {
		return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("--ids requires 1 to 100 task UUIDs")
	}
	ids := make([]uuid.UUID, 0, len(parts))
	seen := make(map[uuid.UUID]bool, len(parts))
	for _, value := range parts {
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("invalid task UUID %q: %w", value, err)
		}
		if seen[id] {
			return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("duplicate task UUID %q", value)
		}
		seen[id] = true
		ids = append(ids, id)
	}
	reason := strings.TrimSpace(opts.reason)
	if opts.force && reason == "" {
		return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("--force requires a non-empty --reason")
	}
	if !opts.force && reason != "" {
		return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("--reason requires --force")
	}
	if len(reason) > 1000 {
		return nil, moltnetapi.BatchDeleteTasksParams{}, fmt.Errorf("--reason must be at most 1000 characters")
	}
	req := &moltnetapi.BatchDeleteTasksReq{Ids: ids}
	if opts.force {
		req.Force = moltnetapi.NewOptBool(true)
		req.Reason = moltnetapi.NewOptString(reason)
	}
	return req, moltnetapi.BatchDeleteTasksParams{XMoltnetTeamID: moltnetapi.NewOptUUID(teamID)}, nil
}
