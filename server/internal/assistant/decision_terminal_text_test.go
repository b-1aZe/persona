package assistant

import (
	"testing"

	"github.com/nwverse/persona/server/internal/i18n"
)

// Old decisions can still have a terminal action among the choices. New reviews reject such options.
func setLegacyResumeOption(s *Service, id string, index int) {
	s.accept.mu.Lock()
	defer s.accept.mu.Unlock()
	a := s.accept.asks[id]
	a.Options[index].Label = legacyTerminalOption
	if index == 0 {
		a.Recommend = legacyTerminalOption
	}
}

func TestTerminalResumeTextAnswerKeepsDecisionOpen(t *testing.T) {
	st := todoTestDB(t)
	s, f, todo := newDecisionAnswerServiceOn(t, st)
	waitsForReview(t, s, f, todo.ID, "Choose the next step.")
	if _, err := reviewErr(s, todo.ID, rolloutDecision()); err != nil {
		t.Fatal(err)
	}
	setLegacyResumeOption(s, todo.ID, 1)
	a := askOf(s, todo.ID)
	round := a.AskedAt.Format(timeKeyLayout)
	calls := f.callCount()
	if result, err := s.answerDecisionText(t.Context(), todo.ID, round, legacyTerminalOption); result.taken || !manualResumeRefused(err) {
		t.Fatalf("text answer: %+v, %v", result, err)
	}
	if _, err := s.routeDecisionAnswer(t.Context(), todo.Origin, todo.ID, round, legacyTerminalOption); !manualResumeRefused(err) {
		t.Fatalf("routed answer: %v", err)
	}
	if got := askOf(s, todo.ID); !got.AcceptedAt.IsZero() || !got.DueAt.IsZero() || f.callCount() != calls {
		t.Fatalf("text answer changed the decision or reached a device: %+v", got)
	}
	if rows, err := st.ListTodoDecisions(t.Context(), todo.ID, false); err != nil || len(rows) != 0 {
		t.Fatalf("refused text written: %+v, %v", rows, err)
	}

	// Mentioning the same action in the owner's own words remains a valid answer.
	text := "Resume the rollout without opening a terminal."
	if result, err := s.answerDecisionText(t.Context(), todo.ID, round, text); err != nil || !result.taken {
		t.Fatalf("free text answer: %+v, %v", result, err)
	}
}

func TestTerminalResumeFeishuLetterKeepsDecisionOpen(t *testing.T) {
	needsLarkLayer(t)
	s, f, todo, _, notes := conclusionService(t, false)
	waitsForReview(t, s, f, todo.ID, "Choose the next step.")
	if _, err := reviewErr(s, todo.ID, rolloutDecision()); err != nil {
		t.Fatal(err)
	}
	setLegacyResumeOption(s, todo.ID, 0)
	sent := len(sentToAgent(f))
	a := askOf(s, todo.ID)
	feishuSay(t, s, f, nil, p2pText("om_resume", "A", "", a.MessageID), "")
	if got := askOf(s, todo.ID); !got.AcceptedAt.IsZero() || !got.DueAt.IsZero() || len(sentToAgent(f)) != sent {
		t.Fatalf("letter settled the terminal choice: %+v", got)
	}
	if n := notes(); len(n) == 0 || n[len(n)-1] != i18n.T(s.botLang(t.Context()), "assistant-reports.manual_terminal_resume") {
		t.Fatalf("missing manual-resume explanation: %v", n)
	}
	// An already delivered choice records the owner's actual words without a second send.
	if taken, err := s.decisionTold(t.Context(), todo.ID, legacyTerminalOption, "box", "conv1", legacyTerminalOption); err != nil || !taken || len(sentToAgent(f)) != sent {
		t.Fatalf("already relayed choice: taken %v, error %v", taken, err)
	}
}

func TestTerminalResumeTextOnOutsideDecisionReturnsToItsSource(t *testing.T) {
	e := newTodoEnv(t, nil)
	in := outsideFixture()
	in.Options[1].Label, in.Recommend = legacyTerminalOption, legacyTerminalOption
	d := raiseOutside(t, e, "release-script", in)
	a := askOf(e.s, d.AskTodoID)
	if result, err := e.s.answerDecisionText(t.Context(), d.AskTodoID, a.AskedAt.Format(timeKeyLayout), legacyTerminalOption); !result.taken || err != nil {
		t.Fatalf("outside text answer: %+v, %v", result, err)
	}
	if got := pollOutside(t, e, "release-script", d.ID); got.Answer == nil || got.Answer.Text != legacyTerminalOption {
		t.Fatalf("source did not receive the owner's words: %+v", got.Answer)
	}
}
