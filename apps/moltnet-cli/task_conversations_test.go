package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-faster/jx"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
)

const (
	convTaskID = "11111111-1111-4111-8111-111111111111"
	convTeamID = "22222222-2222-4222-8222-222222222222"
)

type stubConversationHandler struct {
	moltnetapi.UnimplementedHandler

	mu         sync.Mutex
	list       moltnetapi.ListTaskConversationsRes
	snapshots  []*moltnetapi.GetTaskConversationOK
	getCalls   int
	lastParams moltnetapi.GetTaskConversationParams
}

func (h *stubConversationHandler) ListTaskConversations(_ context.Context, _ moltnetapi.ListTaskConversationsParams) (moltnetapi.ListTaskConversationsRes, error) {
	return h.list, nil
}

func (h *stubConversationHandler) GetTaskConversation(_ context.Context, params moltnetapi.GetTaskConversationParams) (moltnetapi.GetTaskConversationRes, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastParams = params
	i := h.getCalls
	if i >= len(h.snapshots) {
		i = len(h.snapshots) - 1
	}
	h.getCalls++
	return h.snapshots[i], nil
}

func mainList() *moltnetapi.ListTaskConversationsOK {
	main := moltnetapi.ListTaskConversationsOKItemsItem{ConversationId: "3", Kind: moltnetapi.ListTaskConversationsOKItemsItemKindMain}
	main.ParentConversationId.SetToNull()
	return &moltnetapi.ListTaskConversationsOK{Items: []moltnetapi.ListTaskConversationsOKItemsItem{
		{ConversationId: "7", Kind: moltnetapi.ListTaskConversationsOKItemsItemKindSubagent, ParentConversationId: moltnetapi.NewNilString("3")},
		main,
	}}
}

func rawMessage(t *testing.T, fields map[string]any) moltnetapi.GetTaskConversationOKMessagesItemMessage {
	t.Helper()
	out := moltnetapi.GetTaskConversationOKMessagesItemMessage{}
	for key, value := range fields {
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		out[key] = jx.Raw(b)
	}
	return out
}

func convMessage(t *testing.T, id string, entryID string, status moltnetapi.GetTaskConversationOKMessagesItemStatus, fields map[string]any) moltnetapi.GetTaskConversationOKMessagesItem {
	t.Helper()
	item := moltnetapi.GetTaskConversationOKMessagesItem{
		ID:        id,
		EntryKind: "pi.message",
		Status:    status,
		Message:   rawMessage(t, fields),
	}
	if entryID != "" {
		item.EntryId = moltnetapi.NewNilString(entryID)
	} else {
		item.EntryId.SetToNull()
	}
	return item
}

func convSnapshot(status string, next string, messages ...moltnetapi.GetTaskConversationOKMessagesItem) *moltnetapi.GetTaskConversationOK {
	s := &moltnetapi.GetTaskConversationOK{
		AttemptStatus:  status,
		ConversationId: "3",
		Cursor:         status,
		Live:           moltnetapi.GetTaskConversationOKLive{},
		Messages:       messages,
	}
	if next != "" {
		s.NextBeforeEntryId = moltnetapi.NewNilString(next)
	} else {
		s.NextBeforeEntryId.SetToNull()
	}
	return s
}

func TestTaskConversationsGet_RendersMainConversation(t *testing.T) {
	completed := moltnetapi.GetTaskConversationOKMessagesItemStatusCompleted
	inherited := convMessage(t, "1/0", "1", completed, map[string]any{
		"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Earlier work"}},
	})
	inherited.Inherited = true
	h := &stubConversationHandler{
		list: mainList(),
		snapshots: []*moltnetapi.GetTaskConversationOK{convSnapshot("completed", "1",
			inherited,
			convMessage(t, "2/0", "2", completed, map[string]any{"role": "user", "content": "Summarise the diff"}),
			convMessage(t, "3/0", "3", completed, map[string]any{
				"role": "assistant",
				"content": []any{
					map[string]any{"type": "text", "text": "Reading it."},
					map[string]any{"type": "toolCall", "id": "c1", "name": "read_file", "arguments": map[string]any{"path": "a.ts"}},
				},
			}),
			convMessage(t, "4/0", "4", completed, map[string]any{
				"role": "toolResult", "toolCallId": "c1", "toolName": "read_file", "isError": true,
				"content": []any{map[string]any{"type": "text", "text": "ENOENT"}},
			}),
			convMessage(t, "partial/3", "", moltnetapi.GetTaskConversationOKMessagesItemStatusInterrupted, map[string]any{
				"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Half a"}},
			}),
		)},
	}
	_, _, client := newTestServer(t, h)
	var out bytes.Buffer

	err := runTaskConversationsGetWithClient(context.Background(), client, taskConversationsGetOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 1, format: "human", out: &out,
	})

	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if h.lastParams.ConversationId != "3" {
		t.Fatalf("expected the main conversation 3, got %q", h.lastParams.ConversationId)
	}
	for _, want := range []string{
		"[assistant] (inherited from an earlier attempt)\nEarlier work",
		"[user]\nSummarise the diff",
		"Reading it.\n→ read_file {\"path\":\"a.ts\"}",
		"[tool result: read_file] (error)\nENOENT",
		"[assistant] (interrupted)\nHalf a",
		"(older entries exist: pass --before-entry-id 1)",
	} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("output missing %q\n---\n%s", want, out.String())
		}
	}
}

