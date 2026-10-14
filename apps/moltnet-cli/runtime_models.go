package main

import (
	"context"
	"fmt"
	"io"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

func parseRuntimeModelID(value string) (uuid.UUID, error) {
	id, err := uuid.Parse(value)
	if err != nil {
		return uuid.Nil, fmt.Errorf("invalid model ID %q: %w", value, err)
	}
	return id, nil
}

func runRuntimeModelsListCmd(out io.Writer, apiURL, credPath, teamID, provider string) error {
	params := moltnetapi.ListRuntimeModelsParams{}
	if teamID != "" {
		team, err := parseOptUUIDFlag("team-id", teamID)
		if err != nil {
			return err
		}
		params.XMoltnetTeamID = team
	}
	if provider != "" {
		params.Provider = moltnetapi.OptString{Value: provider, Set: true}
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.ListRuntimeModels(context.Background(), params)
	if err != nil {
		return fmt.Errorf("runtime-models list: %w", formatTransportError(err))
	}
	models, ok := res.(*moltnetapi.RuntimeModelListResponse)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, models)
}

func runRuntimeModelsGetCmd(out io.Writer, apiURL, credPath, modelID, teamID string) error {
	id, err := parseRuntimeModelID(modelID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.GetRuntimeModel(context.Background(), moltnetapi.GetRuntimeModelParams{ModelId: id})
	if err != nil {
		return fmt.Errorf("runtime-models get: %w", formatTransportError(err))
	}
	model, ok := res.(*moltnetapi.RuntimeModel)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, model)
}

func runRuntimeModelsCreateCmd(out io.Writer, apiURL, credPath, teamID, path string) error {
	team, err := parseOptUUIDFlag("team-id", teamID)
	if err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("--from-file is required")
	}
	var body moltnetapi.CreateRuntimeModelBody
	if err := decodeJSONFile("runtime model", path, &body); err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.CreateRuntimeModel(context.Background(), &body, moltnetapi.CreateRuntimeModelParams{XMoltnetTeamID: team})
	if err != nil {
		return fmt.Errorf("runtime-models create: %w", formatTransportError(err))
	}
	model, ok := res.(*moltnetapi.RuntimeModel)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, model)
}

func runRuntimeModelsUpdateCmd(out io.Writer, apiURL, credPath, modelID, path, teamID string) error {
	id, err := parseRuntimeModelID(modelID)
	if err != nil {
		return err
	}
	if path == "" {
		return fmt.Errorf("--from-file is required")
	}
	var body moltnetapi.UpdateRuntimeModelBody
	if err := decodeJSONFile("runtime model", path, &body); err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.UpdateRuntimeModel(context.Background(), &body, moltnetapi.UpdateRuntimeModelParams{ModelId: id})
	if err != nil {
		return fmt.Errorf("runtime-models update: %w", formatTransportError(err))
	}
	model, ok := res.(*moltnetapi.RuntimeModel)
	if !ok {
		return formatAPIError(res)
	}
	return printJSONTo(out, model)
}

func runRuntimeModelsDeleteCmd(errOut io.Writer, apiURL, credPath, modelID, teamID string) error {
	id, err := parseRuntimeModelID(modelID)
	if err != nil {
		return err
	}
	client, err := newAuthenticatedClient(apiURL, credPath, teamID)
	if err != nil {
		return err
	}
	res, err := client.DeleteRuntimeModel(context.Background(), moltnetapi.DeleteRuntimeModelParams{ModelId: id})
	if err != nil {
		return fmt.Errorf("runtime-models delete: %w", formatTransportError(err))
	}
	if _, ok := res.(*moltnetapi.DeleteRuntimeModelNoContent); !ok {
		return formatAPIError(res)
	}
	_, err = fmt.Fprintf(errOut, "Deleted runtime model %s\n", id)
	return err
}
