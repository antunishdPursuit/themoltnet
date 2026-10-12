package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
)

// Long tool results are cut in human output; --format json has the full body.
const conversationResultLimit = 2000

// maxConversationPageLimit is the API's largest page of entries.
const maxConversationPageLimit = 100

// --follow tolerates this many consecutive transient poll failures.
const maxFollowRetries = 5

// While nothing new arrives, --follow doubles its wait up to this many
// times --interval; any new message resets it.
const maxFollowIdleBackoff = 4

type taskConversationsListOpts struct {
	apiURL   string
	credPath string
	taskID   string
	teamID   string
	attemptN int
	out      io.Writer
}

// errNoConversation reports an attempt that has not opened a Durable store.
var errNoConversation = errors.New("no Durable conversation")

type taskConversationsGetOpts struct {
	apiURL         string
	credPath       string
	taskID         string
	teamID         string
	attemptN       int
	conversationID string
	beforeEntryID  string
	limit          int
	limitSet       bool
	format         string
	follow         bool
	intervalSec    int
	out            io.Writer
	errOut         io.Writer
	// sleep waits between follow polls; tests replace it.
	sleep func(ctx context.Context, d time.Duration) error
}

func runTaskConversationsListCmd(ctx context.Context, opts taskConversationsListOpts) error {
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskConversationsListWithClient(ctx, client, opts)
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

func runTaskConversationsGetCmd(ctx context.Context, opts taskConversationsGetOpts) error {
	if err := validateConversationGetOpts(opts); err != nil {
		return err
	}
	client, err := newAuthenticatedClient(opts.apiURL, opts.credPath, opts.teamID)
	if err != nil {
		return err
	}
	return runTaskConversationsGetWithClient(ctx, client, opts)
}

func validateConversationGetOpts(opts taskConversationsGetOpts) error {
	if opts.format != "human" && opts.format != "json" {
		return fmt.Errorf("--format: unsupported value %q (one of: human, json)", opts.format)
	}
	if opts.follow && opts.beforeEntryID != "" {
		return fmt.Errorf("--follow reads the latest entries; it cannot be combined with --before-entry-id")
	}
	if opts.follow {
		if err := validatePollInterval(opts.intervalSec); err != nil {
			return err
		}
	}
	if opts.limitSet && (opts.limit < 1 || opts.limit > maxConversationPageLimit) {
		return fmt.Errorf("--limit must be between 1 and %d, got %d", maxConversationPageLimit, opts.limit)
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
	attemptN, err := retryConversationRead(ctx, opts, func() (int, error) {
		return resolveAttempt(ctx, client, taskID, moltnetapi.NewOptUUID(teamID), opts.attemptN)
	})
	if err != nil {
		return err
	}
	conversationID := opts.conversationID
	if conversationID == "" {
		conversationID, err = retryConversationRead(ctx, opts, func() (string, error) {
			return mainConversationID(ctx, client, taskID, teamID, attemptN)
		})
		if errors.Is(err, errNoConversation) && opts.follow {
			conversationID, err = awaitMainConversation(ctx, client, taskID, teamID, attemptN, opts)
		}
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
	if opts.limitSet {
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
// printing each committed message once. It starts from the latest page; later
// polls page back to the last printed message, so a burst larger than one
// page between polls is not skipped. The in-progress partial response is
// not printed while it streams; a partial left on the final snapshot is
// printed (it is then interrupted). Polling instead of SSE keeps the CLI on
// the generated client, which does not model the event stream.
func followConversation(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskConversationParams, opts taskConversationsGetOpts) error {
	sleep := followSleep(opts)
	interval := time.Duration(opts.intervalSec) * time.Second
	wait := interval
	var lastEntry uint64
	first := true
	for {
		var terminal bool
		messages, err := retryConversationRead(ctx, opts, func() ([]moltnetapi.GetTaskConversationOKMessagesItem, error) {
			messages, done, err := pollConversation(ctx, client, params, lastEntry, first)
			terminal = done
			return messages, err
		})
		if err != nil {
			return err
		}

		first = false
		printed := false
		nextEntry := lastEntry
		for _, message := range messages {
			entry, committed := message.EntryId.Get()
			var id uint64
			if committed {
				id, err = strconv.ParseUint(entry, 10, 64)
				if err != nil {
					return fmt.Errorf("invalid conversation entry ID %q: %w", entry, err)
				}
			}
			if (committed && id <= lastEntry) || (!committed && !terminal) {
				continue
			}
			nextEntry = max(nextEntry, id)
			printed = true
			if err := printFollowedMessage(opts, message); err != nil {
				return err
			}
		}
		lastEntry = nextEntry
		if terminal {
			return nil
		}
		if printed {
			wait = interval
		} else if wait < maxFollowIdleBackoff*interval {
			wait = min(wait*2, maxFollowIdleBackoff*interval)
		}
		if err := sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// pollConversation reads the latest page; after the first poll it also pages
// back to the last printed message.
func pollConversation(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskConversationParams, lastEntry uint64, first bool) ([]moltnetapi.GetTaskConversationOKMessagesItem, bool, error) {
	snapshot, err := getConversation(ctx, client, params)
	if err != nil {
		return nil, false, err
	}
	terminal := !isLiveAttemptStatus(snapshot.AttemptStatus)
	if first {
		return snapshot.Messages, terminal, nil
	}
	messages, err := withUnseenOlderPages(ctx, client, params, snapshot, lastEntry)
	return messages, terminal, err
}

// retryConversationRead applies the same bounded retry policy during discovery
// and following. Non-follow reads and a not-yet-created conversation return immediately.
func retryConversationRead[T any](ctx context.Context, opts taskConversationsGetOpts, read func() (T, error)) (T, error) {
	for failures := 0; ; failures++ {
		value, err := read()
		if err == nil || !opts.follow || errors.Is(err, errNoConversation) || !isTransientPollError(ctx, err) || failures >= maxFollowRetries {
			return value, err
		}
		fmt.Fprintf(followErrOut(opts), "conversation poll failed (%d/%d), retrying: %v\n", failures+1, maxFollowRetries, err)
		if err := followSleep(opts)(ctx, time.Duration(opts.intervalSec)*time.Second); err != nil {
			return value, err
		}
	}
}

// isTransientPollError reports failures a later poll may not hit: rate
// limits, server errors, network failures and truncated response bodies.
func isTransientPollError(ctx context.Context, err error) bool {
	if ctx.Err() != nil {
		return false
	}
	status, ok := apiErrorStatus(err)
	if !ok {
		var networkError net.Error
		return errors.As(err, &networkError) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
	}
	return status == 408 || status == 429 || status >= 500
}

// awaitMainConversation waits for a live attempt to open its Durable store.
func awaitMainConversation(ctx context.Context, client *moltnetapi.Client, taskID, teamID uuid.UUID, attemptN int, opts taskConversationsGetOpts) (string, error) {
	sleep := followSleep(opts)
	announced := false
	for {
		live, err := retryConversationRead(ctx, opts, func() (bool, error) {
			return attemptIsLive(ctx, client, taskID, teamID, attemptN)
		})
		if err != nil {
			return "", err
		}
		if !live {
			return retryConversationRead(ctx, opts, func() (string, error) {
				return mainConversationID(ctx, client, taskID, teamID, attemptN)
			})
		}
		if !announced {
			fmt.Fprintf(followErrOut(opts), "waiting for attempt %d to open its Durable conversation…\n", attemptN)
			announced = true
		}
		if err := sleep(ctx, time.Duration(opts.intervalSec)*time.Second); err != nil {
			return "", err
		}
		id, err := retryConversationRead(ctx, opts, func() (string, error) {
			return mainConversationID(ctx, client, taskID, teamID, attemptN)
		})
		if !errors.Is(err, errNoConversation) {
			return id, err
		}
	}
}

func attemptIsLive(ctx context.Context, client *moltnetapi.Client, taskID, teamID uuid.UUID, attemptN int) (bool, error) {
	res, err := client.ListTaskAttempts(ctx, moltnetapi.ListTaskAttemptsParams{ID: taskID, XMoltnetTeamID: moltnetapi.NewOptUUID(teamID)})
	if err != nil {
		return false, fmt.Errorf("list attempts: %w", formatTransportError(err))
	}
	attempts, ok := res.(*moltnetapi.ListTaskAttemptsOKApplicationJSON)
	if !ok {
		return false, formatAPIError(res)
	}
	for _, attempt := range *attempts {
		if int(attempt.AttemptN) == attemptN {
			return isLiveAttemptStatus(string(attempt.Status)), nil
		}
	}
	return false, fmt.Errorf("task %s has no attempt %d", taskID, attemptN)
}

func followSleep(opts taskConversationsGetOpts) func(context.Context, time.Duration) error {
	if opts.sleep != nil {
		return opts.sleep
	}
	return retrySleep
}

func followErrOut(opts taskConversationsGetOpts) io.Writer {
	if opts.errOut != nil {
		return opts.errOut
	}
	return io.Discard
}

// withUnseenOlderPages prepends older pages until the cursor reaches the last
// committed entry printed, or the conversation starts. Messages are returned oldest first.
func withUnseenOlderPages(ctx context.Context, client *moltnetapi.Client, params moltnetapi.GetTaskConversationParams, snapshot *moltnetapi.GetTaskConversationOK, lastEntry uint64) ([]moltnetapi.GetTaskConversationOKMessagesItem, error) {
	pages := [][]moltnetapi.GetTaskConversationOKMessagesItem{snapshot.Messages}
	next := snapshot.NextBeforeEntryId
	for {
		before, ok := next.Get()
		if !ok {
			break
		}
		boundary, err := strconv.ParseUint(before, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid conversation cursor %q: %w", before, err)
		}
		// The cursor is exclusive; entries at or below the checkpoint were printed.
		if boundary <= lastEntry+1 {
			break
		}
		older := params
		older.BeforeEntryId = moltnetapi.NewOptString(before)
		page, err := getConversation(ctx, client, older)
		if err != nil {
			return nil, err
		}
		pages = append(pages, page.Messages)
		next = page.NextBeforeEntryId
	}
	var messages []moltnetapi.GetTaskConversationOKMessagesItem
	for i := len(pages) - 1; i >= 0; i-- {
		messages = append(messages, pages[i]...)
	}
	return messages, nil
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
	return status == string(moltnetapi.TaskAttemptStatusClaimed) || status == string(moltnetapi.TaskAttemptStatusRunning)
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
	list, ok := res.(*moltnetapi.ListTaskConversationsOK)
	if !ok {
		return nil, formatAPIError(res)
	}
	return list, nil
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
	if len(list.Items) == 0 {
		// The API lists nothing until the attempt opens a Durable store.
		return "", fmt.Errorf("attempt %d of task %s has %w yet (attempts recorded before Durable only have task messages: use `moltnet task tail --since 0`)", attemptN, taskID, errNoConversation)
	}
	kinds := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		kinds = append(kinds, string(item.Kind)+" "+item.ConversationId)
	}
	return "", fmt.Errorf("attempt %d of task %s has no main conversation yet (found: %s); pass --conversation <id>", attemptN, taskID, strings.Join(kinds, ", "))
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

	label := terminalSafe(role)
	if role == "toolResult" {
		label = "tool result: " + terminalSafe(toolName)
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
			if role == "toolResult" {
				if head, rest := truncateRunes(part.Text, conversationResultLimit); rest > 0 {
					fmt.Fprintf(&b, "%s… (%d more characters; use --format json)\n", terminalSafe(head), rest)
					continue
				}
			}
			b.WriteString(terminalSafe(part.Text) + "\n")
		case "toolCall":
			args := string(part.Arguments)
			if args == "" {
				args = "{}"
			}
			fmt.Fprintf(&b, "→ %s %s\n", terminalSafe(part.Name), terminalSafe(args))
		case "image":
			b.WriteString("[image]\n")
		}
	}
	b.WriteString("\n")
	_, err := io.WriteString(out, b.String())
	return err
}

// truncateRunes cuts s to at most limit runes, returning how many were cut.
func truncateRunes(s string, limit int) (string, int) {
	total := utf8.RuneCountInString(s)
	if total <= limit {
		return s, 0
	}
	cut := 0
	for i := 0; i < limit; i++ {
		_, size := utf8.DecodeRuneInString(s[cut:])
		cut += size
	}
	return s[:cut], total - limit
}

// terminalSafe escapes control characters other than newline and tab.
// Conversation text includes tool output the agent read, which may carry
// escape sequences that would otherwise drive the reader's terminal.
func terminalSafe(s string) string {
	if strings.IndexFunc(s, isUnsafeTerminalRune) < 0 {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		if isUnsafeTerminalRune(r) {
			fmt.Fprintf(&b, "\\u%04x", r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func isUnsafeTerminalRune(r rune) bool {
	return r != '\n' && r != '\t' && (unicode.IsControl(r) || r == utf8.RuneError)
}
