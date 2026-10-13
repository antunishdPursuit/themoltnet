package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

func parseCustomPackSelection(diaryID, entriesJSON string) (uuid.UUID, []moltnetapi.CreateDiaryCustomPackReqEntriesItem, error) {
	diaryUUID, err := uuid.Parse(diaryID)
	if err != nil {
		return uuid.UUID{}, nil, fmt.Errorf("invalid diary ID %q: %w", diaryID, err)
	}

	var items []struct {
		EntryID string `json:"entryId"`
		Rank    int    `json:"rank"`
	}
	if err := json.Unmarshal([]byte(entriesJSON), &items); err != nil {
		return uuid.UUID{}, nil, fmt.Errorf("invalid --entries JSON: %w", err)
	}
	if len(items) == 0 {
		return uuid.UUID{}, nil, fmt.Errorf("--entries must contain at least one entry")
	}

	entries := make([]moltnetapi.CreateDiaryCustomPackReqEntriesItem, len(items))
	for i, item := range items {
		entryUUID, err := uuid.Parse(item.EntryID)
		if err != nil {
			return uuid.UUID{}, nil, fmt.Errorf("invalid entryId %q at index %d: %w", item.EntryID, i, err)
		}
		entries[i] = moltnetapi.CreateDiaryCustomPackReqEntriesItem{
			EntryId: entryUUID,
			Rank:    item.Rank,
		}
	}
	return diaryUUID, entries, nil
}

func runPackPreviewCmd(stdout io.Writer, apiURL, credPath, diaryID, entriesJSON string, tokenBudget int, pinned *bool, force bool, supersedes string) error {
	diaryUUID, entries, err := parseCustomPackSelection(diaryID, entriesJSON)
	if err != nil {
		return err
	}

	previewEntries := make([]moltnetapi.PreviewDiaryCustomPackReqEntriesItem, len(entries))
	for i, entry := range entries {
		previewEntries[i] = moltnetapi.PreviewDiaryCustomPackReqEntriesItem(entry)
	}
	req := &moltnetapi.PreviewDiaryCustomPackReq{
		Entries:  previewEntries,
		PackType: moltnetapi.PreviewDiaryCustomPackReqPackTypeCustom,
		Params:   moltnetapi.PreviewDiaryCustomPackReqParams{},
	}
	if tokenBudget > 0 {
		req.TokenBudget = moltnetapi.NewOptInt(tokenBudget)
	}
	if pinned != nil {
		req.Pinned = moltnetapi.NewOptBool(*pinned)
	}
	if force {
		req.Force = moltnetapi.NewOptBool(true)
	}
	if supersedes != "" {
		supersedesUUID, err := uuid.Parse(supersedes)
		if err != nil {
			return fmt.Errorf("invalid --supersedes UUID: %w", err)
		}
		req.SupersedesPackId = moltnetapi.NewOptUUID(supersedesUUID)
	}

	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	res, err := client.PreviewDiaryCustomPack(
		context.Background(), req, moltnetapi.PreviewDiaryCustomPackParams{ID: diaryUUID},
	)
	if err != nil {
		return fmt.Errorf("pack preview: %w", formatTransportError(err))
	}
	if pack, ok := res.(*moltnetapi.CustomPackResult); ok {
		return printJSONTo(stdout, pack)
	}
	return formatAPIError(res)
}
