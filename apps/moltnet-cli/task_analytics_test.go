package main

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

func TestTaskAnalyticsActivityForwardsFilters(t *testing.T) {
	h := &stubTasksHandler{}
	_, _, client := newTestServer(t, h)
	teamID := "22222222-2222-4222-8222-222222222222"
	profileID := "33333333-3333-4333-8333-333333333333"
	diaryID := "44444444-4444-4444-8444-444444444444"
	agentID := "55555555-5555-4555-8555-555555555555"
	opts := taskAnalyticsActivityOpts{
		teamID:         teamID,
		completedAfter: "2026-10-01T00:00:00Z", completedBefore: "2026-10-14T00:00:00Z",
		tags: []string{"review,priority:high"}, taskTypes: []string{"fulfill_brief"},
		profileIDs: []string{profileID}, diaryIDs: []string{diaryID},
		claimedByAgentIDs: []string{agentID}, groupBy: "taskType",
	}
	params, err := buildTaskAnalyticsActivityParams(opts)
	if err != nil {
		t.Fatalf("build params: %v", err)
	}
	var out bytes.Buffer
	if err := runTaskAnalyticsActivityWithClient(context.Background(), client, params, &out); err != nil {
		t.Fatalf("activity analytics: %v", err)
	}
	if h.analyticsCalls != 1 || h.analyticsParams.XMoltnetTeamID.String() != teamID ||
		!h.analyticsParams.CompletedAfter.Set || !h.analyticsParams.CompletedBefore.Set ||
		!h.analyticsParams.GroupBy.Set || h.analyticsParams.GroupBy.Value != moltnetapi.GetTaskActivityAnalyticsGroupByTaskType {
		t.Fatalf("analytics params = %+v, calls = %d", h.analyticsParams, h.analyticsCalls)
	}
	if len(h.analyticsParams.Tags) != 2 || h.analyticsParams.Tags[0] != "review" ||
		len(h.analyticsParams.TaskTypes) != 1 || h.analyticsParams.TaskTypes[0] != "fulfill_brief" ||
		h.analyticsParams.ProfileIds[0] != uuid.MustParse(profileID) ||
		h.analyticsParams.DiaryIds[0] != uuid.MustParse(diaryID) ||
		h.analyticsParams.ClaimedByAgentIds[0] != uuid.MustParse(agentID) {
		t.Fatalf("analytics filters = %+v", h.analyticsParams)
	}
	var result moltnetapi.TaskActivityAnalyticsResponse
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.StatsComplete {
		t.Fatalf("analytics output = %s, decode error = %v", out.String(), err)
	}
}

func TestTaskAnalyticsActivityRejectsInvalidFilters(t *testing.T) {
	teamID := "22222222-2222-4222-8222-222222222222"
	for _, tc := range []struct {
		name string
		opts taskAnalyticsActivityOpts
	}{
		{"team", taskAnalyticsActivityOpts{teamID: "bad"}},
		{"timestamp", taskAnalyticsActivityOpts{teamID: teamID, completedAfter: "yesterday"}},
		{"range", taskAnalyticsActivityOpts{teamID: teamID, completedAfter: "2026-10-14T00:00:00Z", completedBefore: "2026-10-01T00:00:00Z"}},
		{"group", taskAnalyticsActivityOpts{teamID: teamID, groupBy: "hour"}},
		{"UUID", taskAnalyticsActivityOpts{teamID: teamID, diaryIDs: []string{"bad"}}},
		{"count", taskAnalyticsActivityOpts{teamID: teamID, tags: []string{strings.Repeat("tag,", 21)}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := buildTaskAnalyticsActivityParams(tc.opts); err == nil {
				t.Fatal("expected filter validation error")
			}
		})
	}
}

func TestTaskAnalyticsActivityCommandRequiresTeam(t *testing.T) {
	_, _, err := executeCommand(NewRootCmd("test", ""), "task", "analytics", "activity")
	if err == nil || !strings.Contains(err.Error(), "team-id") {
		t.Fatalf("expected team ID requirement, got %v", err)
	}
}
