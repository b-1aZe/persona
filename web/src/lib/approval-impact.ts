// The web approval card describes the requested action. Only recognized local operations skip its extra step.
import type { Interaction } from "./types";

export type ApprovalImpact = "push" | "publish" | "send" | "unknown";
type Impact = ApprovalImpact | null;

function commandImpact([program, ...args]: string[]): Impact {
  const [verb, action] = args;
  if (program === "git") {
    let i = 0;
    while (args[i] === "-C" || args[i] === "-c") i += 2;
    if (args[i] === "push") return "push";
    if (args[i] === "send-email") return "send";
    if (verb === "status" && args.slice(1).every(a => /^(?:-s|-b|-sb|--short|--branch|--porcelain)$/.test(a))) return null;
    if ((verb === "diff" || verb === "log") && args.slice(1).every(a => /^(?:--stat|--name-only|--oneline|--cached|--staged|-\d+)$/.test(a))) return null;
    return "unknown";
  }
  if ((program === "docker" && verb === "push") ||
      (["npm", "pnpm", "yarn", "cargo"].includes(program) && verb === "publish") ||
      (["vercel", "netlify", "firebase", "wrangler"].includes(program) && verb === "deploy") ||
      (program === "kubectl" && ["apply", "delete", "replace", "rollout", "set"].includes(verb)) ||
      (program === "terraform" && ["apply", "destroy"].includes(verb)) ||
      (program === "gh" && verb === "release" && action === "create")) return "publish";
  if (["mail", "mailx", "sendmail"].includes(program) ||
      (["gh", "glab"].includes(program) && ["issue", "pr", "mr"].includes(verb) && ["comment", "review", "create"].includes(action)) ||
      (program === "lark-cli" && verb === "im" && ["+send", "+reply"].includes(action))) return "send";
  if (["cd", "ls", "pwd", "cat", "head", "tail", "wc", "echo", "mkdir", "touch"].includes(program)) return null;
  return "unknown";
}

// Read literal shell words, joined quotes and simple command lists. Anything requiring shell evaluation,
// including substitutions, redirection or an unmatched quote, must still go through confirmation.
function shellImpact(source: string): Impact {
  const normalized = source.replace(/^[ \t\n]+|[ \t\n]+$/g, "").replace(/\$\{IFS\}|\$IFS\b/g, " ").replace(/\\\n/g, "");
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
  if (offset !== normalized.length || !words.length) return "unknown";
  return impact ?? commandImpact(words) ?? (normalized !== source && source.includes("$") ? "unknown" : null);
}

export function approvalImpact(ix: Interaction): Impact {
  if (ix.kind === "screen" && ix.dialog?.command) return shellImpact(ix.dialog.command);
  if (ix.kind !== "permission") return null;
  if (ix.outward_write || ix.editable_text !== undefined) return "send";
  const tool = ix.tool_name ?? "";
  if (["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "apply_patch"].includes(tool)) return null;
  if (["Bash", "exec_command", "shell"].includes(tool)) {
    const input = ix.tool_input;
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
  if (/(^|_)(deploy|publish)($|_)/.test(name)) return "publish";
  if (/(^|_)(send|reply|forward|comment|post_message)($|_)/.test(name)) return "send";
  return "unknown";
}

/** The negative answer in a command prompt read from the terminal (its own option key must be sent verbatim). */
export function declinesCommand(ix: Interaction, key: string): boolean {
  return ix.dialog?.options?.some(o => o.key === key && !o.kind && o.label.trim().toLowerCase() === "no") ?? false;
}
