//go:build e2e

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	gocid "github.com/ipfs/go-cid"
	"github.com/multiformats/go-multihash"
)

// durableConversation is a task attempt whose Durable store holds the
// committed pi-durable writes from testdata/durable-conversation-commits.json.
type durableConversation struct {
	taskID   string
	teamID   string
	attemptN int
}

// e2eAPI sends one JSON request as the bootstrapped e2e agent. Seeding goes
// through the REST API directly so the CLI is the only code under test.
func e2eAPI(t *testing.T, method, path string, body any, want int, out any) {
	t.Helper()
	token, err := NewTokenManager(e2eAPIURL, e2eCreds.OAuth2.ClientID, e2eCreds.OAuth2.ClientSecret).GetToken()
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode %s %s: %v", method, path, err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e2eAPIURL+path, reader)
	if err != nil {
		t.Fatalf("request %s %s: %v", method, path, err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("x-moltnet-team-id", e2ePersonalTeamID.String())
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != want {
		t.Fatalf("%s %s = %d, want %d: %s", method, path, res.StatusCode, want, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			t.Fatalf("decode %s %s: %v: %s", method, path, err, raw)
		}
	}
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

// seedDurableConversation claims a task under a runtime profile (only pinned
// claims carry the lease a Durable store requires) and commits the fixture.
func seedDurableConversation(t *testing.T) durableConversation {
	t.Helper()
	var profile struct {
		ID            string `json:"id"`
		DefinitionCid string `json:"definitionCid"`
		RuntimeKind   string `json:"runtimeKind"`
	}
	e2eAPI(t, http.MethodPost, "/runtime-profiles", map[string]any{
		"name": "cli-conversations-" + uuid.NewString(),
		"models": map[string]any{
			"generation": map[string]any{"provider": "anthropic", "model": "claude-sonnet-4-5"},
		},
		"sandbox": map[string]any{
			"hostExec":  map[string]any{"autoApprove": false},
			"resources": map[string]any{"cpus": 2, "memory": "2G"},
		},
	}, http.StatusCreated, &profile)

	var task struct {
		ID string `json:"id"`
	}
	e2eAPI(t, http.MethodPost, "/tasks", map[string]any{
		"taskType":        "fulfill_brief",
		"title":           "CLI conversation read",
		"diaryId":         e2eDiaryID.String(),
		"allowedProfiles": []map[string]any{{"profileId": profile.ID}},
		"input":           map[string]any{"brief": "CLI conversation read"},
	}, http.StatusCreated, &task)

	manifest := map[string]any{
		"schemaVersion": "moltnet:executor-manifest:v1",
		"runtime": map[string]any{
			"kind": profile.RuntimeKind, "engine": "pi", "sandbox": "gondolin",
			"id": "cli-conversations-e2e", "version": "1",
		},
		"profile": map[string]any{"id": profile.ID, "definitionCid": profile.DefinitionCid},
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
	e2eAPI(t, http.MethodPost, "/executor-manifests/register", map[string]any{
		"executorManifest":    manifest,
		"executorFingerprint": fingerprint,
		"executorSignature":   signature,
	}, http.StatusOK, nil)

	var claim struct {
		Attempt struct {
			AttemptN int    `json:"attemptN"`
			LeaseID  string `json:"leaseId"`
		} `json:"attempt"`
	}
	e2eAPI(t, http.MethodPost, "/tasks/"+task.ID+"/claim", map[string]any{
		"leaseTtlSec":         300,
		"profileId":           profile.ID,
		"executorFingerprint": fingerprint,
	}, http.StatusOK, &claim)

	authority := map[string]any{
		"taskId":              task.ID,
		"attemptN":            claim.Attempt.AttemptN,
		"leaseId":             claim.Attempt.LeaseID,
		"executorFingerprint": fingerprint,
	}
	var store struct {
		StoreID     string `json:"storeId"`
		WriterToken string `json:"writerToken"`
		HeadSeq     int    `json:"headSeq"`
	}
	e2eAPI(t, http.MethodPost, "/runtime-sessions/durable/open", authority, http.StatusOK, &store)

	raw, err := os.ReadFile("testdata/durable-conversation-commits.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var commits [][]map[string]any
	if err := json.Unmarshal([]byte(strings.ReplaceAll(string(raw), "__TASK_ID__", task.ID)), &commits); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	head := store.HeadSeq
	for _, writes := range commits {
		body := map[string]any{"writerToken": store.WriterToken, "commitId": uuid.NewString(), "expectedSeq": head, "writes": writes}
		for k, v := range authority {
			body[k] = v
		}
		var receipt struct {
			Seq int `json:"seq"`
		}
		e2eAPI(t, http.MethodPost, "/runtime-sessions/durable/"+store.StoreID+"/commits", body, http.StatusOK, &receipt)
		head = receipt.Seq
	}
	return durableConversation{taskID: task.ID, teamID: e2ePersonalTeamID.String(), attemptN: claim.Attempt.AttemptN}
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
		stdout, stderr, err := cli(append([]string{"get", seeded.taskID, "--team-id", seeded.teamID, "--format", "json"}, args...)...)
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
		stdout, stderr, err := cli("list", seeded.taskID, "--team-id", seeded.teamID)
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
		stdout, stderr, err := cli("get", seeded.taskID, "--team-id", seeded.teamID)
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

		stdout, stderr, err := cli("get", seeded.taskID, "--team-id", seeded.teamID, "--limit", "1")
		if err != nil {
			t.Fatalf("conversations get --limit 1: %v\nstderr: %s", err, stderr)
		}
		if !strings.Contains(stdout, "(older entries exist: pass --before-entry-id "+*first.NextBeforeEntryID+")") {
			t.Errorf("human page did not point at older entries:\n%s", stdout)
		}
	})

	t.Run("rejects an unknown conversation", func(t *testing.T) {
		_, stderr, err := cli("get", seeded.taskID, "--team-id", seeded.teamID, "--conversation", "999999")
		if err == nil {
			t.Fatalf("expected failure for an unknown conversation; stderr: %s", stderr)
		}
	})

	t.Run("explains attempts without a Durable conversation", func(t *testing.T) {
		var task struct {
			ID string `json:"id"`
		}
		e2eAPI(t, http.MethodPost, "/tasks", map[string]any{
			"taskType": "fulfill_brief",
			"title":    "CLI conversation absent",
			"diaryId":  e2eDiaryID.String(),
			"input":    map[string]any{"brief": "no Durable store"},
		}, http.StatusCreated, &task)
		e2eAPI(t, http.MethodPost, "/tasks/"+task.ID+"/claim", map[string]any{"leaseTtlSec": 60}, http.StatusOK, nil)

		// Until an attempt opens a Durable store, the API lists no conversations.
		stdout, stderr, err := cli("list", task.ID, "--team-id", seeded.teamID)
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

		_, stderr, err = cli("get", task.ID, "--team-id", seeded.teamID)
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
			stdout, stderr, runErr = cli("get", seeded.taskID, "--team-id", seeded.teamID, "--follow", "--interval", "1", "--format", "json")
		}()
		// Let the follower print the committed messages while the attempt is live.
		time.Sleep(3 * time.Second)
		// An attempt can only fail once a heartbeat has started it.
		attempt := fmt.Sprintf("/tasks/%s/attempts/%d", seeded.taskID, seeded.attemptN)
		e2eAPI(t, http.MethodPost, attempt+"/heartbeat", map[string]any{}, http.StatusOK, nil)
		e2eAPI(t, http.MethodPost, attempt+"/fail", map[string]any{
			"error": map[string]any{"code": "e2e_finished", "message": "follow test ends the attempt", "retryable": false},
		}, http.StatusOK, nil)

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
