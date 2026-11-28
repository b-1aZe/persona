// Run against a fresh scripts/mock/mock_hub.py with MOCK_ECHO_SENT=1 and the web build pointing at it.
// node web/e2e/reply-image-comments.mjs <loopback web URL> <loopback mock URL> [screenshot directory]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { chromium } from "playwright-core";

const [web, hub, shots] = process.argv.slice(2);
for (const url of [web, hub]) assert.match(url ?? "", /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/);
if (shots) await mkdir(shots, { recursive: true });

const agent = "macbook/a1f3c2d4-0000-4000-8000-000000000001";
const mock = async (path) => {
  const response = await fetch(hub + path);
  assert.equal(response.status, 200);
  return response.json();
};
const main = await mock("/api/v1/assistant");
const assistant = main.machine_id + "/" + main.main;
const first = "spring/visits.svg";
const second = "summer/visits.svg";
const copy = {
  en: { topic: "Garden visits", spring: "Spring", summer: "Summer", note: "Please revise the legend." },
  "zh-Hans": { topic: "花园访客", spring: "春季", summer: "夏季", note: "请改图例。" },
  ja: { topic: "庭園の来場者", spring: "春", summer: "夏", note: "凡例を変更してください。" },
};
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: "chrome" });

async function exercise(session, language, theme, verifySend) {
  const { topic, spring, summer, note } = copy[language];
  const context = await browser.newContext({
    viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, colorScheme: theme,
    locale: language, serviceWorkers: "block", reducedMotion: "reduce",
  });
  try {
    await context.addInitScript(({ language, theme }) => {
      localStorage.setItem("persona.token", "mock");
      localStorage.setItem("persona.language", language);
      localStorage.setItem("persona.theme", theme);
    }, { language, theme });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    await page.route("**/*", (route) => new URL(route.request().url()).origin === web ? route.continue() : route.abort());
    await page.route("**/file/download?**", (route) => {
      const current = new URL(route.request().url()).searchParams.get("path");
      if (![first, second].some((src) => current?.endsWith(src))) return route.fallback();
      const points = current.endsWith(first) ? "32,126 81,106 132,110 182,68 232,81 282,54" : "32,143 81,121 132,132 182,85 232,102 282,58";
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="312" height="210" viewBox="0 0 312 210">
          <rect width="312" height="210" fill="#f7fbfa"/><g font-family="sans-serif" fill="#1f4842">
          <text x="26" y="34" font-size="18">${topic}</text>
          <path d="M32 65H282 M32 100H282 M32 135H282 M32 162H282" stroke="#cfdfdd" fill="none"/>
          <polyline points="${points}" fill="none" stroke="#147d73" stroke-width="4" stroke-linejoin="round"/>
          <path d="M32 187H59" stroke="#147d73" stroke-width="4"/><text x="70" y="192" font-size="15">${current.endsWith(first) ? spring : summer}</text></g></svg>`,
      });
    });
    const path = session === assistant ? "/persona" : "/s/" + session;
    let subscribed = false;
    page.on("websocket", (socket) => {
      if (!socket.url().includes("/api/v1/ws")) return;
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "subscribe" && frame.machine_id + "/" + frame.session_id === session) subscribed = true;
      });
    });
    await page.goto(web + path);
    await expect.poll(() => subscribed, { timeout: 60000 }).toBe(true);
    assert.equal(await page.locator("html").getAttribute("lang"), language);
    assert.equal(await page.locator("html").evaluate((el) => el.classList.contains("dark")), theme === "dark");
    await page.locator("[data-chat-scroll] [data-answer]").last().waitFor({ timeout: 60000 });
    const query = new URLSearchParams({
      user: topic,
      text: `${topic}\n\n![${spring}](${first})\n![${summer}](${second})`,
    });
    await mock("/mock/say?" + query);
    const fetchItems = async () => (await mock(`/api/v1/sessions/${session}/items`)).items;
    const source = (await fetchItems()).findLast((item) => item.role === "assistant" && item.text === query.get("text")).id;
    const reply = page.locator(`[data-answer][data-items="${source}"]`);
    const paragraph = reply.getByText(topic, { exact: true });
    const sent = [];
    page.on("response", (res) => {
      if (res.request().method() === "POST" && res.url().endsWith("/messages")) sent.push(res.status());
    });
    const editor = page.locator("[data-comment-bar] textarea");
    const save = page.locator("[data-comment-save]");
    if (verifySend) {
      await paragraph.evaluate((el) => {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      });
      await editor.fill("Keep the heading.");
      await save.click();
    }
    const depthBeforeViewer = await page.evaluate(() => history.state?.personaOverlayDepth ?? 0);
    await reply.getByRole("button", { name: spring, exact: true }).press("Enter");
    await expect(page.getByRole("dialog", { name: /1 \/ 2/ })).toBeVisible();
    await page.keyboard.press("ArrowRight");
    const viewer = page.getByRole("dialog", { name: /2 \/ 2/ });
    await expect(viewer.locator("img")).toBeVisible();
    await page.keyboard.press("+");
    await expect.poll(() => viewer.locator("img").evaluate((img) => Number(img.style.scale))).toBeGreaterThan(1);
    await page.keyboard.press("0");
    const commentName = /^(Comment on image|评论图片|画像にコメント)$/;
    const comment = viewer.getByRole("button", { name: commentName });
    for (const control of await viewer.getByRole("button").all()) {
      if (!await control.isVisible()) continue;
      const box = await control.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= 360, `${await control.getAttribute("aria-label")} outside the 360px viewport: ${box.x} + ${box.width}`);
    }
    if (shots) await page.screenshot({ path: join(shots, `${language}-${theme}-action.png`), animations: "disabled" });
    await comment.press("Enter", { timeout: 4000 });
    await expect(editor).toBeFocused();
    await editor.fill(note);
    await expect(editor).toBeInViewport();
    if (shots) await page.screenshot({ path: join(shots, `${language}-${theme}.png`), animations: "disabled" });
    await save.click();
    await expect(editor).toBeHidden();
    await page.keyboard.press("ArrowLeft");
    if (verifySend) {
      await page.getByRole("dialog", { name: /1 \/ 2/ }).getByRole("button", { name: commentName }).click();
      await editor.fill("Remove this note.");
      await save.click();
      await expect(editor).toBeHidden();
    }
    await page.keyboard.press("Escape");
    assert.deepEqual(sent, []);
    if (!verifySend) return;

    await expect(page.getByRole("dialog", { name: /1 \/ 2/ })).toBeHidden();
    await page.waitForFunction((depth) => (history.state?.personaOverlayDepth ?? 0) === depth, depthBeforeViewer);
    await page.reload({ waitUntil: "domcontentloaded" });
    const chip = page.locator("[data-comment-chip]");
    await chip.click();
    await page.locator('[data-comment-remove="3"]').click();
    await expect(page.locator("[data-comment-item]")).toHaveCount(2);
    const item = page.locator('[data-comment-item="2"]');
    await expect(item).toContainText(second);
    await expect(item).toContainText(note);
    await item.locator("[data-comment-edit]").click();
    await expect(editor).toHaveValue(note);
    const finalNote = "Please revise the legend colors.";
    await editor.fill(finalNote);
    await save.click();
    const overall = session === agent ? "Update the summer chart." : "";
    if (overall) await page.locator("[data-composer-input]").fill(overall);
    const message = page.getByTestId("composer-send");
    const matches = (items) => items.filter((i) => i.role === "user" && i.text?.includes(source) && i.text?.includes(finalNote));
    await mock("/mock/send-fail?on=1");
    try {
      await message.click();
      await expect.poll(() => sent).toEqual([502]);
      await chip.click();
      await expect(page.locator('[data-comment-item="1"]')).toContainText("Keep the heading.");
      await expect(item).toContainText(finalNote);
      await expect(item).toContainText(second);
      assert.equal(matches(await fetchItems()).length, 0);
      await page.keyboard.press("Escape");
    } finally {
      await mock("/mock/send-fail?on=0");
    }
    await message.click();
    await expect.poll(() => sent).toEqual([502, 200]);
    await expect.poll(async () => matches(await fetchItems()).length).toBe(1);
    const [received] = matches(await fetchItems());
    const deliveries = (await mock("/mock/sent_to")).sent.filter((row) => row.client_msg_id === received.client_msg_id);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].machine_id + "/" + deliveries[0].session_id, session);
    assert.equal(deliveries[0].text, received.text);
    const expected = [
      ["> Comment 1", "> Selected text:", `> > ${topic}`, "> ", "> Keep the heading."].join("\n"),
      ["> Comment 2", `> Source reply: ${source}`, `> Image: ${second}`, "> ", `> ${finalNote}`].join("\n"),
    ];
    if (overall) expected.push(overall);
    assert.equal(received.text, expected.join("\n\n"));
    console.log(JSON.stringify({ session: session === assistant ? "Assistant" : "Agent", attempts: sent, received: received.text }));
  } finally {
    await context.close();
  }
}

try {
  if (shots) {
    for (const language of ["zh-Hans", "ja"]) {
      for (const theme of ["light", "dark"]) await exercise(assistant, language, theme, false);
    }
  }
  await exercise(assistant, "en", "light", true);
  await exercise(agent, "en", "dark", true);
} finally {
  await browser.close();
}
