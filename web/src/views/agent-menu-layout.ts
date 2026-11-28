import { t } from "../i18n";
import type { MenuItem } from "../ui/menu-model";

// DESIGN_SYSTEM §3.4: both Web entry points lay out the actions they actually offer.
// Keep Web-specific session and panel actions together, in their original order.
export function groupAgentMenu(items: MenuItem[], paneItems: MenuItem[] = []): MenuItem[] {
  const remaining = new Map(items.map((item) => [item.key, item]));
  const take = (...keys: string[]) => keys.flatMap((key) => {
    const item = remaining.get(key);
    remaining.delete(key);
    return item ? [item] : [];
  });

  const top = take("back-to-chat", "stop", "seen", "rename", "pin");
  const last = take(remaining.has("close") ? "close" : "delete");
  const navigation = take("files", "git", "review", "preview", "sides", "space-agents", "attach", "takeover", "takeover-continue");
  const session = take("mute", "todo-detail", "link-todo", "relink-todo", "unlink-todo", "persona");
  const utilities = take("sid", "cwd", "terminal", "resume", "resume-terminal");
  const deletion = take("delete");

  // Panel and node contributions own their keys (including e.g. "delete").
  // Keep them out of the Agent action lookup and of its confirmation state.
  const pane = paneItems.map((item) => ({ ...item, key: `pane:${item.key}` }));
  const groups = [navigation, [...session, ...remaining.values()], utilities, pane, deletion].filter((group) => group.length);
  const children = groups.flatMap((group, index) => group.map((item, i) => (
    { ...item, divider: index > 0 && i === 0 }
  )));
  if (children.length) top.push({ key: "more", label: t("sidebar.more"), icon: "more", children, onSelect: () => {} });
  return [...top, ...last.map((item) => ({ ...item, divider: true }))];
}
