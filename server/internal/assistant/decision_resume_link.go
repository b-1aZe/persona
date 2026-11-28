package assistant

import (
	"maps"
	"slices"
	"time"

	"github.com/nwverse/persona/server/internal/proto"
)

type reworkReviewerKey struct{}

// A supervisor's attempt to resume one of its task's Agents. A node update or closing the task can retire the
// attempt even while the hub is still reading an archived session's stop cause.
type resumeAttempt struct {
	todo, reviewer string
	agent          SessionRef
}

type resumeEvidence struct {
	at        time.Time
	ownerOnly bool
}

func (b *todoBook) beginResumeAttempt(sender, reviewer, machine string, c proto.Session) (resumeAttempt, *resumeEvidence) {
	b.mu.Lock()
	defer b.mu.Unlock()
	id := b.activeBySession[[2]string{machine, c.SessionID}]
	t := b.todos[id]
	if t == nil || t.DoneAt != nil || othersTask(c, *t, sender) != nil {
		return resumeAttempt{}, nil
	}
	now := time.Now().UTC()
	maps.DeleteFunc(b.refusedResumes, func(_ resumeAttempt, e *resumeEvidence) bool { return now.Sub(e.at) > decisionRecheckAfter })
	if b.refusedResumes == nil {
		b.refusedResumes = make(map[resumeAttempt]*resumeEvidence)
	}
	attempt := resumeAttempt{todo: id, reviewer: reviewer, agent: SessionRef{MachineID: machine, SessionID: c.SessionID}}
	e := &resumeEvidence{at: now}
	b.refusedResumes[attempt] = e
	return attempt, e
}

func (b *todoBook) finishResumeAttempt(attempt resumeAttempt, e *resumeEvidence, ownerOnly bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.refusedResumes[attempt] != e {
		return // a newer attempt, live session update or closed task superseded this lookup
	}
	if ownerOnly {
		e.ownerOnly = true
	} else {
		delete(b.refusedResumes, attempt)
	}
}

func (b *todoBook) observeResumedSessions(d DeviceSessions) {
	b.mu.Lock()
	defer b.mu.Unlock()
	maps.DeleteFunc(b.refusedResumes, func(attempt resumeAttempt, _ *resumeEvidence) bool {
		return attempt.agent.MachineID == d.MachineID && slices.ContainsFunc(d.Sessions, func(c proto.Session) bool {
			if c.SessionID != attempt.agent.SessionID || c.Archived || stoppedAgent(c) {
				return false
			}
			switch c.Status {
			case proto.StatusWorking, proto.StatusIdle, proto.StatusDone, proto.StatusBlocked:
				return true
			}
			return c.Capabilities != nil && c.Capabilities.Send
		})
	})
}

// takeResumeTerminal consumes confirmed refusals for this review. Only one current binding can identify the target.
func (b *todoBook) takeResumeTerminal(id, reviewer string, now time.Time) *SessionRef {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.todos[id]
	if t == nil || t.DoneAt != nil {
		return nil
	}
	var target *SessionRef
	var count int
	for attempt, e := range b.refusedResumes {
		if now.Sub(e.at) > decisionRecheckAfter {
			delete(b.refusedResumes, attempt)
			continue
		}
		if attempt.todo != id || attempt.reviewer != reviewer || !e.ownerOnly {
			continue
		}
		delete(b.refusedResumes, attempt)
		a, bound := findActiveLinkedAgent(*t, attempt.agent.MachineID, attempt.agent.SessionID)
		if bound && !e.at.Before(a.LinkedAt) {
			target = &attempt.agent
			count++
		}
	}
	if count == 1 {
		return target
	}
	return nil
}
