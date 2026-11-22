# Daily personal builds on macOS

Run `scripts/daily-sync.sh` from any directory. It expects the personal worktree, the upstream main ref, the fork's existing personal ref, and the native split launch agents for hub, assistant manager and Link. The source worktree that holds another feature branch can stay open. Use Go from `~/.local/go`, Node 24 and npm from `~/.local/node`, Docker, Git with non-interactive push credentials, Python 3.9+ and macOS command line tools. OrbStack must be running in the logged-in user's session. The default public health port is 18660 (`PERSONAL_HUB_PORT`). This recipe targets the standard local container and the separate hub and manager databases named in the helper.

The job fetches both refs, rejects a divergent fork, and merges upstream into personal. On conflicts the private run log lists the paths. The checkout stays in the merge so an assistant can inspect the decisions, edit and stage the paths, finish `git commit` and run the script again. A clean local commit can be retried even when upstream has no new commits. To abandon a conflicting merge deliberately, use `git merge --abort` in the personal worktree.

A detached worktree pins the tested SHA. The Web development build is embedded and compressed as in the upstream development updater. The native programs use the release tags and the official version/build/commit linker variables, with channel `dev`. The public release updater requires channel `release`. Keep Settings → Hub → Web development automatic installation off as well. The preflight checks the effective stored Web development choice. An external installer or manual replacement can still change the programs.

Checks include the full server build, the upstream server build CI lane (vet, cross-build, tunnel and SDK checks), isolated Postgres migration tests and selected assistant conversation, hub routing, edge and updater tests. A fresh test container and temporary test HOME keep fixtures separate from live data. Logs and backups are local. No credentials or hub configuration are required by the script.

Before replacement the script copies the entire binary directory, verifies regular files with SHA-256, dumps both application databases with pg_dump custom format, and restores both dumps into an isolated disposable Postgres with networking disabled. The two dumps each have their own MVCC snapshot. Normal writes may continue between snapshots. A dated private folder and its manifest stay under `~/.persona/backups`. Budget space for binaries and both databases per successful update. There is no automatic pruning.

The switch uses same-directory renames and the Mac path of the upstream hub service script (edge switch or launchctl fallback), then restarts the assistant manager and Link. Verification checks the public health stamp, a fresh assistant bus registration at the same version, launchd state, the Web page and its JavaScript entry. The rollback journal survives an interrupted deploy. The next invocation handles it first. On success the script pushes only personal without force. A failed push is retried on the next run even when the healthy build is already live.

Stdout contains one final line. `UPDATED old→new` and `NO_CHANGE` succeed. `CONFLICT`, `BUILD_FAIL`, `TEST_FAIL` and automatic `DEPLOY_ROLLED_BACK` exit nonzero. `BUSY`, `SYNC_FAIL`, `BACKUP_FAIL`, `PUSH_FAIL` and `ROLLBACK_FAIL` identify failures that would otherwise be misreported. See `~/.persona/personal-sync/*.log` and the matching backup manifest. After rollback, inspect the failure before retrying.

## Operations

For a user LaunchAgent, set ProgramArguments to the absolute path of the executable shell script, StartCalendarInterval to the chosen local hour/minute, and these output paths to private files in `~/.persona/personal-sync`. Load the plist with `launchctl bootstrap "gui/$(id -u)" <plist>`. A calendar run missed during sleep runs at wake when launchd can deliver it. An overlapping manual run reports BUSY.

To restore the executable set and verify its services, pass the chosen absolute backup path. To prevent the next daily run from installing a different commit, unload the daily agent first.

```sh
launchctl bootout "gui/$(id -u)/com.persona.personal-daily-sync"
~/coding/persona-personal/scripts/daily-sync.sh --rollback "$HOME/.persona/backups/<snapshot>"
```

The normal rollback leaves accepted post-upgrade database writes in place. If the old version cannot use the migrated schema, stop writers and restore **both** dumps together as described in the deployment report. Preserve the post-upgrade databases for reconciliation before switching back. Never restore a dump into a nonempty live database.

[Native upgrades](../docs/operations/upgrade.md) · [Hub restarts](../docs/operations/hub-restart.md) · [Update channels](../docs/operations/hub-update.md) · [Mac signing and privacy permissions](../docs/operations/mac-node-signing.md)
