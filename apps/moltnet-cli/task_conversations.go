package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/google/uuid"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
)

// Long tool results are cut in human output; --format json has the full body.
const conversationResultLimit = 2000

type taskConversationsListOpts struct {
	apiURL   string
	credPath string
	taskID   string
	teamID   string
	attemptN int
	out      io.Writer
}

type taskConversationsGetOpts struct {
	apiURL         string
	credPath       string
	taskID         string
	teamID         string
	attemptN       int
	conversationID string
	beforeEntryID  string
	limit          int
	format         string
	follow         bool
	intervalSec    int
	out            io.Writer
	// sleep waits between follow polls; tests replace it.
	sleep func(ctx context.Context, d time.Duration) error
}

func runTaskConversationsListCmd(opts taskConversationsListOpts) error {
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskConversationsListWithClient(context.Background(), client, opts)
}

func runTaskConversationsListWithClient(ctx context.Context, client *moltnetapi.Client, opts taskConversationsListOpts) error {
	taskID, teamID, err := parseConversationIDs(opts.taskID, opts.teamID)
	if err != nil {
		return err
	}
	attemptN, err := resolveAttempt(ctx, client, taskID, moltnetapi.NewOptUUID(teamID), opts.attemptN)
	if err != nil {
		return err
	}
	list, err := listConversations(ctx, client, taskID, teamID, attemptN)
	if err != nil {
		return err
	}
	return printJSONTo(opts.out, list)
}

func runTaskConversationsGetCmd(opts taskConversationsGetOpts) error {
	if err := validateConversationGetOpts(opts); err != nil {
		return err
	}
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskConversationsGetWithClient(context.Background(), client, opts)
}

func validateConversationGetOpts(opts taskConversationsGetOpts) error {
	if opts.format != "human" && opts.format != "json" {
		return fmt.Errorf("--format: unsupported value %q (one of: human, json)", opts.format)
	}
	if opts.follow && opts.beforeEntryID != "" {
		return fmt.Errorf("--follow reads the latest entries; it cannot be combined with --before-entry-id")
	}
	if opts.follow && opts.intervalSec < 1 {
		return fmt.Errorf("--interval must be >= 1, got %d", opts.intervalSec)
	}
	if opts.limit < 0 || opts.limit > 100 {
		return fmt.Errorf("--limit must be between 1 and 100, got %d", opts.limit)
	}
	return nil
}

func runTaskConversationsGetWithClient(ctx context.Context, client *moltnetapi.Client, opts taskConversationsGetOpts) error {
	if err := validateConversationGetOpts(opts); err != nil {
		return err
	}
	taskID, teamID, err := parseConversationIDs(opts.taskID, opts.teamID)
	if err != nil {
		return err
	}
	attemptN, err := resolveAttempt(ctx, client, taskID, moltnetapi.NewOptUUID(teamID), opts.attemptN)
	if err != nil {
		return err
	}
	conversationID := opts.conversationID
	if conversationID == "" {
		conversationID, err = mainConversationID(ctx, client, taskID, teamID, attemptN)
		if err != nil {
			return err
		}
	}
	params := moltnetapi.GetTaskConversationParams{
		ID:             taskID,
		N:              attemptN,
		ConversationId: conversationID,
		XMoltnetTeamID: teamID,
	}
	if opts.beforeEntryID != "" {
		params.BeforeEntryId = moltnetapi.NewOptString(opts.beforeEntryID)
	}
	if opts.limit > 0 {
		params.Limit = moltnetapi.NewOptInt(opts.limit)
	}
	if opts.follow {
		return followConversation(ctx, client, params, opts)
	}

	snapshot, err := getConversation(ctx, client, params)
	if err != nil {
		return err
	}
	if opts.format == "json" {
		return printJSONTo(opts.out, snapshot)
	}
	for _, message := range snapshot.Messages {
		if err := printConversationMessage(opts.out, message); err != nil {
			return err
		}
	}
	if next, ok := snapshot.NextBeforeEntryId.Get(); ok {
		_, err := fmt.Fprintf(opts.out, "\n(older entries exist: pass --before-entry-id %s)\n", next)
		return err
	}
	return nil
}

// followConversation polls the conversation until the attempt is terminal,
// printing each committed message once. The in-progress partial response is
// not printed while it streams; a partial left on the final snapshot is
// printed (it is then interrupted). Polling instead of SSE keeps the CLI on
// the generated client, which does not model the event stream.
func followConversation(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskConversationParams, opts taskConversationsGetOpts) error {
	sleep := opts.sleep
	if sleep == nil {
		sleep = sleepContext
	}
	seen := map[string]bool{}
	for {
		snapshot, err := getConversation(ctx, client, params)
		if err != nil {
			return err
		}
		terminal := !isLiveAttemptStatus(snapshot.AttemptStatus)
		for _, message := range snapshot.Messages {
			_, committed := message.EntryId.Get()
			if seen[message.ID] || (!committed && !terminal) {
				continue
			}
			seen[message.ID] = true
			if err := printFollowedMessage(opts, message); err != nil {
				return err
			}
		}
		if terminal {
			return nil
		}
		if err := sleep(ctx, time.Duration(opts.intervalSec)*time.Second); err != nil {
			return err
		}
	}
}

