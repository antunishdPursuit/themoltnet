package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const runtimeModelTestID = "30000000-0000-0000-0000-000000000003"
const runtimeModelTeamID = "40000000-0000-0000-0000-000000000004"

const runtimeModelResponse = `{"id":"` + runtimeModelTestID + `","teamId":"` + runtimeModelTeamID + `","provider":"internal-llm","model":"llama-3.3","displayName":"Internal Llama","description":null,"capabilities":{},"isActive":true,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","createdByAgentId":null,"createdByHumanId":null}`

func TestRuntimeModelsCommandsUseGeneratedOperations(t *testing.T) {
	t.Setenv(agentKeyEnv, "test-agent-key")
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.RequestURI())
		if got := r.Header.Get("Authorization"); got != "Bearer test-agent-key" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.Method + " " + r.URL.Path {
		case "GET /runtime-models":
			if r.Header.Get("x-moltnet-team-id") != runtimeModelTeamID || r.URL.Query().Get("provider") != "internal-llm" {
				t.Errorf("list scope = %q, provider = %q", r.Header.Get("x-moltnet-team-id"), r.URL.Query().Get("provider"))
			}
			_, _ = io.WriteString(w, `{"items":[]}`)
		case "POST /runtime-models":
			if r.Header.Get("x-moltnet-team-id") != runtimeModelTeamID {
				t.Errorf("create team = %q", r.Header.Get("x-moltnet-team-id"))
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode create: %v", err)
			}
			if body["provider"] != "internal-llm" || body["model"] != "llama-3.3" {
				t.Errorf("create body = %v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, runtimeModelResponse)
		case "GET /runtime-models/" + runtimeModelTestID:
			_, _ = io.WriteString(w, runtimeModelResponse)
		case "PATCH /runtime-models/" + runtimeModelTestID:
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode update: %v", err)
			}
			if body["isActive"] != false {
				t.Errorf("update body = %v", body)
			}
			_, _ = io.WriteString(w, runtimeModelResponse)
		case "DELETE /runtime-models/" + runtimeModelTestID:
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	createFile := filepath.Join(t.TempDir(), "model.json")
	if err := os.WriteFile(createFile, []byte(`{"provider":"internal-llm","model":"llama-3.3","capabilities":{"contextWindow":128000}}`), 0600); err != nil {
		t.Fatal(err)
	}
	patchFile := filepath.Join(t.TempDir(), "patch.json")
	if err := os.WriteFile(patchFile, []byte(`{"isActive":false}`), 0600); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for _, run := range []func() error{
		func() error { return runRuntimeModelsListCmd(&out, server.URL, "", runtimeModelTeamID, "internal-llm") },
		func() error { return runRuntimeModelsCreateCmd(&out, server.URL, "", runtimeModelTeamID, createFile) },
		func() error { return runRuntimeModelsGetCmd(&out, server.URL, "", runtimeModelTestID, "") },
		func() error {
			return runRuntimeModelsUpdateCmd(&out, server.URL, "", runtimeModelTestID, patchFile, "")
		},
		func() error { return runRuntimeModelsDeleteCmd(&out, server.URL, "", runtimeModelTestID, "") },
	} {
		if err := run(); err != nil {
			t.Fatal(err)
		}
	}
	if len(requests) != 5 {
		t.Fatalf("requests = %v", requests)
	}
	if !strings.Contains(out.String(), `"provider": "internal-llm"`) {
		t.Errorf("output = %s", out.String())
	}
}

func TestRuntimeModelsRejectInvalidInput(t *testing.T) {
	for _, args := range [][]string{
		{"runtime-models", "create", "--from-file", "model.json"},
		{"runtime-models", "update", runtimeModelTestID},
		{"runtime-models", "get", "bad"},
		{"runtime-models", "delete", "bad"},
	} {
		if _, _, err := executeCommand(NewRootCmd("test", ""), args...); err == nil {
			t.Errorf("expected error for %v", args)
		}
	}
}
