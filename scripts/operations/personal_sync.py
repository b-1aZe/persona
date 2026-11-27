"""Daily maintenance of the personal branch on a native macOS split install."""
from __future__ import annotations

import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess as sp
import sys
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
DATA = Path.home() / ".persona"
STATE = DATA / "personal-sync"
BIN = DATA / "bin"
BACKUPS = DATA / "backups"
PENDING = STATE / "pending.json"
PROGRAMS = ("personad", "persona-hub", "persona-manager", "persona-link")
AGENTS = {"hub": "persona-hub", "manager.assistant": "persona-manager", "link": "persona-link"}
DATABASES = ("persona", "persona_manager")
PG = "persona-postgres"
HTTP = "http://127.0.0.1:" + os.getenv("PERSONAL_HUB_PORT", "18660")
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))
BAD = "SYNC_FAIL"


def cmd(*args, cwd=ROOT, capture=False, timeout=900, **kw):
    return sp.run(args, cwd=cwd, check=True, timeout=timeout,
                  stdout=sp.PIPE if capture else kw.pop("stdout", None), **kw)


def out(*args, **kw):
    return cmd(*args, capture=True, **kw).stdout.decode().strip()


def save(path, obj):
    temp = path.with_suffix(".tmp")
    with temp.open("w") as f:
        json.dump(obj, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def health():
    with LOCAL.open(HTTP + "/api/v1/health", timeout=3) as f:
        info = json.load(f)
    if info.get("ok") is not True:
        raise ValueError("hub is unhealthy")
    return {key: info[key] for key in ("version", "commit", "channel", "build")}


def agent(name):
    return f"gui/{os.getuid()}/com.persona.{name}"


def restart(name):
    cmd("launchctl", "kickstart", "-k", agent(name), timeout=60)


def running(name):
    return "state = running" in out("launchctl", "print", agent(name))


def preflight():
    for name, program in AGENTS.items():
        p = Path.home() / "Library/LaunchAgents" / f"com.persona.{name}.plist"
        job = plistlib.loads(p.read_bytes())
        executable = job.get("Program") or job["ProgramArguments"][0]
        if Path(executable) != BIN / program or not running(name):
            raise ValueError(f"unexpected service {name}")
    if any((BIN / p).is_symlink() or not (BIN / p).is_file() for p in PROGRAMS):
        raise ValueError("expected four regular installed programs")
    if out("docker", "port", PG, "5432/tcp") != "127.0.0.1:18661":
        raise ValueError("unexpected database port mapping")
    if sql("persona", "SELECT EXISTS (SELECT 1 FROM hub_settings WHERE key='hub_update' "
           "AND value->>'source'='web-dev' AND value->>'development_auto'='true')") != "f":
        raise ValueError("turn off the competing Web development updater")
    names = sql("postgres", "SELECT datname FROM pg_database WHERE NOT datistemplate "
                "AND datname <> 'postgres' ORDER BY datname").splitlines()
    if not set(DATABASES) <= set(names):
        raise ValueError("expected hub and manager databases")


def sql(db, query):
    return out("docker", "exec", PG, "psql", "-XAt", "-v", "ON_ERROR_STOP=1",
               "-U", "persona", "-d", db, "-c", query)


@contextlib.contextmanager
def fixture(tmp):
    name = "persona-sync-test-" + uuid.uuid4().hex[:12]
    cmd("docker", "run", "--detach", "--name", name, "-e", "POSTGRES_USER=persona",
        "-e", "POSTGRES_PASSWORD=ci-only", "-e", "POSTGRES_DB=persona_test",
        "-p", "127.0.0.1::5432", "postgres:18-alpine")
    try:
        file = tmp / "database.json"
        cmd("python3", "scripts/ci/postgres.py", name, file)
        yield name, file
    finally:
        cmd("docker", "rm", "-fv", name)


def build_test(src, stage, expected, fixture_file):
    global BAD
    web, server = src / "web", src / "server"
    BAD = "BUILD_FAIL"
    cmd("npm", "ci", "--no-audit", "--no-fund", cwd=web)
    cmd("npm", "run", "build:development", cwd=web)
    embed = server / "internal/hub/webdist"
    shutil.copytree(web / "dist", embed, dirs_exist_ok=True)
    cmd("go", "run", "./internal/webasset/precompress", "internal/hub/webdist", cwd=server)
    cmd("go", "generate", "./internal/runtimepkg", cwd=server)
    cmd("go", "build", "./...", cwd=server)
    flags = (f"-s -w -X main.version={expected['version']} -X main.channel=dev "
             f"-X main.build={expected['build']} -X main.commit={expected['commit']}")
    tags = (server / "build-tags.txt").read_text().strip()
    for name in PROGRAMS:
        binary = stage / name
        cmd("go", "build", "-trimpath", "-tags", tags, "-ldflags", flags, "-o", binary,
            "./cmd/" + name, cwd=server, env=dict(os.environ, CGO_ENABLED="0"))
        cmd("codesign", "--force", "--sign", "-", "--identifier", "com.nwverse." + name, binary)
        cmd("codesign", "--verify", "--strict", binary)
        if out(binary, "version") != expected["version"]:
            raise ValueError(f"incorrect stamp on {name}")
    BAD = "TEST_FAIL"
    cmd("bash", "scripts/ci/server.sh", "build", cwd=src, timeout=3600)
    isolated = ["python3", src / "scripts/test/server_test_env.py", "--database-file", fixture_file,
                "--", "go", "test", "-count=1", "-timeout=8m", "-p", "2"]
    cmd(*isolated, "./internal/update", "./internal/hubedge", "./internal/managerupdate", cwd=server)
    cmd(*isolated, "-run", "^Test(Migration|Migrate|OpenUpToDate|RouteScopes|RelayedExtensions|"
        "MainChat|ChatReply|GoldenChatReply)", "./internal/db", "./internal/hub", "./internal/assistant", cwd=server)


@contextlib.contextmanager
def restore_fixture():
    name = "persona-sync-restore-" + uuid.uuid4().hex[:12]
    cmd("docker", "run", "-d", "--network", "none", "--name", name, "-e",
        "POSTGRES_USER=persona", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e", "POSTGRES_DB=postgres", "postgres:18-alpine", "-c", "listen_addresses=")
    try:
        for _ in range(60):
            # The init process uses a temporary postmaster before its final exec.
            if out("docker", "exec", name, "cat", "/proc/1/comm") == "postgres":
                try:
                    cmd("docker", "exec", name, "pg_isready", "-U", "persona", "-d", "postgres")
                    break
                except sp.CalledProcessError:
                    pass
            time.sleep(1)
        yield name
    finally:
        cmd("docker", "rm", "-fv", name)


def backup(old, verifier):
    BACKUPS.mkdir(mode=0o700, exist_ok=True)
    path = Path(tempfile.mkdtemp(prefix=dt.datetime.now().strftime("personal-%Y%m%d-%H%M%S-"), dir=BACKUPS))
    cmd("ditto", BIN, path / "bin")
    hashes = {}
    for item in BIN.rglob("*"):
        if item.is_file() and not item.is_symlink():
            rel = str(item.relative_to(BIN))
            hashes[rel] = digest(item)
            if hashes[rel] != digest(path / "bin" / rel):
                raise ValueError("binary backup differs")
    for db in DATABASES:
        archive = path / (db + ".dump")
        with archive.open("wb") as stream:
            cmd("docker", "exec", PG, "pg_dump", "-U", "persona", "-Fc", "-d", db, stdout=stream)
        cmd("docker", "exec", verifier, "createdb", "-U", "persona", db)
        with archive.open("rb") as stream:
            cmd("docker", "exec", "-i", verifier, "pg_restore", "--exit-on-error",
                "-U", "persona", "-d", db, stdin=stream)
        hashes[archive.name] = digest(archive)
    save(path / "manifest.json", {"health": old, "sha256": hashes})
    print("Verified binary backup and restored both dumps in the disposable fixture:", path, flush=True)
    return path


def replace(source, dest):
    with tempfile.NamedTemporaryFile(dir=dest.parent, prefix=".personal-", delete=False) as f:
        temp = Path(f.name)
    try:
        cmd("ditto", source, temp)
        os.replace(temp, dest)
    finally:
        temp.unlink(missing_ok=True)


def wait_ready(expected, offset):
    limit = time.monotonic() + 120
    log = DATA / "hub.log"
    while time.monotonic() < limit:
        try:
            with log.open("rb") as f:
                f.seek(offset if log.stat().st_size >= offset else 0)
                bus = [s for s in f.read().splitlines() if b"bus: [assistant] connected:" in s
                       or b"bus: [assistant] disconnected" in s]
            if (health() == expected and bus and b'connected: host' in bus[-1]
                    and f'version "{expected["version"]}"'.encode() in bus[-1]
                    and all(running(name) for name in AGENTS)):
                with LOCAL.open(HTTP + "/", timeout=3) as resp:
                    page = resp.read(1024 * 1024)
                asset = re.search(rb'<script[^>]+src="(?:\./|/)(assets/[A-Za-z0-9_./-]+\.js)"', page)
                if asset:
                    with LOCAL.open(HTTP + "/" + asset[1].decode(), timeout=4) as resp:
                        if "javascript" in resp.headers.get("Content-Type", "") and resp.read(1):
                            return
        except (OSError, ValueError, sp.SubprocessError):
            pass
        time.sleep(1)
    raise RuntimeError("hub stamp, manager bus, launch agents or Web asset did not become ready")


def rollback(path):
    manifest = json.loads((path / "manifest.json").read_text())
    for name in PROGRAMS:
        if digest(path / "bin" / name) != manifest["sha256"][name]:
            raise ValueError("rollback checksum mismatch")
    offset = (DATA / "hub.log").stat().st_size
    for name in PROGRAMS:
        replace(path / "bin" / name, BIN / name)
        prev = name + ".prev"
        if (path / "bin" / prev).is_file():
            replace(path / "bin" / prev, BIN / prev)
        elif name != "persona-link":
            (BIN / prev).unlink(missing_ok=True)
    for name in AGENTS:
        restart(name)
    wait_ready(manifest["health"], offset)
    print("Restored previous service versions", flush=True)


def deploy(stage, expected, path):
    global BAD
    offset = (DATA / "hub.log").stat().st_size
    save(PENDING, str(path))
    try:
        for name in PROGRAMS:
            if name != "persona-link":
                replace(path / "bin" / name, BIN / (name + ".prev"))
            replace(stage / name, BIN / name)
        cmd("bash", "scripts/deploy/hub-systemd.sh", env=dict(os.environ, PERSONA_HOME=str(DATA)))
        restart("manager.assistant")
        restart("link")
        wait_ready(expected, offset)
    except BaseException:
        BAD = "ROLLBACK_FAIL"
        rollback(path)
        PENDING.unlink()
        BAD = "DEPLOY_ROLLED_BACK"
        raise
    PENDING.unlink()


USAGE = "usage: daily-sync.sh [--upstream COMMIT | --rollback BACKUP]"


def sync(args):
    global BAD
    if args and (len(args) != 2 or args[0] not in ("--rollback", "--upstream")):
        raise ValueError(USAGE)
    target = args[1] if args and args[0] == "--upstream" else "upstream/main"
    if args and args[0] == "--upstream":
        args = []
    if PENDING.exists() or args:
        path = Path(json.loads(PENDING.read_text())) if PENDING.exists() else Path(args[1]).resolve()
        if path.parent != BACKUPS or not path.name.startswith("personal-"):
            raise ValueError("expected a personal snapshot")
        BAD = "ROLLBACK_FAIL"
        rollback(path)
        PENDING.unlink(missing_ok=True)
        return "DEPLOY_ROLLED_BACK", int(not args)
    if out("git", "branch", "--show-current") != "personal":
        raise ValueError("expected personal checkout")
    merge_head = Path(out("git", "rev-parse", "--git-path", "MERGE_HEAD"))
    before = None
    if not merge_head.exists():
        if out("git", "status", "--porcelain"):
            raise ValueError("personal checkout has local changes")
        cmd("git", "fetch", "--no-tags", "upstream", "refs/heads/main:refs/remotes/upstream/main")
        cmd("git", "fetch", "--no-tags", "origin", "refs/heads/personal:refs/remotes/origin/personal")
        cmd("git", "merge-base", "--is-ancestor", "origin/personal", "HEAD")
        # A pinned commit must come from upstream main, never from another branch.
        cmd("git", "merge-base", "--is-ancestor", target, "upstream/main")
        before = out("git", "rev-parse", "HEAD")
        try:
            cmd("git", "merge", "--no-edit", target)
        except sp.CalledProcessError:
            if not merge_head.exists():
                raise
    if merge_head.exists():
        print("Unfinished merge. Unmerged paths:", out("git", "diff", "--name-only", "--diff-filter=U"), sep="\n")
        return "CONFLICT", 1
    head = out("git", "rev-parse", "HEAD")
    preflight()
    old = health()
    if old["commit"] == head and old["channel"] == "dev":
        if any(out(BIN / name, "version") != old["version"] for name in PROGRAMS):
            raise ValueError("installed programs differ from the live build")
        BAD = "PUSH_FAIL"
        cmd("git", "push", "origin", "refs/heads/personal:refs/heads/personal")
        return "NO_CHANGE", 0
    build = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d%H%M")
    expected = dict(version=f"personal-{head[:12]}-{build}", commit=head, channel="dev", build=int(build))
    with tempfile.TemporaryDirectory(prefix="personal-build-") as temp:
        tmp = Path(temp)
        src = tmp / "source"
        cmd("git", "worktree", "add", "--detach", "--quiet", src, head)
        try:
            try:
                with fixture(tmp) as (_, file):
                    build_test(src, tmp, expected, file)
            except BaseException:
                # Drop the merge this run made, so the branch keeps matching the live build
                # and the next run merges upstream again from the tested version.
                if before and before != head and out("git", "rev-parse", "HEAD") == head:
                    cmd("git", "reset", "--hard", "--quiet", before)
                    print("Reset personal to", before, flush=True)
                raise
            with restore_fixture() as verifier:
                BAD = "BACKUP_FAIL"
                old = health()
                path = backup(old, verifier)
                if out("git", "rev-parse", "HEAD") != head or out("git", "status", "--porcelain"):
                    raise ValueError("personal checkout changed during the build")
                if health() != old:
                    raise ValueError("running build changed during backup")
                deploy(tmp, expected, path)
        finally:
            cmd("git", "worktree", "remove", "--force", src)
    BAD = "PUSH_FAIL"
    cmd("git", "push", "origin", "refs/heads/personal:refs/heads/personal")
    return f"UPDATED {old['version']}→{expected['version']}", 0


def main():
    os.umask(0o077)
    STATE.mkdir(mode=0o700, exist_ok=True)
    with (STATE / "sync.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("BUSY")
            return 1
        log = STATE / (dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".log")
        with log.open("w", buffering=1) as stream:
            terminal = os.dup(1)
            os.dup2(stream.fileno(), 1)
            os.dup2(stream.fileno(), 2)
            def interrupted(signum, frame):
                raise InterruptedError
            signal.signal(signal.SIGTERM, interrupted)
            try:
                status, code = sync(sys.argv[1:])
            except BaseException as exc:
                print("Stopped:", type(exc).__name__, str(exc), file=stream)
                status, code = BAD, 1
            print(status, flush=True)
            os.write(terminal, (status + "\n").encode())
            os.close(terminal)
            return code


if __name__ == "__main__":
    sys.exit(main())