func printFollowedMessage(opts taskConversationsGetOpts, message moltnetapi.GetTaskConversationOKMessagesItem) error {
	if opts.format == "json" {
		// MarshalJSON has a pointer receiver; a value would be reflected and
		// its raw JSON fields base64-encoded.
		line, err := json.Marshal(&message)
		if err != nil {
			return fmt.Errorf("encode conversation message: %w", err)
		}
		_, err = fmt.Fprintln(opts.out, string(line))
		return err
	}
	return printConversationMessage(opts.out, message)
}

func isLiveAttemptStatus(status string) bool {
	return status == "claimed" || status == "running"
}

func sleepContext(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}

func parseConversationIDs(taskID, teamID string) (uuid.UUID, uuid.UUID, error) {
	task, err := uuid.Parse(taskID)
	if err != nil {
		return uuid.UUID{}, uuid.UUID{}, fmt.Errorf("invalid task ID %q: %w", taskID, err)
	}
	team, err := uuid.Parse(teamID)
	if err != nil {
		return uuid.UUID{}, uuid.UUID{}, fmt.Errorf("invalid --team-id %q: %w", teamID, err)
	}
	return task, team, nil
}

func listConversations(ctx context.Context, client *moltnetapi.Client, taskID, teamID uuid.UUID, attemptN int) (*moltnetapi.ListTaskConversationsOK, error) {
	res, err := client.ListTaskConversations(ctx, moltnetapi.ListTaskConversationsParams{
		ID:             taskID,
		N:              attemptN,
		XMoltnetTeamID: teamID,
	})
	if err != nil {
		return nil, fmt.Errorf("task conversations list: %w", formatTransportError(err))
	}
	switch v := res.(type) {
	case *moltnetapi.ListTaskConversationsOK:
		return v, nil
	case *moltnetapi.ListTaskConversationsNotFound:
		return nil, fmt.Errorf("attempt %d of task %s has no Durable conversation (attempts recorded before Durable only have task messages: use `moltnet task tail --since 0`)", attemptN, taskID)
	default:
		return nil, formatAPIError(res)
	}
}

func mainConversationID(ctx context.Context, client *moltnetapi.Client, taskID, teamID uuid.UUID, attemptN int) (string, error) {
	list, err := listConversations(ctx, client, taskID, teamID, attemptN)
	if err != nil {
		return "", err
	}
	for _, item := range list.Items {
		if item.Kind == moltnetapi.ListTaskConversationsOKItemsItemKindMain {
			return item.ConversationId, nil
		}
	}
	return "", fmt.Errorf("attempt %d of task %s has no main conversation yet", attemptN, taskID)
}

func getConversation(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskConversationParams) (*moltnetapi.GetTaskConversationOK, error) {
	res, err := client.GetTaskConversation(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("task conversations get: %w", formatTransportError(err))
	}
	snapshot, ok := res.(*moltnetapi.GetTaskConversationOK)
	if !ok {
		return nil, formatAPIError(res)
	}
	return snapshot, nil
}

type conversationPart struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// rawField decodes one field of an assembled Pi message. The generated type
// keeps each field as raw JSON, so fields are read individually.
func rawField(message moltnetapi.GetTaskConversationOKMessagesItemMessage, key string, dst any) bool {
	raw, ok := message[key]
	return ok && json.Unmarshal(raw, dst) == nil
}

func messageParts(message moltnetapi.GetTaskConversationOKMessagesItemMessage) []conversationPart {
	var text string
	if rawField(message, "content", &text) {
		return []conversationPart{{Type: "text", Text: text}}
	}
	var parts []conversationPart
	rawField(message, "content", &parts)
	return parts
}

func printConversationMessage(out io.Writer, item moltnetapi.GetTaskConversationOKMessagesItem) error {
	var role, toolName string
	var isError bool
	rawField(item.Message, "role", &role)
	rawField(item.Message, "toolName", &toolName)
	rawField(item.Message, "isError", &isError)

	label := role
	if role == "toolResult" {
		label = "tool result: " + toolName
	}
	var flags []string
	if item.Inherited {
		flags = append(flags, "inherited from an earlier attempt")
	}
	if isError {
		flags = append(flags, "error")
	}
	if item.Status != moltnetapi.GetTaskConversationOKMessagesItemStatusCompleted {
		flags = append(flags, string(item.Status))
	}
	header := "[" + label + "]"
	if len(flags) > 0 {
		header += " (" + strings.Join(flags, ", ") + ")"
	}

	var b strings.Builder
	b.WriteString(header + "\n")
	for _, part := range messageParts(item.Message) {
		switch part.Type {
		case "text":
			if part.Text == "" {
				continue
			}
			if role == "toolResult" && len(part.Text) > conversationResultLimit {
				fmt.Fprintf(&b, "%s… (%d more characters; use --format json)\n",
					part.Text[:conversationResultLimit], len(part.Text)-conversationResultLimit)
				continue
			}
			b.WriteString(part.Text + "\n")
		case "toolCall":
			args := string(part.Arguments)
			if args == "" {
				args = "{}"
			}
			fmt.Fprintf(&b, "→ %s %s\n", part.Name, args)
		case "image":
			b.WriteString("[image]\n")
		}
	}
	b.WriteString("\n")
	_, err := io.WriteString(out, b.String())
	return err
}
