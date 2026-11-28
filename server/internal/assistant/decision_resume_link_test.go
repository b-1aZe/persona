package assistant

import (
	"strings"
	"testing"

	"github.com/nwverse/persona/server/internal/proto"
)

func TestDecisionTerminalDoesNotInterpretTheReason(t *testing.T) {
	for _, tc := range []struct{ name, reason string }{
		{"English negation", "Do not resume on the terminal; continue in this conversation."},
		{"English mention", "Resume the meeting tomorrow. The terminal output is attached."},
		{"Chinese negation", "不要在终端恢复，请在当前对话继续。"},
		{"Chinese mention", "终端输出已保存。何时恢复会议？"},
		{"Japanese negation", "ターミナルで再開しないで、この会話を続けてください。"},
		{"Japanese mention", "ターミナルの出力は保存済みです。会議をいつ再開しますか？"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f, todo := newSupervisedService(t)
			waitsForReview(t, s, f, todo.ID, "The owner can choose the next step.")
			args := rolloutDecision()
			args["reason"] = tc.reason
			if _, err := reviewErr(s, todo.ID, args); err != nil {
				t.Fatal(err)
			}
			row := listedAsk(t, s, todo.ID)
			if row["question"] != tc.reason || row["resume_terminal"] != nil {
				t.Fatalf("decision %v", row)
			}
		})
	}
}

func TestDecisionTerminalAfterResumeRefusal(t *testing.T) {
	for _, tc := range []struct {
		name string
		caps *proto.SessionCapabilities
		want bool
	}{
		{"user stop", &proto.SessionCapabilities{StopCause: proto.StopUser}, true},
		{"legacy node", nil, true},
		{"resumable stop", &proto.SessionCapabilities{StopCause: proto.StopUnknown}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f, todo := newSupervisedService(t)
			waitsForReview(t, s, f, todo.ID, "The owner can choose the next step.")
			ag := todo.Agents[0]
			if err := s.linkTodoAgent(t.Context(), todo.ID, ag.MachineID, "another-agent", "Second Agent", "", ""); err != nil {
				t.Fatal(err)
			}
			stopped := proto.Session{MachineID: ag.MachineID, SessionID: ag.SessionID, Capabilities: tc.caps}
			err := s.resumeAllowed(t.Context(), todo.Origin, Device{ID: ag.MachineID}, stopped, "needs its context", nil)
			if tc.want && err == nil {
				t.Fatal("expected resume refusal")
			}
			if _, err := reviewErr(s, todo.ID, rolloutDecision()); err != nil {
				t.Fatal(err)
			}
			row := listedAsk(t, s, todo.ID)
			terminal, linked := row["resume_terminal"].(map[string]any)
			if row == nil || linked != tc.want || linked && (terminal["machine_id"] != ag.MachineID || terminal["session_id"] != ag.SessionID) || row["terminal_option"] != nil {
				t.Fatalf("decision %v, expected terminal link %t for %s/%s", row, tc.want, ag.MachineID, ag.SessionID)
			}
			if tc.name == "legacy node" {
				if err := s.linkTodoAgent(t.Context(), todo.ID, ag.MachineID, ag.SessionID, "", "", ""); err != nil {
					t.Fatal(err)
				}
				if relinked := listedAsk(t, s, todo.ID); relinked == nil || relinked["resume_terminal"] != nil {
					t.Fatalf("decision linked a later binding: %v", relinked)
				}
			}
			// A later decision on the same task needs its own refusal.
			nextReview := rolloutDecision()
			nextReview["reason"] = "What next?"
			if _, err := reviewErr(s, todo.ID, nextReview); err != nil {
				t.Fatal(err)
			}
			if next := listedAsk(t, s, todo.ID); next["question"] != "What next?" || next["resume_terminal"] != nil {
				t.Fatalf("next decision %v", next)
			}
		})
	}
}

func TestDecisionTerminalRequiresCurrentRefusal(t *testing.T) {
	for _, scenario := range []string{"other supervisor", "resumable retry", "owner resumed", "two refusals", "relinked Agent"} {
		t.Run(scenario, func(t *testing.T) {
			s, f, todo := newSupervisedService(t)
			waitsForReview(t, s, f, todo.ID, "Choose how to proceed.")
			ag := todo.Agents[0]
			self := todo.Origin
			if scenario == "other supervisor" {
				self = "other-conversation"
			}
			device := Device{ID: ag.MachineID}
			stopped := proto.Session{MachineID: ag.MachineID, SessionID: ag.SessionID, Capabilities: &proto.SessionCapabilities{StopCause: proto.StopUser}}
			if err := s.resumeAllowed(t.Context(), self, device, stopped, "needs its context", nil); err == nil {
				t.Fatal("expected the manual-resume refusal")
			}
			switch scenario {
			case "owner resumed":
				running := boxAgent(ag.SessionID)
				running.Status = proto.StatusWorking
				s.SessionsChanged(t.Context(), DeviceSessions{MachineID: ag.MachineID, Sessions: []proto.Session{running}})
			case "resumable retry":
				stopped.Capabilities.StopCause = proto.StopUnknown
				_ = s.resumeAllowed(t.Context(), self, device, stopped, "needs its context", nil)
			case "two refusals":
				stopped.SessionID = "other-agent"
				if err := s.linkTodoAgent(t.Context(), todo.ID, device.ID, stopped.SessionID, "", "", ""); err != nil {
					t.Fatal(err)
				}
				if err := s.resumeAllowed(t.Context(), self, device, stopped, "needs its context", nil); err == nil {
					t.Fatal("expected the second manual-resume refusal")
				}
			case "relinked Agent":
				if err := s.linkTodoAgent(t.Context(), todo.ID, device.ID, stopped.SessionID, "", "", ""); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := reviewErr(s, todo.ID, rolloutDecision()); err != nil {
				t.Fatal(err)
			}
			if row := listedAsk(t, s, todo.ID); row == nil || row["resume_terminal"] != nil {
				t.Fatalf("decision %v", row)
			}
		})
	}
}

func TestDecisionTerminalAfterDelegatedRework(t *testing.T) {
	s, f, leader := stoppedTaskLeader(t)
	s.todos.mu.Lock()
	s.todos.todos[leader.ID].Origin = "original-conversation"
	s.todos.mu.Unlock()
	stopped := stoppedBoxAgent(resumedTaskLeaderSession)
	stopped.Capabilities.StopCause = proto.StopUser
	f.setSessions("box", stopped)
	if _, err := runJSON(t, s, "conv1", "task_review", map[string]any{
		"todo_id": leader.ID, "verdict": "rework", "note": "finish the missing checks",
	}); err == nil || !strings.Contains(err.Error(), "user's Resume") {
		t.Fatalf("expected a manual-resume refusal for this rework, got %v", err)
	}
	if _, err := reviewErr(s, leader.ID, rolloutDecision()); err != nil {
		t.Fatal(err)
	}
	row := listedAsk(t, s, leader.ID)
	if target, _ := row["resume_terminal"].(map[string]any); target["session_id"] != stopped.SessionID {
		t.Fatalf("rework refusal did not reach the reviewer's decision: %v", row)
	}
}
