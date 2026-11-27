// The web approval card describes the requested action. Only recognized local operations skip its extra step.
import type { Interaction } from "./types";

export type ApprovalImpact = "push" | "publish" | "deploy" | "send" | "external" | "unknown";
type Impact = ApprovalImpact | null;

// Only paths with an unambiguous local spelling qualify for one-tap approval. File contents are not paths.
function localPath(path: unknown): boolean {
  if (typeof path !== "string" || !path.trim()) return false;
  const value = path.trim().replaceAll("\\", "/");
  return !value.startsWith("//") && (/^[a-z]:\//i.test(value) || !/^[^/]+:/.test(value));
}

function patchImpact(input: unknown): Impact {
  if (typeof input !== "string") return "unknown";
  const lines = input.trim().split(/\r?\n/);
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") return "unknown";
  let files = 0;
  for (const line of lines) {
    if (!line.startsWith("*** ") || line === "*** End of File") continue;
    const path = /^\*\*\* (?:(?:Add|Delete|Update) File|Move to): (.+)$/.exec(line)?.[1];
    if (!localPath(path)) return "unknown";
    files++;
  }
  return files ? null : "unknown";
}

function commandImpact([program, ...args]: string[]): Impact {
  const [verb, action] = args;
  if (program === "git") {
    let i = 0;
    let configured = false;
    while (args[i] === "-C" || args[i] === "-c") {
      if (args[i] === "-C" && !localPath(args[i + 1])) return "unknown";
      if (args[i] === "-c") configured = true;
      i += 2;
    }
    const gitVerb = args[i];
    const flags = args.slice(i + 1);
    if (gitVerb === "push") return "push";
    if (gitVerb === "send-email") return "send";
    if (configured) return "unknown";
    if (gitVerb === "status" && flags.every(a => /^(?:-s|-b|-sb|--short|--branch|--porcelain)$/.test(a))) return null;
    if ((gitVerb === "diff" || gitVerb === "log") && flags.every(a => /^(?:--stat|--name-only|--oneline|--cached|--staged|-\d+)$/.test(a))) return null;
    return "unknown";
  }
  if ((program === "docker" && verb === "push") ||
      (["npm", "pnpm", "yarn", "cargo"].includes(program) && verb === "publish") ||
      (program === "gh" && verb === "release" && action === "create")) return "publish";
  if ((["vercel", "netlify", "firebase", "wrangler"].includes(program) && verb === "deploy") ||
      (program === "kubectl" && ["apply", "delete", "replace", "rollout", "set"].includes(verb)) ||
      (program === "terraform" && ["apply", "destroy"].includes(verb))) return "deploy";
  if (["mail", "mailx", "sendmail"].includes(program) ||
      (["gh", "glab"].includes(program) && ["issue", "pr", "mr"].includes(verb) && ["comment", "review", "create"].includes(action)) ||
      (program === "lark-cli" && verb === "im" && ["+send", "+reply"].includes(action))) return "send";
  if (program === "echo" || program === "pwd") return null;
  if (["cd", "ls", "cat", "head", "tail", "wc", "mkdir", "touch"].includes(program)) {
    return args.every(localPath) ? null : "unknown";
  }
  return "unknown";
}

// Read literal shell words, joined quotes and simple command lists. Anything requiring shell evaluation,
// including substitutions, redirection or an unmatched quote, must still go through confirmation.
function shellImpact(source: string): Impact {
  const normalized = source.replace(/^[ \t\n]+|[ \t\n]+$/g, "").replace(/\$\{IFS\}|\$IFS\b/g, " ");
  const tokens = /[ \t]+|&&|\|\||[;|\n]|(?:[\w./:@%,+=*-]+|'[^']*'|"[^"\\$`]*"|\\[\w-])+/gy;
  const words: string[] = [];
  let impact: Impact = null;
  let offset = 0;
  for (const match of normalized.matchAll(tokens)) {
    const [token] = match;
    offset += token.length;
    if (/^[ \t]/.test(token)) continue;
    if (/^[;&|\n]/.test(token)) {
      if (!words.length) return "unknown";
      impact ??= commandImpact(words);
      words.length = 0;
    } else {
      words.push(token.replace(/'([^']*)'|"([^"]*)"|\\([\w-])/g, (_, single, double, escaped) => single ?? double ?? escaped));
    }
  }
  if (offset !== normalized.length || (!words.length && !normalized.endsWith(";"))) return "unknown";
  if (words.length) impact ??= commandImpact(words);
  return impact ?? (normalized !== source && source.includes("$") ? "unknown" : null);
}

export function approvalImpact(ix: Interaction): Impact {
  if (ix.kind === "screen" && ix.dialog?.command !== undefined) return typeof ix.dialog.command === "string" ? shellImpact(ix.dialog.command) : "unknown";
  if (ix.kind !== "permission") return null;
  if (ix.editable_text !== undefined) return "send";
  if (ix.outward_write) return "external";
  const tool = ix.tool_name ?? "";
  const input = ix.tool_input;
  if (input?.workdir !== undefined && !localPath(input.workdir)) return "unknown";
  if (input?.cwd !== undefined && !localPath(input.cwd)) return "unknown";
  if (["Read", "Write", "Edit", "MultiEdit"].includes(tool)) return localPath(input?.file_path) ? null : "unknown";
  if (tool === "NotebookEdit") return localPath(input?.notebook_path) ? null : "unknown";
  if (tool === "Grep" || tool === "Glob") return input?.path === undefined || localPath(input.path) ? null : "unknown";
  if (tool === "apply_patch") return patchImpact(input?.input);
  if (["Bash", "exec_command", "shell"].includes(tool)) {
    if (input?.shell || input?.env) return "unknown";
    if (input?.cmd !== undefined && input.command !== undefined) return "unknown";
    const cmd = input?.command ?? input?.cmd;
    if (typeof cmd === "string") return shellImpact(cmd);
    if (Array.isArray(cmd) && cmd.length && cmd.every(arg => typeof arg === "string")) {
      if (["sh", "bash", "/bin/sh", "/bin/bash"].includes(cmd[0]) && /^-l?c$/.test(cmd[1]) && cmd.length === 3) return shellImpact(cmd[2]);
      return commandImpact(cmd);
    }
    return "unknown";
  }
  const name = tool.split("__").pop()?.toLowerCase() ?? "";
  if (/(^|_)(push|push_files)($|_)/.test(name)) return "push";
  if (/(^|_)deploy($|_)/.test(name)) return "deploy";
  if (/(^|_)publish($|_)/.test(name)) return "publish";
  if (/(^|_)(send|reply|forward|comment|post_message)($|_)/.test(name)) return "send";
  return "unknown";
}

/** The negative answer in a command prompt read from the terminal (its own option key must be sent verbatim). */
export function declinesCommand(ix: Interaction, key: string): boolean {
  // Exact terminal option labels, independent of the browser language. i18n-ignore
  return ix.dialog?.options?.some(o => o.key === key && !o.kind && ["no", "deny", "decline", "否", "拒绝", "いいえ", "拒否"].includes(o.label.trim().toLowerCase())) ?? false;
}
