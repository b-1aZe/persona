package assistant

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nwverse/persona/server/internal/i18n"
)

// Terminal recovery on a decision (#13413).

const legacyTerminalOption = "Resume the Agent on its terminal page"

func manualResumeRefused(err error) bool {
	var m *i18n.Message
	return errors.As(err, &m) && m.Key == "assistant-reports.manual_terminal_resume"
}

// Past its deadline, an older reversible decision that recommends the owner's terminal Resume has no default the hub
// can take: it is marked handled and reminded once, not refused and reminded again on every sweep.
func TestLegacyTerminalResumeDecisionRemindedOnceAtDeadline(t *testing.T) {
	for _, tc := range []struct{ lang, label string }{
		{"en", legacyTerminalOption},
		{"zh-Hans", "在终端上恢复 Agent"},
		{"ja", "ターミナルでエージェントを再開"},
	} {
		t.Run(tc.lang, func(t *testing.T) {
			at := time.Now().UTC().Add(-time.Hour)
			e := dismissalEnv(t, &memStore{}, at, true)
			e.s.todos.todos["task"].Origin = "conv"
			a := e.s.accept.asks["task"]
			e.f.mu.Lock()
			e.f.hello.Locale = tc.lang
			e.f.mu.Unlock()
			a.Recommend, a.Options[0].Label = tc.label, tc.label
			if row := e.s.todoAsks(t.Context())["task"]; row.Default != defaultNever {
				t.Errorf("manual recommendation advertised as default %q", row.Default)
			}
			for range 3 {
				e.s.sweepTaskDeadlines(time.Now())
			}
			cur, _ := e.s.askCopy("task")
			if cur.DueAt.IsZero() || !cur.AcceptedAt.IsZero() || cur.ByDefault {
				t.Errorf("deadline not handled as a reminder: %+v", cur)
			}
			pushes := e.f.pushed()
			if len(pushes) != 1 {
				t.Fatalf("%d decision pushes for 3 sweeps, want 1", len(pushes))
			}
			l := e.s.lang(t.Context())
			want := i18n.T(l, "assistant-reports.deadline_manual_resume", i18n.Args{"when": a.Deadline.In(e.s.location(t.Context())).Format("01-02 15:04")})
			if !strings.Contains(pushes[0].Body, want) {
				t.Fatalf("missing manual reminder %q in %q", want, pushes[0].Body)
			}
		})
	}
}

// The owner's press on an older decision's terminal Resume (its OK, or the option itself) is refused before any answer
// is prepared or saved: the decision, its Don't handle and the stored settings stay exactly as they were.
func TestLegacyTerminalResumePressRefusedBeforeAnyWrite(t *testing.T) {
	for _, recommended := range []bool{true, false} {
		t.Run(map[bool]string{true: "recommended", false: "option"}[recommended], func(t *testing.T) {
			at := time.Now().UTC().Add(-time.Hour)
			st := &memStore{}
			e := dismissalEnv(t, st, at, true)
			a := e.s.accept.asks["task"]
			a.Options[1].Label = legacyTerminalOption
			if recommended {
				a.Recommend = legacyTerminalOption
				a.Options[0], a.Options[1] = a.Options[1], a.Options[0]
			}
			dismissed := dismissReview(t, e, at)
			before, _ := e.s.askCopy("task")
			puts, calls := st.putCount(), e.f.callCount()
			if recommended {
				if _, err := e.s.acceptTry(t.Context(), "task", ""); !manualResumeRefused(err) {
					t.Fatalf("OK on a terminal Resume: %v", err)
				}
			}
			if _, err := e.s.chooseOption(t.Context(), "task", before.AskedAt.Format(timeKeyLayout), legacyTerminalOption); !manualResumeRefused(err) {
				t.Fatalf("terminal Resume chosen: %v", err)
			}
			if got := st.putCount(); got != puts {
				t.Fatalf("a refused press wrote %d settings", got-puts)
			}
			if after, _ := e.s.askCopy("task"); !reflect.DeepEqual(before, after) {
				t.Fatalf("a refused press changed the decision: %+v", after)
			}
			if e.f.sent() != 0 || e.f.callCount() != calls {
				t.Fatal("a refused press reached a device")
			}
			list := []listedTodo{{Todo: todoNow(e.s, "task")}}
			if err := e.s.listDecisionReviews(t.Context(), list); err != nil || list[0].DecisionReview == nil ||
				list[0].DecisionReview.DismissalID != dismissed.DismissalID {
				t.Fatalf("a refused press undid Don't handle: %+v %v", list[0].DecisionReview, err)
			}
		})
	}
}

// A manual round replacing a due recommendation gets its own single reminder.
func TestTerminalResumeReplacesDueDefault(t *testing.T) {
	at := time.Now().UTC().Add(-time.Hour)
	e := dismissalEnv(t, &memStore{}, at, true)
	e.s.todos.todos["task"].Origin = "conv"
	e.s.deadlineDefaultHook = func(id string) {
		e.s.accept.mu.Lock()
		defer e.s.accept.mu.Unlock()
		a := e.s.accept.asks[id]
		a.AskedAt = a.AskedAt.Add(time.Second)
		a.Recommend, a.Options[0].Label = legacyTerminalOption, legacyTerminalOption
	}
	e.s.sweepTaskDeadlines(time.Now())
	e.s.deadlineDefaultHook = nil
	if got := len(e.f.pushed()); got != 0 {
		t.Fatalf("old default triggered %d reminders on the replacement round", got)
	}
	e.s.sweepTaskDeadlines(time.Now())
	if got := len(e.f.pushed()); got != 1 {
		t.Fatalf("new round received %d reminders, want 1", got)
	}
}

func TestTerminalResumeDeadlineRespectsDismissalAndRecheck(t *testing.T) {
	for _, scenario := range []string{"dismissed during sweep", "due for fresh review"} {
		t.Run(scenario, func(t *testing.T) {
			now := time.Now().UTC()
			at := now.Add(-time.Hour)
			if scenario == "due for fresh review" {
				at = now.Add(-decisionRecheckAfter - time.Minute)
			}
			e := dismissalEnv(t, &memStore{}, at, true)
			e.s.todos.todos["task"].Origin = "conv"
			a := e.s.accept.asks["task"]
			a.Recommend, a.Options[0].Label = legacyTerminalOption, legacyTerminalOption
			if scenario == "dismissed during sweep" {
				e.s.deadlineDefaultHook = func(string) { dismissReview(t, e, at) }
			}
			e.s.sweepTaskDeadlines(now)
			if got := len(e.f.pushed()); got != 0 || !a.DueAt.IsZero() {
				t.Fatalf("handled a quiet deadline: pushes %d, handled at %v", got, a.DueAt)
			}
		})
	}
}
