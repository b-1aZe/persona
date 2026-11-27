import { describe, expect, it } from "vitest";
import { approvalImpact } from "./approval-impact";
import type { Interaction } from "./types";

const card = (tool_name: string, tool_input: Interaction["tool_input"] = {}): Interaction =>
  ({ id: "pending", machine_id: "m", session_id: "s", kind: "permission", tool_name, tool_input });

describe("the effect of a tool approval", () => {
  it.each([
    ["git push origin feature", "push"], ["g'it' p\"us\"h origin feature", "push"],
    ["git${IFS}push origin feature", "push"], ["git -C repo push", "push"],
    ["cd repo && git push", "push"], ["terraform apply", "publish"], ["npm publish", "publish"],
    ["kubectl apply -f demo.yml", "publish"], ["mail team@example.com", "send"],
    ["gh issue comment 3 --body 'Ready'", "send"], ["ls -la", null], ["git status", null],
    ["pwd && ls | wc -l", null], ["echo 'git push'", null],
    ["sh -c 'custom-script'", "unknown"], ["tool-from-extension", "unknown"],
    ["ls $(custom-script)", "unknown"], ["ls; 'unfinished", "unknown"],
    ["cat <(custom-script)", "unknown"], ["npm test", "unknown"], ["", "unknown"],
  ])("%s", (command, expected) => {
    expect(approvalImpact(card("Bash", { command }))).toBe(expected);
  });

  it("keeps argv boundaries and honors the command tool's alternative input", () => {
    expect(approvalImpact(card("shell", { command: ["bash", "-lc", "git push"] }))).toBe("push");
    expect(approvalImpact(card("shell", { command: ["echo", "git push"] }))).toBeNull();
    expect(approvalImpact(card("exec_command", { cmd: "npm publish" }))).toBe("publish");
    expect(approvalImpact(card("shell", { command: ["ls", 1] }))).toBe("unknown");
    expect(approvalImpact(card("Bash", { description: "Only reads a file" }))).toBe("unknown");
  });

  it("uses structured tool names and trusted outgoing-message fields, independent of the summary", () => {
    expect(approvalImpact(card("mcp__github__push_files"))).toBe("push");
    expect(approvalImpact(card("mcp__host__deploy"))).toBe("publish");
    expect(approvalImpact(card("mail_send"))).toBe("send");
    expect(approvalImpact({ ...card("Bash"), outward_write: true })).toBe("send");
    expect(approvalImpact({ ...card("Bash"), editable_text: "Hello" })).toBe("send");
    expect(approvalImpact(card("Write", { file_path: "draft.txt", content: "git push" }))).toBeNull();
    expect(approvalImpact(card("mcp__custom__Read"))).toBe("unknown");
  });
});
