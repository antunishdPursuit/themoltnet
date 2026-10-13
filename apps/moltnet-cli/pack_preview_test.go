package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const (
	previewDiaryID = "cc000000-0000-0000-0000-000000000001"
	previewEntryID = "dd000000-0000-0000-0000-000000000001"
	previewPackID  = "ee000000-0000-0000-0000-000000000001"
)

func TestPackPreviewCommandHelp(t *testing.T) {
	stdout, _, err := executeCommand(newPackPreviewCmd(), "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"--diary-id", "--entries", "--token-budget", "--pinned", "--force", "--supersedes"} {
		if !strings.Contains(stdout, flag) {
			t.Errorf("help missing %s", flag)
		}
	}
	if !strings.Contains(stdout, "without saving") {
		t.Errorf("help should distinguish source preview from rendering: %s", stdout)
	}
}

func TestPackPreviewRequiresSelection(t *testing.T) {
	_, _, err := executeCommand(newPackPreviewCmd())
	if err == nil || !strings.Contains(err.Error(), "diary-id") {
		t.Fatalf("error = %v, want required diary ID", err)
	}
}

func TestRunPackPreviewCmd(t *testing.T) {
	var requestPath string
	var requestBody struct {
		Entries []struct {
			EntryID string `json:"entryId"`
			Rank    int    `json:"rank"`
		} `json:"entries"`
		PackType         string `json:"packType"`
		TokenBudget      int    `json:"tokenBudget"`
		Pinned           bool   `json:"pinned"`
		Force            bool   `json:"force"`
		SupersedesPackID string `json:"supersedesPackId"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/oauth2/token" {
			_, _ = w.Write([]byte(`{"access_token":"test","token_type":"Bearer","expires_in":3600}`))
			return
		}
		requestPath = r.URL.Path
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer test" {
			t.Errorf("request = %s %s, auth %q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Errorf("decode request: %v", err)
		}
		_, _ = w.Write([]byte(`{"compileStats":{"budgetUtilization":0.5,"compressionRatio":1,"elapsedMs":1,"entriesCompressed":0,"entriesIncluded":1,"totalTokens":50},"entries":[],"packCid":"bafy-preview","packType":"custom","params":{}}`))
	}))
	defer server.Close()
	credPath := writeRenderedPacksCreds(t, server.URL)

	var stdout bytes.Buffer
	pinned := true
	err := runPackPreviewCmd(&stdout, server.URL, credPath, previewDiaryID,
		`[{"entryId":"`+previewEntryID+`","rank":2}]`, 100, &pinned, true, previewPackID)
	if err != nil {
		t.Fatalf("runPackPreviewCmd: %v", err)
	}
	if requestPath != "/diaries/"+previewDiaryID+"/packs/preview" {
		t.Errorf("path = %q", requestPath)
	}
	if len(requestBody.Entries) != 1 || requestBody.Entries[0].EntryID != previewEntryID || requestBody.Entries[0].Rank != 2 {
		t.Errorf("entries = %+v", requestBody.Entries)
	}
	if requestBody.PackType != "custom" || requestBody.TokenBudget != 100 || !requestBody.Pinned || !requestBody.Force || requestBody.SupersedesPackID != previewPackID {
		t.Errorf("preview options = %+v", requestBody)
	}
	if !strings.Contains(stdout.String(), "bafy-preview") {
		t.Errorf("preview JSON missing pack CID: %s", stdout.String())
	}
}

func TestRunPackPreviewCmdRejectsInvalidSelection(t *testing.T) {
	for _, tt := range []struct {
		name, diaryID, entries, supersedes, want string
	}{
		{"diary ID", "bad", `[{"entryId":"` + previewEntryID + `","rank":1}]`, "", "invalid diary ID"},
		{"JSON", previewDiaryID, "{", "", "invalid --entries JSON"},
		{"empty", previewDiaryID, "[]", "", "at least one entry"},
		{"entry ID", previewDiaryID, `[{"entryId":"bad","rank":1}]`, "", "invalid entryId"},
		{"supersedes", previewDiaryID, `[{"entryId":"` + previewEntryID + `","rank":1}]`, "bad", "invalid --supersedes"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := runPackPreviewCmd(&bytes.Buffer{}, "http://localhost", "", tt.diaryID, tt.entries, 0, nil, false, tt.supersedes)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestRunPackPreviewCmdFormatsAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/oauth2/token" {
			_, _ = w.Write([]byte(`{"access_token":"test","token_type":"Bearer","expires_in":3600}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"NOT_FOUND","type":"about:blank","status":404,"title":"Not Found","detail":"diary missing"}`))
	}))
	defer server.Close()
	credPath := writeRenderedPacksCreds(t, server.URL)

	err := runPackPreviewCmd(&bytes.Buffer{}, server.URL, credPath, previewDiaryID,
		`[{"entryId":"`+previewEntryID+`","rank":1}]`, 0, nil, false, "")
	if err == nil || !strings.Contains(err.Error(), "diary missing") {
		t.Fatalf("error = %v, want API detail", err)
	}
}
