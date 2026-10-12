//go:build e2e

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-faster/jx"
	"github.com/google/uuid"
	gocid "github.com/ipfs/go-cid"
	"github.com/multiformats/go-multihash"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
)

// durableConversation is a task attempt whose Durable store holds the
// committed pi-durable writes from testdata/durable-conversation-commits.json.
// Regenerate with: pnpm exec nx run @moltnet/bootstrap:generate:durable-fixture
type durableConversation struct {
	taskID   uuid.UUID
	teamID   string
	attemptN int
}

// expectRes fails the test unless the generated client returned want.
// Seeding goes through the typed client so the CLI is the only code under
// test and request shapes are checked at compile time.
func expectRes[T any](t *testing.T, op string, res any, err error) T {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", op, formatTransportError(err))
	}
	want, ok := res.(T)
	if !ok {
		t.Fatalf("%s = %T: %v", op, res, formatAPIError(res))
	}
	return want
}

// rawObject encodes each value of a free-form JSON object.
func rawObject(t *testing.T, fields map[string]any) map[string]jx.Raw {
	t.Helper()
	out := make(map[string]jx.Raw, len(fields))
	for key, value := range fields {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encode %s: %v", key, err)
		}
		out[key] = raw
	}
	return out
}

// executorManifestCID matches computeExecutorManifestCid in
// libs/crypto-service: a raw CIDv1 over the SHA-256 of canonical JSON.
func executorManifestCID(t *testing.T, manifest map[string]any) string {
	t.Helper()
	canonical, err := CanonicalJSON(manifest)
	if err != nil {
		t.Fatalf("canonical manifest: %v", err)
	}
	hash := sha256.Sum256([]byte(canonical))
	mh, err := multihash.Encode(hash[:], multihash.SHA2_256)
	if err != nil {
		t.Fatalf("multihash: %v", err)
	}
	return gocid.NewCidV1(0x55, mh).String()
}

// createE2ETask creates a fulfill_brief task, optionally pinned to profiles.
func createE2ETask(t *testing.T, title string, profiles ...uuid.UUID) uuid.UUID {
	t.Helper()
	req := &moltnetapi.CreateTaskReq{
		TaskType: "fulfill_brief",
		Title:    moltnetapi.NewOptString(title),
		DiaryId:  e2eDiaryID,
		Input:    rawObject(t, map[string]any{"brief": title}),
	}
	for _, id := range profiles {
		req.AllowedProfiles = append(req.AllowedProfiles, moltnetapi.RuntimeProfileRef{ProfileId: id})
	}
	res, err := e2eClient.CreateTask(context.Background(), req, moltnetapi.CreateTaskParams{XMoltnetTeamID: e2ePersonalTeamID})
	return expectRes[*moltnetapi.Task](t, "create task", res, err).ID
}

