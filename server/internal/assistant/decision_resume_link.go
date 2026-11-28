package assistant

import (
	"maps"
	"slices"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

type reworkReviewerKey struct{}

// A resume refusal belongs to the conversation that tried it and the exact Agent it tried to resume.
type resumeAttempt struct {
	reviewer string
	agent    SessionRef
}

func (b *acceptBook) noteResumeAttempt(attempt resumeAttempt, ownerOnly bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !ownerOnly {
		delete(b.refusedResumes, attempt)
		return
	}
	now := time.Now().UTC()
	maps.DeleteFunc(b.refusedResumes, func(_ resumeAttempt, at time.Time) bool { return now.Sub(at) > decisionRecheckAfter })
	if b.refusedResumes == nil {
		b.refusedResumes = make(map[resumeAttempt]time.Time)
	}
	b.refusedResumes[attempt] = now
}

// A fresh node list that reports the Agent running retires the pending refusal, including after an owner resume.
func (b *acceptBook) observeResumedSessions(d DeviceSessions) {
	b.mu.Lock()
	defer b.mu.Unlock()
	maps.DeleteFunc(b.refusedResumes, func(attempt resumeAttempt, _ time.Time) bool {
		return attempt.agent.MachineID == d.MachineID && slices.ContainsFunc(d.Sessions, func(c proto.Session) bool {
			return c.SessionID == attempt.agent.SessionID && !c.Archived && !stoppedAgent(c) &&
				(c.Status == proto.StatusWorking || c.Capabilities != nil && c.Capabilities.Send)
		})
	})
}

// takeResumeTerminalLocked consumes the reviewer's pending refusals for this task. Only one current binding may
// identify the recovery target. Like a decision due for a recheck, an old refusal no longer supplies current facts.
func (b *acceptBook) takeResumeTerminalLocked(t Todo, reviewer string, now time.Time) *SessionRef {
	var target *SessionRef
	var count int
	for _, a := range t.Agents {
		ref := SessionRef{MachineID: a.MachineID, SessionID: a.SessionID}
		attempt := resumeAttempt{reviewer: reviewer, agent: ref}
		at, ok := b.refusedResumes[attempt]
		if !ok || !a.active() || at.Before(a.LinkedAt) || t.ReopenedAt != nil && at.Before(*t.ReopenedAt) || now.Sub(at) > decisionRecheckAfter {
			continue
		}
		delete(b.refusedResumes, attempt)
		target = &ref
		count++
	}
	if count == 1 {
		return target
	}
	return nil
}