func TestTaskConversationsGet_PassesPagingAndConversation(t *testing.T) {
	h := &stubConversationHandler{
		list:      mainList(),
		snapshots: []*moltnetapi.GetTaskConversationOK{convSnapshot("completed", "")},
	}
	_, _, client := newTestServer(t, h)
	var out bytes.Buffer

	err := runTaskConversationsGetWithClient(context.Background(), client, taskConversationsGetOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 2, conversationID: "7",
		beforeEntryID: "42", limit: 10, format: "json", out: &out,
	})

	if err != nil {
		t.Fatalf("get: %v", err)
	}
	p := h.lastParams
	if p.ConversationId != "7" || p.N != 2 || p.BeforeEntryId.Value != "42" || p.Limit.Value != 10 {
		t.Fatalf("unexpected params: %+v", p)
	}
	var decoded map[string]any
	if err := json.Unmarshal(out.Bytes(), &decoded); err != nil {
		t.Fatalf("json output is not JSON: %v\n%s", err, out.String())
	}
	if decoded["attemptStatus"] != "completed" {
		t.Fatalf("unexpected json: %s", out.String())
	}
}

func TestTaskConversationsGet_FollowPrintsCommittedMessagesOnce(t *testing.T) {
	completed := moltnetapi.GetTaskConversationOKMessagesItemStatusCompleted
	streaming := moltnetapi.GetTaskConversationOKMessagesItemStatusStreaming
	first := convMessage(t, "1/0", "1", completed, map[string]any{"role": "assistant", "content": "First"})
	second := convMessage(t, "2/0", "2", completed, map[string]any{"role": "assistant", "content": "Second"})
	typing := convMessage(t, "partial/3", "", streaming, map[string]any{"role": "assistant", "content": "Typing"})
	h := &stubConversationHandler{
		list: mainList(),
		snapshots: []*moltnetapi.GetTaskConversationOK{
			convSnapshot("running", "", first, typing),
			convSnapshot("running", "", first, second, typing),
			convSnapshot("completed", "", first, second),
		},
	}
	_, _, client := newTestServer(t, h)
	var out bytes.Buffer
	sleeps := 0

	err := runTaskConversationsGetWithClient(context.Background(), client, taskConversationsGetOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 1, format: "json",
		follow: true, intervalSec: 1, out: &out,
		sleep: func(context.Context, time.Duration) error { sleeps++; return nil },
	})

	if err != nil {
		t.Fatalf("follow: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"1/0"`) || !strings.Contains(lines[1], `"2/0"`) {
		t.Fatalf("expected each committed message once, got:\n%s", out.String())
	}
	if strings.Contains(out.String(), "Typing") {
		t.Fatalf("a streaming partial must not be printed:\n%s", out.String())
	}
	if !strings.Contains(lines[0], `"content":"First"`) {
		t.Fatalf("message JSON must keep raw fields, got %s", lines[0])
	}
	if sleeps != 2 || h.getCalls != 3 {
		t.Fatalf("expected 3 polls and 2 sleeps, got %d polls, %d sleeps", h.getCalls, sleeps)
	}
}

func TestTaskConversationsGet_FollowPrintsInterruptedPartialAtEnd(t *testing.T) {
	interrupted := convMessage(t, "partial/3", "", moltnetapi.GetTaskConversationOKMessagesItemStatusInterrupted,
		map[string]any{"role": "assistant", "content": "Cut off"})
	h := &stubConversationHandler{
		list:      mainList(),
		snapshots: []*moltnetapi.GetTaskConversationOK{convSnapshot("failed", "", interrupted)},
	}
	_, _, client := newTestServer(t, h)
	var out bytes.Buffer

	err := runTaskConversationsGetWithClient(context.Background(), client, taskConversationsGetOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 1, format: "human",
		follow: true, intervalSec: 1, out: &out,
	})

	if err != nil {
		t.Fatalf("follow: %v", err)
	}
	if !strings.Contains(out.String(), "[assistant] (interrupted)\nCut off") {
		t.Fatalf("expected the interrupted partial, got:\n%s", out.String())
	}
}

func TestTaskConversationsGet_NoConversationExplainsLegacyAttempts(t *testing.T) {
	// An attempt that never opened a Durable store lists no conversations.
	h := &stubConversationHandler{list: &moltnetapi.ListTaskConversationsOK{Items: []moltnetapi.ListTaskConversationsOKItemsItem{}}}
	_, _, client := newTestServer(t, h)

	err := runTaskConversationsGetWithClient(context.Background(), client, taskConversationsGetOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 1, format: "human", out: &bytes.Buffer{},
	})

	if err == nil || !strings.Contains(err.Error(), "moltnet task tail") {
		t.Fatalf("expected a pointer to task tail, got %v", err)
	}
}

func TestTaskConversationsGet_RejectsFollowWithPaging(t *testing.T) {
	err := validateConversationGetOpts(taskConversationsGetOpts{
		format: "human", follow: true, intervalSec: 1, beforeEntryID: "5",
	})

	if err == nil || !strings.Contains(err.Error(), "--before-entry-id") {
		t.Fatalf("expected a --follow/--before-entry-id conflict, got %v", err)
	}
}

func TestTaskConversationsList_PrintsConversations(t *testing.T) {
	h := &stubConversationHandler{list: mainList()}
	_, _, client := newTestServer(t, h)
	var out bytes.Buffer

	err := runTaskConversationsListWithClient(context.Background(), client, taskConversationsListOpts{
		taskID: convTaskID, teamID: convTeamID, attemptN: 1, out: &out,
	})

	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !strings.Contains(out.String(), `"subagent"`) || !strings.Contains(out.String(), `"main"`) {
		t.Fatalf("unexpected list output:\n%s", out.String())
	}
}