// seedDurableConversation claims a task under a runtime profile (only pinned
// claims carry the lease a Durable store requires) and commits the fixture.
func seedDurableConversation(t *testing.T) durableConversation {
	t.Helper()
	ctx := context.Background()
	team := moltnetapi.NewOptUUID(e2ePersonalTeamID)

	profileRes, err := e2eClient.CreateRuntimeProfile(ctx, moltnetapi.NewOptCreateRuntimeProfileBody(moltnetapi.CreateRuntimeProfileBody{
		Name: "cli-conversations-" + uuid.NewString(),
		Models: moltnetapi.CreateRuntimeProfileBodyModels{
			Generation: moltnetapi.NewOptCreateRuntimeProfileBodyModelsGeneration(moltnetapi.CreateRuntimeProfileBodyModelsGeneration{
				Provider: "anthropic", Model: "claude-sonnet-4-5",
			}),
		},
		Sandbox: moltnetapi.CreateRuntimeProfileBodySandbox{
			HostExec: moltnetapi.NewOptCreateRuntimeProfileBodySandboxHostExec(moltnetapi.CreateRuntimeProfileBodySandboxHostExec{
				AutoApprove: moltnetapi.NewOptCreateRuntimeProfileBodySandboxHostExecAutoApprove(moltnetapi.CreateRuntimeProfileBodySandboxHostExecAutoApproveFalse),
			}),
			Resources: moltnetapi.NewOptCreateRuntimeProfileBodySandboxResources(moltnetapi.CreateRuntimeProfileBodySandboxResources{
				Cpus: moltnetapi.NewOptInt(2), Memory: moltnetapi.NewOptString("2G"),
			}),
		},
	}), moltnetapi.CreateRuntimeProfileParams{XMoltnetTeamID: team})
	profile := expectRes[*moltnetapi.RuntimeProfile](t, "create runtime profile", profileRes, err)

	taskID := createE2ETask(t, "CLI conversation read", profile.ID)

	manifest := map[string]any{
		"schemaVersion": "moltnet:executor-manifest:v1",
		"runtime": map[string]any{
			"kind": profile.RuntimeKind, "engine": "pi", "sandbox": "gondolin",
			"id": "cli-conversations-e2e", "version": "1",
		},
		"profile": map[string]any{"id": profile.ID.String(), "definitionCid": profile.DefinitionCid},
		"vm": map[string]any{
			"templateId": "cli-conversations-e2e", "templateVersion": "1",
			"templateFingerprint": "bafyreie2e-template", "guestAssetBuildId": "cli-conversations-e2e",
		},
		"tools":       []any{},
		"extensions":  []any{},
		"executables": []any{},
	}
	fingerprint := executorManifestCID(t, manifest)
	signature, err := SignExecutorAttestation(map[string]any{
		"v":                   executorAttestationVersion,
		"phase":               "register",
		"executorFingerprint": fingerprint,
	}, e2eCreds.Keys.PrivateKey)
	if err != nil {
		t.Fatalf("sign registration: %v", err)
	}
	registerRes, err := e2eClient.RegisterExecutorManifest(ctx, &moltnetapi.RegisterExecutorManifestReq{
		ExecutorManifest:    rawObject(t, manifest),
		ExecutorFingerprint: fingerprint,
		ExecutorSignature:   signature,
	})
	expectRes[*moltnetapi.RegisterExecutorManifestOK](t, "register executor manifest", registerRes, err)

	claimRes, err := e2eClient.ClaimTask(ctx, moltnetapi.NewOptClaimTaskReq(moltnetapi.ClaimTaskReq{
		LeaseTtlSec:         moltnetapi.NewOptInt(300),
		ProfileId:           moltnetapi.NewOptUUID(profile.ID),
		ExecutorFingerprint: moltnetapi.NewOptString(fingerprint),
	}), moltnetapi.ClaimTaskParams{ID: taskID, XMoltnetTeamID: team})
	attempt := expectRes[*moltnetapi.ClaimTaskResponseHeaders](t, "claim task", claimRes, err).Response.Attempt
	leaseID, ok := attempt.LeaseId.Get()
	if !ok {
		t.Fatal("pinned claim returned no lease")
	}
	attemptN := int(attempt.AttemptN)

	openRes, err := e2eClient.OpenRuntimeStore(ctx, &moltnetapi.OpenRuntimeStoreReq{
		TaskId: taskID, AttemptN: attemptN, LeaseId: leaseID, ExecutorFingerprint: fingerprint,
	}, moltnetapi.OpenRuntimeStoreParams{XMoltnetTeamID: e2ePersonalTeamID})
	store := expectRes[*moltnetapi.OpenRuntimeStoreOK](t, "open runtime store", openRes, err)

	raw, err := os.ReadFile("testdata/durable-conversation-commits.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var commits [][]moltnetapi.AppendRuntimeStoreCommitReqWritesItem
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(raw), "__TASK_ID__", taskID.String())), &commits); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	head := store.HeadSeq
	for i, writes := range commits {
		appendRes, err := e2eClient.AppendRuntimeStoreCommit(ctx, &moltnetapi.AppendRuntimeStoreCommitReq{
			TaskId: taskID, AttemptN: attemptN, LeaseId: leaseID, ExecutorFingerprint: fingerprint,
			WriterToken: store.WriterToken, CommitId: uuid.New(), ExpectedSeq: head, Writes: writes,
		}, moltnetapi.AppendRuntimeStoreCommitParams{StoreId: store.StoreId, XMoltnetTeamID: e2ePersonalTeamID})
		head = expectRes[*moltnetapi.AppendRuntimeStoreCommitOK](t, fmt.Sprintf("append commit %d", i+1), appendRes, err).Seq
	}
	return durableConversation{taskID: taskID, teamID: e2ePersonalTeamID.String(), attemptN: attemptN}
}

type cliConversationMessage struct {
	EntryID   *string         `json:"entryId"`
	Inherited bool            `json:"inherited"`
	Status    string          `json:"status"`
	Message   json.RawMessage `json:"message"`
}

func (m cliConversationMessage) role(t *testing.T) string {
	t.Helper()
	var message struct {
		Role string `json:"role"`
	}
	if err := json.Unmarshal(m.Message, &message); err != nil {
		t.Fatalf("decode message: %v", err)
	}
	return message.Role
}

type cliConversationSnapshot struct {
	ConversationID    string                   `json:"conversationId"`
	AttemptStatus     string                   `json:"attemptStatus"`
	Messages          []cliConversationMessage `json:"messages"`
	NextBeforeEntryID *string                  `json:"nextBeforeEntryId"`
}

