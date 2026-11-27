package assistant

import (
	"context"

	"github.com/nwverse/persona/server/internal/herdr"
	"github.com/nwverse/persona/server/internal/proto"
)

// newWorktree makes a worktree on branch of the repository cwd is in, through the machine's terminal engine ("New
// worktree…", docs/integrations/terminal.md): herdr's or Orca's own, so it is listed there and in the apps, never a bare
// `git worktree add` by the agent. The checkout goes where the engine puts them, named for the branch the way the
// dialog names it.
func (s *Service) newWorktree(ctx context.Context, mid, cwd, branch string) (proto.WorktreeCreateResult, error) {
	return s.newWorktreeOn(ctx, mid, cwd, branch, "")
}

// A nonempty checkoutHost makes only the checkout: the Agent opens a tab in its task workspace.
func (s *Service) newWorktreeOn(ctx context.Context, mid, cwd, branch, checkoutHost string) (proto.WorktreeCreateResult, error) {
	var prep proto.WorktreePrepare
	prepare := map[string]any{"cwd": cwd}
	if checkoutHost != "" {
		prepare["kind"] = checkoutHost
	}
	if err := s.call(ctx, mid, DeviceWorktreePrepare, prepare, &prep); err != nil {
		return proto.WorktreeCreateResult{}, err
	}
	var res proto.WorktreeCreateResult
	params := map[string]any{"cwd": cwd, "branch": branch,
		"path": proto.NodeJoin(prep.Path, herdr.WorktreeDirName(branch)), "for_agent": true}
	if checkoutHost != "" {
		params["kind"] = checkoutHost
		params["open_workspace"] = false
	}
	// for_agent: every caller starts an Agent in it, so the node marks the workspace's first shell as Persona's and
	// closes it with that Agent's finished terminal (#10624); an older node ignores it.
	err := s.call(ctx, mid, DeviceWorktreeCreate, params, &res)
	return res, err
}
