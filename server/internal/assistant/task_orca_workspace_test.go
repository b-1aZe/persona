package assistant

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

func TestPlannedOrcaTaskGroupsWorkersAndClosesAfterAcceptance(t *testing.T) {
	s, f := taskHerdrHub(t, nil)
	f.devices = []Device{
		{ID: "server", Name: "server", Home: "/home/me", Online: true, Reachable: true},
		{ID: "box", Name: "box", Home: "/home/me", Online: true, Reachable: true, Engine: proto.EngineOrca},
	}
	leader := startTaskLeader(t, s, f)
	writer := planWorker(t, s, f, map[string]any{"workspace": "new"})
	reader := planWorker(t, s, f, map[string]any{"readonly": true, "permission": "plan"})
	starts := f.started()
	create := taskWorktreeCreate(f)
	if len(starts) != 3 || create["open_workspace"] != false || starts[1]["cwd"] != create["path"] {
		t.Fatalf("task checkout: starts=%v create=%v", starts, create)
	}
	for _, p := range starts[1:] {
		if p["task_id"] != leader.ID || p["workspace_id"] != taskHerdrWorkspaceID {
			t.Fatalf("worker did not join the leader: %v", p)
		}
	}
	ctx := t.Context()
	for _, child := range []Todo{writer, reader} {
		accept, _ := json.Marshal(map[string]any{"todo_id": child.ID, "verdict": "accepted",
			"note": "Verified", "checks": completeReviewChecks(todoNow(s, child.ID))})
		if r := s.mcpCall(ctx, "box", "s1", "task_review", accept, false); r.IsError {
			t.Fatal(r)
		}
	}
	if _, err := runJSON(t, s, "conv1", "task_review", map[string]any{"todo_id": leader.ID,
		"verdict": "accepted", "note": "Verified", "checks": completeReviewChecks(todoNow(s, leader.ID))}); err != nil {
		t.Fatal(err)
	}
	s.closeDoneTaskSpaces(ctx, time.Now(), doneSeen{})
	if len(taskWorkspaceCloses(f)) != 0 {
		t.Fatal("closed while the task still had a live Agent")
	}
	user := taskCloseSession("unrelated", true, false)
	user.WorkspaceID = taskHerdrWorkspaceID
	f.setSessions("box", user)
	f.answerNode(deviceWorkspaceClose, func(string, json.RawMessage) (any, error) {
		return map[string]any{"closed": true}, nil
	})
	s.closeDoneTaskSpaces(ctx, time.Now(), doneSeen{})
	closes := taskWorkspaceCloses(f)
	if len(closes) != 1 || closes[0]["host"] != proto.EngineOrca || closes[0]["task_id"] != leader.ID || closes[0]["workspace_id"] != taskHerdrWorkspaceID {
		t.Fatalf("Orca task cleanup: %v", closes)
	}
}