func TestE2E_CLI_TaskConversations(t *testing.T) {
	binPath, err := ensureE2ECLIBinary()
	if err != nil {
		t.Fatalf("build CLI: %v", err)
	}
	credsPath, err := writeE2ECredsFile(e2eCreds)
	if err != nil {
		t.Fatalf("write credentials: %v", err)
	}
	seeded := seedDurableConversation(t)
	cli := func(args ...string) (string, string, error) {
		base := []string{"task", "conversations"}
		return runE2eCLIWithAuthAtURL(binPath, credsPath, "", e2eAPIURL, append(base, args...)...)
	}
	getJSON := func(t *testing.T, args ...string) cliConversationSnapshot {
		t.Helper()
		stdout, stderr, err := cli(append([]string{"get", seeded.taskID.String(), "--team-id", seeded.teamID, "--format", "json"}, args...)...)
		if err != nil {
			t.Fatalf("conversations get %v: %v\nstderr: %s", args, err, stderr)
		}
		var snapshot cliConversationSnapshot
		if err := json.Unmarshal([]byte(stdout), &snapshot); err != nil {
			t.Fatalf("decode stdout: %v\nstdout: %s", err, stdout)
		}
		return snapshot
	}

	t.Run("list returns the main conversation", func(t *testing.T) {
		stdout, stderr, err := cli("list", seeded.taskID.String(), "--team-id", seeded.teamID)
		if err != nil {
			t.Fatalf("conversations list: %v\nstderr: %s", err, stderr)
		}
		var list struct {
			Items []struct {
				ConversationID       string  `json:"conversationId"`
				ParentConversationID *string `json:"parentConversationId"`
				Kind                 string  `json:"kind"`
			} `json:"items"`
		}
		if err := json.Unmarshal([]byte(stdout), &list); err != nil {
			t.Fatalf("decode stdout: %v\nstdout: %s", err, stdout)
		}
		if len(list.Items) != 1 || list.Items[0].Kind != "main" || list.Items[0].ParentConversationID != nil {
			t.Fatalf("unexpected conversations: %s", stdout)
		}
	})

	t.Run("get prints the transcript with tool calls and results", func(t *testing.T) {
		stdout, stderr, err := cli("get", seeded.taskID.String(), "--team-id", seeded.teamID)
		if err != nil {
			t.Fatalf("conversations get: %v\nstderr: %s", err, stderr)
		}
		want := []string{
			"[user]\nList the workspace.\n",
			"[assistant]\nListing files.\n→ bash {\"command\":\"ls\"}\n",
			"[tool result: bash]\nREADME.md\n",
			"[assistant]\nThe workspace holds README.md.\n",
		}
		rest := stdout
		for _, block := range want {
			i := strings.Index(rest, block)
			if i < 0 {
				t.Fatalf("missing %q in order\nstdout:\n%s", block, stdout)
			}
			rest = rest[i+len(block):]
		}
		if strings.Contains(stdout, "older entries exist") {
			t.Errorf("full page announced older entries:\n%s", stdout)
		}
	})

	t.Run("get json carries this attempt's committed messages", func(t *testing.T) {
		snapshot := getJSON(t, "--attempt", fmt.Sprint(seeded.attemptN))
		var roles []string
		for _, message := range snapshot.Messages {
			roles = append(roles, message.role(t))
			if message.Inherited || message.EntryID == nil || message.Status != "completed" {
				t.Errorf("unexpected message metadata: %+v", message)
			}
		}
		if got := strings.Join(roles, ","); got != "user,assistant,toolResult,assistant" {
			t.Fatalf("roles = %s", got)
		}
		if snapshot.NextBeforeEntryID != nil {
			t.Errorf("nextBeforeEntryId = %s, want null", *snapshot.NextBeforeEntryID)
		}
		if snapshot.AttemptStatus != "claimed" && snapshot.AttemptStatus != "running" {
			t.Errorf("attemptStatus = %s, want live", snapshot.AttemptStatus)
		}
	})

	t.Run("pages back with before-entry-id", func(t *testing.T) {
		first := getJSON(t, "--limit", "1")
		if len(first.Messages) != 1 || first.Messages[0].role(t) != "assistant" || first.NextBeforeEntryID == nil {
			t.Fatalf("first page = %+v", first)
		}
		second := getJSON(t, "--limit", "1", "--before-entry-id", *first.NextBeforeEntryID)
		if len(second.Messages) != 1 || second.Messages[0].role(t) != "toolResult" {
			t.Fatalf("second page = %+v", second)
		}

		stdout, stderr, err := cli("get", seeded.taskID.String(), "--team-id", seeded.teamID, "--limit", "1")
		if err != nil {
			t.Fatalf("conversations get --limit 1: %v\nstderr: %s", err, stderr)
		}
		if !strings.Contains(stdout, "(older entries exist: pass --before-entry-id "+*first.NextBeforeEntryID+")") {
			t.Errorf("human page did not point at older entries:\n%s", stdout)
		}
	})

	t.Run("rejects an unknown conversation", func(t *testing.T) {
		_, stderr, err := cli("get", seeded.taskID.String(), "--team-id", seeded.teamID, "--conversation", "999999")
		if err == nil {
			t.Fatalf("expected failure for an unknown conversation; stderr: %s", stderr)
		}
		if !strings.Contains(stderr, "Not Found") {
			t.Errorf("stderr does not report the conversation as not found: %s", stderr)
		}
	})

	t.Run("explains attempts without a Durable conversation", func(t *testing.T) {
		taskID := createE2ETask(t, "CLI conversation absent")
		claimRes, err := e2eClient.ClaimTask(context.Background(),
			moltnetapi.NewOptClaimTaskReq(moltnetapi.ClaimTaskReq{LeaseTtlSec: moltnetapi.NewOptInt(60)}),
			moltnetapi.ClaimTaskParams{ID: taskID, XMoltnetTeamID: moltnetapi.NewOptUUID(e2ePersonalTeamID)})
		expectRes[*moltnetapi.ClaimTaskResponseHeaders](t, "claim task", claimRes, err)

		// Until an attempt opens a Durable store, the API lists no conversations.
		stdout, stderr, err := cli("list", taskID.String(), "--team-id", seeded.teamID)
		if err != nil {
			t.Fatalf("conversations list: %v\nstderr: %s", err, stderr)
		}
		var list struct {
			Items []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal([]byte(stdout), &list); err != nil {
			t.Fatalf("decode list: %v\n%s", err, stdout)
		}
		if len(list.Items) != 0 {
			t.Fatalf("items = %s, want none", stdout)
		}

		_, stderr, err = cli("get", taskID.String(), "--team-id", seeded.teamID)
		if err == nil {
			t.Fatal("expected get to fail for an attempt without a Durable store")
		}
		if !strings.Contains(stderr, "has no Durable conversation yet") {
			t.Errorf("stderr does not explain the missing conversation: %s", stderr)
		}
	})

	// Runs last: it ends the attempt.
	t.Run("follow streams committed messages until the attempt ends", func(t *testing.T) {
		var (
			wg             sync.WaitGroup
			stdout, stderr string
			runErr         error
		)
		wg.Add(1)
		go func() {
			defer wg.Done()
			stdout, stderr, runErr = cli("get", seeded.taskID.String(), "--team-id", seeded.teamID, "--follow", "--interval", "1", "--format", "json")
		}()
		// Let the follower print the committed messages while the attempt is live.
		time.Sleep(3 * time.Second)
		// An attempt can only fail once a heartbeat has started it.
		ctx := context.Background()
		team := moltnetapi.NewOptUUID(e2ePersonalTeamID)
		heartbeatRes, err := e2eClient.TaskHeartbeat(ctx, moltnetapi.OptTaskHeartbeatReq{},
			moltnetapi.TaskHeartbeatParams{ID: seeded.taskID, N: seeded.attemptN, XMoltnetTeamID: team})
		expectRes[*moltnetapi.HeartbeatResponse](t, "heartbeat", heartbeatRes, err)
		failRes, err := e2eClient.FailTaskAttempt(ctx, &moltnetapi.FailTaskAttemptReq{Error: moltnetapi.TaskError{
			Code: "e2e_finished", Message: "follow test ends the attempt", Retryable: moltnetapi.NewOptBool(false),
		}}, moltnetapi.FailTaskAttemptParams{ID: seeded.taskID, N: seeded.attemptN, XMoltnetTeamID: team})
		expectRes[*moltnetapi.Task](t, "fail attempt", failRes, err)

		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(30 * time.Second):
			t.Fatal("--follow did not exit after the attempt ended")
		}
		if runErr != nil {
			t.Fatalf("conversations get --follow: %v\nstderr: %s", runErr, stderr)
		}
		var roles []string
		for _, line := range strings.Split(strings.TrimSpace(stdout), "\n") {
			var message cliConversationMessage
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("decode line %q: %v", line, err)
			}
			roles = append(roles, message.role(t))
		}
		if got := strings.Join(roles, ","); got != "user,assistant,toolResult,assistant" {
			t.Fatalf("followed roles = %s (each message must print once)\nstdout:\n%s", got, stdout)
		}
	})
}
