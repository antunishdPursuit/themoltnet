package main

import (
	"context"
	"fmt"
	"io"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

type packDiffSelector struct {
	id       uuid.UUID
	otherID  uuid.UUID
	cid      string
	otherCID string
}

func parsePackDiffSelector(packID, otherPackID, packCID, otherPackCID string) (packDiffSelector, error) {
	byID := packID != "" || otherPackID != ""
	byCID := packCID != "" || otherPackCID != ""
	if byID == byCID {
		return packDiffSelector{}, fmt.Errorf("provide either --pack-id and --other-pack-id, or --pack-cid and --other-pack-cid")
	}
	if byCID {
		if packCID == "" || otherPackCID == "" {
			return packDiffSelector{}, fmt.Errorf("provide both --pack-cid and --other-pack-cid")
		}
		return packDiffSelector{cid: packCID, otherCID: otherPackCID}, nil
	}
	if packID == "" || otherPackID == "" {
		return packDiffSelector{}, fmt.Errorf("provide both --pack-id and --other-pack-id")
	}
	id, err := uuid.Parse(packID)
	if err != nil {
		return packDiffSelector{}, fmt.Errorf("invalid --pack-id %q: %w", packID, err)
	}
	otherID, err := uuid.Parse(otherPackID)
	if err != nil {
		return packDiffSelector{}, fmt.Errorf("invalid --other-pack-id %q: %w", otherPackID, err)
	}
	return packDiffSelector{id: id, otherID: otherID}, nil
}

func runPackDiffCmd(stdout io.Writer, apiURL, credPath, packID, otherPackID, packCID, otherPackCID string) error {
	selector, err := parsePackDiffSelector(packID, otherPackID, packCID, otherPackCID)
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
	if selector.cid != "" {
		res, err := client.DiffContextPacksByCid(context.Background(), moltnetapi.DiffContextPacksByCidParams{
			Cid: selector.cid, OtherCid: selector.otherCID,
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
		ID: selector.id, OtherId: selector.otherID,
	})
	if err != nil {
		return fmt.Errorf("pack diff: %w", formatTransportError(err))
	}
	if diff, ok := res.(*moltnetapi.DiffContextPacksByIdOK); ok {
		return printJSONTo(stdout, diff)
	}
	return formatAPIError(res)
}
