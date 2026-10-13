package main

import (
	"context"
	"fmt"
	"io"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

type packDiffSelector struct {
	fromID  uuid.UUID
	toID    uuid.UUID
	fromCID string
	toCID   string
}

func parsePackDiffSelector(fromPackID, toPackID, fromPackCID, toPackCID string) (packDiffSelector, error) {
	byID := fromPackID != "" || toPackID != ""
	byCID := fromPackCID != "" || toPackCID != ""
	if byID == byCID {
		return packDiffSelector{}, fmt.Errorf("provide either --from-pack-id and --to-pack-id, or --from-pack-cid and --to-pack-cid")
	}
	if byCID {
		if fromPackCID == "" || toPackCID == "" {
			return packDiffSelector{}, fmt.Errorf("provide both --from-pack-cid and --to-pack-cid")
		}
		return packDiffSelector{fromCID: fromPackCID, toCID: toPackCID}, nil
	}
	if fromPackID == "" || toPackID == "" {
		return packDiffSelector{}, fmt.Errorf("provide both --from-pack-id and --to-pack-id")
	}
	fromID, err := uuid.Parse(fromPackID)
	if err != nil {
		return packDiffSelector{}, fmt.Errorf("invalid --from-pack-id %q: %w", fromPackID, err)
	}
	toID, err := uuid.Parse(toPackID)
	if err != nil {
		return packDiffSelector{}, fmt.Errorf("invalid --to-pack-id %q: %w", toPackID, err)
	}
	return packDiffSelector{fromID: fromID, toID: toID}, nil
}

func runPackDiffCmd(stdout io.Writer, apiURL, credPath, fromPackID, toPackID, fromPackCID, toPackCID string) error {
	selector, err := parsePackDiffSelector(fromPackID, toPackID, fromPackCID, toPackCID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath)
	if err != nil {
		return err
	}
	return executePackDiff(stdout, client, selector)
}

func executePackDiff(stdout io.Writer, client *moltnetapi.Client, selector packDiffSelector) error {
	if selector.fromCID != "" {
		res, err := client.DiffContextPacksByCid(context.Background(), moltnetapi.DiffContextPacksByCidParams{
			Cid: selector.fromCID, OtherCid: selector.toCID,
		})
		if err != nil {
			return fmt.Errorf("pack diff: %w", formatTransportError(err))
		}
		if diff, ok := res.(*moltnetapi.DiffContextPacksByCidOK); ok {
			return printJSONTo(stdout, diff)
		}
		return formatAPIError(res)
	}

	res, err := client.DiffContextPacksById(context.Background(), moltnetapi.DiffContextPacksByIdParams{
		ID: selector.fromID, OtherId: selector.toID,
	})
	if err != nil {
		return fmt.Errorf("pack diff: %w", formatTransportError(err))
	}
	if diff, ok := res.(*moltnetapi.DiffContextPacksByIdOK); ok {
		return printJSONTo(stdout, diff)
	}
	return formatAPIError(res)
}
