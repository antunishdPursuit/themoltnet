package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
)

const (
	packAID      = "aaaaaaaa-0000-4000-8000-000000000001"
	packBID      = "bbbbbbbb-0000-4000-8000-000000000002"
	packDiffJSON = `{"added":[],"changed":[],"removed":[],"reordered":[],"stats":{"addedCount":0,"changedCount":0,"removedCount":0,"reorderedCount":0,"tokenDelta":3,"packA":{"createdAt":"2026-01-01T00:00:00Z","id":"` + packAID + `","packCid":"bafy-a","packType":"custom","totalTokens":10},"packB":{"createdAt":"2026-01-02T00:00:00Z","id":"` + packBID + `","packCid":"bafy-b","packType":"custom","totalTokens":13}}}`
)

func TestPackDiffCommandHelp(t *testing.T) {
	stdout, _, err := executeCommand(newPackDiffCmd(), "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, flag := range []string{"--from-pack-id", "--to-pack-id", "--from-pack-cid", "--to-pack-cid"} {
		if !strings.Contains(stdout, flag) {
			t.Errorf("help missing %s", flag)
		}
	}
	if strings.Contains(stdout, "--other-pack-") {
		t.Error("help still lists other-pack flags")
	}
}

func TestParsePackDiffSelector(t *testing.T) {
	tests := []struct {
		name    string
		fromID  string
		toID    string
		fromCID string
		toCID   string
		wantErr string
	}{
		{name: "neither pair", wantErr: "provide either"},
		{name: "both pairs", fromID: packAID, toID: packBID, fromCID: "bafy-a", toCID: "bafy-b", wantErr: "provide either"},
		{name: "incomplete ID pair", fromID: packAID, wantErr: "provide both --from-pack-id"},
		{name: "incomplete CID pair", fromCID: "bafy-a", wantErr: "provide both --from-pack-cid"},
		{name: "invalid first ID", fromID: "bad", toID: packBID, wantErr: "invalid --from-pack-id"},
		{name: "invalid second ID", fromID: packAID, toID: "bad", wantErr: "invalid --to-pack-id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parsePackDiffSelector(tt.fromID, tt.toID, tt.fromCID, tt.toCID)
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("parsePackDiffSelector() error = %v, want containing %q", err, tt.wantErr)
			}
		})
	}
}

func TestExecutePackDiff(t *testing.T) {
	tests := []struct {
		name     string
		fromID   string
		toID     string
		fromCID  string
		toCID    string
		wantPath string
	}{
		{name: "IDs", fromID: packAID, toID: packBID, wantPath: "/packs/" + packAID + "/diff/" + packBID},
		{name: "CIDs", fromCID: "bafy-a", toCID: "bafy-b", wantPath: "/packs/by-cid/bafy-a/diff/by-cid/bafy-b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.wantPath {
					t.Errorf("path = %q, want %q", r.URL.Path, tt.wantPath)
				}
				if r.Header.Get("Authorization") != "Bearer test-token" {
					t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(packDiffJSON))
			}))
			defer server.Close()

			client := newPackDiffTestClient(t, server)
			selector, err := parsePackDiffSelector(tt.fromID, tt.toID, tt.fromCID, tt.toCID)
			if err != nil {
				t.Fatal(err)
			}
			var stdout bytes.Buffer
			if err := executePackDiff(&stdout, client, selector); err != nil {
				t.Fatalf("executePackDiff: %v", err)
			}
			var result struct {
				Stats struct {
					TokenDelta int `json:"tokenDelta"`
				} `json:"stats"`
			}
			if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
				t.Fatalf("decode CLI output: %v", err)
			}
			if result.Stats.TokenDelta != 3 {
				t.Errorf("tokenDelta = %d, want 3", result.Stats.TokenDelta)
			}
		})
	}
}

func TestExecutePackDiffFormatsAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"code":"NOT_FOUND","type":"about:blank","status":404,"title":"Not Found","detail":"pack missing"}`))
	}))
	defer server.Close()

	client := newPackDiffTestClient(t, server)
	selector, err := parsePackDiffSelector(packAID, packBID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	err = executePackDiff(&stdout, client, selector)
	if err == nil || !strings.Contains(err.Error(), "pack missing") {
		t.Fatalf("error = %v, want API detail", err)
	}
}

func newPackDiffTestClient(t *testing.T, server *httptest.Server) *moltnetapi.Client {
	t.Helper()
	client, err := newBearerClient(server.URL, func(context.Context) (string, error) {
		return "test-token", nil
	}, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}
