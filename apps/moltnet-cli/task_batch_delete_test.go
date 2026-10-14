package main

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	moltnetapi "github.com/getlarge/themoltnet/libs/moltnet-api-client"
	"github.com/google/uuid"
)

func TestTaskBatchDeleteQueuesAcceptedIDsAndReportsSkipped(t *testing.T) {
	h := &stubTasksHandler{}
	_, _, client := newTestServer(t, h)
	first := uuid.MustParse("11111111-1111-4111-8111-111111111111")
	second := uuid.MustParse("22222222-2222-4222-8222-222222222222")
	team := uuid.MustParse("33333333-3333-4333-8333-333333333333")
	req, params, err := buildTaskBatchDeleteRequest(taskBatchDeleteOpts{
		teamID: team.String(), ids: first.String() + "," + second.String(),
		force: true, reason: "Retention cleanup",
	})
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	var out bytes.Buffer
	if err := runTaskBatchDeleteWithClient(context.Background(), client, req, params, &out); err != nil {
		t.Fatalf("batch-delete: %v", err)
	}
	if h.batchDeleteCalls != 1 || h.batchDeleteParams.XMoltnetTeamID.Value != team ||
		!slices.Equal(h.batchDeleteReq.Ids, []uuid.UUID{first, second}) ||
		!h.batchDeleteReq.Force.Set || !h.batchDeleteReq.Force.Value ||
		!h.batchDeleteReq.Reason.Set || h.batchDeleteReq.Reason.Value != "Retention cleanup" {
		t.Fatalf("batch delete request = %+v, params = %+v", h.batchDeleteReq, h.batchDeleteParams)
	}
	var result moltnetapi.BatchDeleteTasksAcceptedResponse
	if err := json.Unmarshal(out.Bytes(), &result); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if result.Status != moltnetapi.BatchDeleteTasksAcceptedResponseStatusQueued ||
		!slices.Equal(result.Accepted, []uuid.UUID{first}) ||
		!slices.Equal(result.Skipped, []uuid.UUID{second}) || result.WorkflowId.Value != "wf-1" {
		t.Fatalf("batch delete response = %+v", result)
	}
}

func TestTaskBatchDeleteRejectsInvalidInput(t *testing.T) {
	team := "33333333-3333-4333-8333-333333333333"
	id := "11111111-1111-4111-8111-111111111111"
	for _, tc := range []struct {
		name string
		opts taskBatchDeleteOpts
	}{
		{"team", taskBatchDeleteOpts{teamID: "bad", ids: id}},
		{"empty", taskBatchDeleteOpts{teamID: team}},
		{"UUID", taskBatchDeleteOpts{teamID: team, ids: "bad"}},
		{"duplicate", taskBatchDeleteOpts{teamID: team, ids: id + "," + id}},
		{"force reason", taskBatchDeleteOpts{teamID: team, ids: id, force: true}},
		{"reason without force", taskBatchDeleteOpts{teamID: team, ids: id, reason: "cleanup"}},
		{"reason length", taskBatchDeleteOpts{teamID: team, ids: id, force: true, reason: strings.Repeat("a", 1001)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := buildTaskBatchDeleteRequest(tc.opts); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestTaskBatchDeleteRequiresConfirmation(t *testing.T) {
	_, _, err := executeCommand(NewRootCmd("test", ""), "task", "batch-delete",
		"--team-id", "33333333-3333-4333-8333-333333333333",
		"--ids", "11111111-1111-4111-8111-111111111111")
	if err == nil || !strings.Contains(err.Error(), "--yes") {
		t.Fatalf("expected confirmation error, got %v", err)
	}
}
