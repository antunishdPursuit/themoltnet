package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const testGroupID = "10000000-0000-0000-0000-000000000001"
const groupsTestSubjectID = "20000000-0000-0000-0000-000000000002"

func TestTeamsGroupsHelpAndRequiredFlags(t *testing.T) {
	t.Parallel()
	root := NewRootCmd("test", "")
	stdout, _, err := executeCommand(root, "teams", "groups", "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"create", "list", "get", "delete", "members"} {
		if !strings.Contains(stdout, command) {
			t.Errorf("groups help missing %s", command)
		}
	}
	for _, args := range [][]string{
		{"teams", "groups", "create", testGroupID},
		{"teams", "groups", "members", "add", testGroupID, groupsTestSubjectID},
		{"teams", "groups", "members", "remove", testGroupID},
	} {
		if _, _, err := executeCommand(NewRootCmd("test", ""), args...); err == nil {
			t.Errorf("expected validation error for %v", args)
		}
	}
}

func TestGroupsRejectInvalidIdentifiersAndSubjectNamespace(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name string
		run  func() error
	}{
		{"team", func() error { return runGroupsCreateCmd("", "", "bad", "Reviewers") }},
		{"group", func() error { return runGroupsGetCmd("", "", "bad") }},
		{"subject", func() error { return runGroupsMembersRemoveCmd("", "", testGroupID, "bad") }},
		{"namespace", func() error { return runGroupsMembersAddCmd("", "", testGroupID, groupsTestSubjectID, "Group") }},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestGroupsCreateAndAddMemberUseGeneratedOperations(t *testing.T) {
	t.Setenv(agentKeyEnv, "test-agent-key")
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer test-agent-key" {
			t.Errorf("authorization = %q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/teams/" + testGroupID + "/groups":
			if body["name"] != "Reviewers" {
				t.Errorf("group name = %v", body["name"])
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"` + testGroupID + `","teamId":"` + testGroupID + `","name":"Reviewers"}`))
		case "/groups/" + testGroupID + "/members":
			if body["subjectId"] != groupsTestSubjectID || body["subjectNs"] != "Human" {
				t.Errorf("member body = %v", body)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"subjectId":"` + groupsTestSubjectID + `","subjectNs":"Human"}`))
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	if err := runGroupsCreateCmd(server.URL, "", testGroupID, "Reviewers"); err != nil {
		t.Fatal(err)
	}
	if err := runGroupsMembersAddCmd(server.URL, "", testGroupID, groupsTestSubjectID, "Human"); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || requests[0] != "POST /teams/"+testGroupID+"/groups" || requests[1] != "POST /groups/"+testGroupID+"/members" {
		t.Fatalf("requests = %v", requests)
	}
}

func TestGroupsReadAndDeleteUseGeneratedOperations(t *testing.T) {
	t.Setenv(agentKeyEnv, "test-agent-key")
	tests := []struct {
		name, method, path, response string
		run                          func(string) error
	}{
		{"list", "GET", "/teams/" + testGroupID + "/groups", `{"items":[]}`, func(url string) error { return runGroupsListCmd(url, "", testGroupID) }},
		{"get", "GET", "/groups/" + testGroupID, `{"id":"` + testGroupID + `","teamId":"` + testGroupID + `","name":"Reviewers","members":[],"createdAt":"2026-01-01T00:00:00Z"}`, func(url string) error { return runGroupsGetCmd(url, "", testGroupID) }},
		{"delete", "DELETE", "/groups/" + testGroupID, `{"deleted":true}`, func(url string) error { return runGroupsDeleteCmd(url, "", testGroupID) }},
		{"members list", "GET", "/groups/" + testGroupID + "/members", `{"items":[]}`, func(url string) error { return runGroupsMembersListCmd(url, "", testGroupID) }},
		{"members remove", "DELETE", "/groups/" + testGroupID + "/members/" + groupsTestSubjectID, `{"removed":true}`, func(url string) error { return runGroupsMembersRemoveCmd(url, "", testGroupID, groupsTestSubjectID) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != test.method || r.URL.Path != test.path {
					t.Errorf("request = %s %s, want %s %s", r.Method, r.URL.Path, test.method, test.path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(test.response))
			}))
			defer server.Close()
			if err := test.run(server.URL); err != nil {
				t.Fatal(err)
			}
		})
	}
}
