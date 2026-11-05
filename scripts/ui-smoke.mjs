// Optional browser acceptance check. Uses an installed Playwright, never real API credentials.
import assert from "node:assert/strict";
import {once} from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createAppServer, PROVIDER_PRESETS} from "../server.mjs";

const {chromium} = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const {version} = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
const output = path.resolve(".ui-artifacts");
await fs.mkdir(output, {recursive: true});
const {server} = createAppServer({port: 0, config: {version: 1, providers: [], activeProviderId: ""}});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let browser;
try {
  browser = await chromium.launch({headless: true, ...(process.env.BROWSER_EXECUTABLE ? {executablePath: process.env.BROWSER_EXECUTABLE} : {})});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const provider = {id: "demo", presetId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", authMode: "bearer", hasApiKey: true, apiKeyHint: "••••demo", modelsMode: "auto", modelsPath: "/models", chatPath: "/chat/completions", manualModels: [], extraHeaders: {}};
  let configured = false;
  let diagnosisCount = 0;
  let chatCount = 0;
  let saveCount = 0;
  let releaseDiagnosis;
  const state = () => ({app: {version}, configured, providers: configured ? [provider] : [], activeProviderId: configured ? "demo" : "", presets: PROVIDER_PRESETS});
  await page.route("**/api/**", async route => {
    const pathname = new URL(route.request().url()).pathname;
    let result;
    if (pathname === "/api/state") result = state();
    else if (pathname === "/api/models") result = {data: [{id: "demo-chat", category: "文本对话", capabilities: {chat: true}}], count: 1};
    else if (pathname === "/api/providers/diagnose") {
      diagnosisCount++;
      if (diagnosisCount === 1) await new Promise(resolve => { releaseDiagnosis = resolve; });
      result = {overall: "pass", durationMs: 120, observed: {testedModel: "demo-chat", streaming: true, modelSource: "remote", modelCount: 1}, checks: [{status: "pass", summary: "连接成功"}]};
    } else if (pathname === "/api/providers") {
      saveCount++;
      if (saveCount === 1) {
        await route.fulfill({status: 400, json: {error: {message: "模拟保存失败，请重试"}}});
        return;
      }
      configured = true;
      result = {state: state(), provider};
    } else if (pathname === "/api/chat") {
      chatCount++;
      if (chatCount === 2) {
        await route.fulfill({contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"中断前已经生成的正文。"}}]}\n\nevent: error\ndata: {"error":{"message":"模拟网络中断"}}\n\n'});
        return;
      }
      await route.fulfill({contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"这是本地界面验收回复。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'});
      return;
    } else throw new Error(`Unexpected API request: ${pathname}`);
    await route.fulfill({json: result}).catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator("#presetQuickGrid button[data-preset-quick=deepseek]").click();
  await page.locator("#wizardNextBtn").click();
  assert.equal(await page.locator("#apiKey").evaluate(el => el === document.activeElement), true);
  assert.equal(await page.locator("#baseUrl").isVisible(), false);
  await page.locator("#testProviderBtn").click();
  assert.match(await page.locator("#providerFeedback").innerText(), /请先粘贴/);
  assert.equal(diagnosisCount, 0);
  await page.locator("#apiKey").fill("demo-key");
  await page.screenshot({path: path.join(output, "setup-desktop.png")});
  assert.equal(await page.locator(".provider-workspace").evaluate(el => el.getBoundingClientRect().height < 650), true, "First-time setup should fit its content instead of leaving a tall blank panel");
  await page.locator("#testProviderBtn").click();
  await page.locator("#diagnosticProgress").waitFor({state: "visible"});
  assert.equal(await page.locator("#apiKey").isDisabled(), true);
  await page.locator("#cancelDiagnosticBtn").click();
  assert.equal(await page.locator("#apiKey").isEnabled(), true);
  releaseDiagnosis();
  await page.locator("#testProviderBtn").click();
  await page.locator("#saveProviderBtn").waitFor({state: "visible"});
  await page.locator("#saveProviderBtn:enabled").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#providerModal [data-close-modal]").evaluate(el => el === document.activeElement), true, "Tab wraps to a visible control");
  await page.locator("#saveProviderBtn").click();
  await page.locator("#providerFeedback").filter({hasText: "模拟保存失败"}).waitFor();
  assert.equal(await page.locator("#providerFeedback").isVisible(), true, "Save failures are visible on the confirmation step");
  await page.locator("#saveProviderBtn:enabled").click();
  await page.locator("#currentModel").filter({hasText: "demo-chat"}).waitFor();
  assert.equal(await page.locator("[data-model=demo-chat]").getAttribute("aria-current"), "true");
  assert.equal(await page.locator("#sendBtn").isDisabled(), true);
  await page.locator("#conversationSearch").fill("不存在的对话");
  await page.locator('[data-action="clear-conversation-search"]').click();
  assert.equal(await page.locator("#conversationSearch").inputValue(), "");
  await page.locator("#chooseModelBtn").click();
  await page.locator("#modelSearch").fill("missing-model");
  await page.locator('[data-action="reset-model-filter"]').click();
  assert.equal(await page.locator('[data-category="全部"]').getAttribute("aria-pressed"), "true");
  await page.locator("#historyTab").click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow on desktop");
  await page.screenshot({path: path.join(output, "chat-desktop.png")});
  await page.locator(".suggestions button").first().click();
  assert.equal(chatCount, 0, "Starter prompts must not send until the user confirms");
  assert.equal(await page.locator("#sendBtn").isEnabled(), true);
  // Make the history write slow enough to expose interaction races before fetch.
  await page.evaluate(async () => {
    const {ConversationRepository} = await import("/web/storage.js");
    const save = ConversationRepository.prototype.save;
    ConversationRepository.prototype.save = async function (...args) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return save.apply(this, args);
    };
  });
  await page.evaluate(() => {
    document.querySelector("#sendBtn").click();
    if (!document.querySelector("#newConversationBtn").disabled) throw new Error("History writes must lock conversation changes immediately");
  });
  await page.locator(".message.assistant .message-content").filter({hasText: "本地界面验收回复"}).waitFor();
  await page.locator("#newConversationBtn:enabled").waitFor();
  await page.screenshot({path: path.join(output, "conversation-desktop.png")});
  await page.locator("#newConversationBtn").click();
  await page.locator("#newConversationBtn:enabled").waitFor();
  assert.equal(await page.locator(".message").count(), 0);
  await page.locator("#conversationList [data-conversation-open]").first().click();
  await page.locator(".message.assistant").waitFor();
  await page.reload();
  await page.locator(".message.assistant").waitFor();
  await page.locator("#input").fill("测试流式中断");
  await page.locator("#sendBtn").click();
  await page.locator(".stream-error-notice").filter({hasText: "模拟网络中断"}).waitFor();
  assert.match(await page.locator(".message.assistant").last().innerText(), /中断前已经生成的正文/);
  await page.locator("#newConversationBtn:enabled").waitFor();
  await page.locator('[data-action="retry-request"]').last().click();
  await page.locator("#newConversationBtn:enabled").waitFor();
  assert.equal(chatCount, 3, "Interrupted replies can be regenerated");
  assert.equal(await page.locator(".message.user").count(), 2, "Regeneration reuses the original question");
  // Restore an interrupted reply to verify persistence and small-screen actions.
  await page.locator("#input").fill("再次测试中断");
  chatCount = 1;
  await page.locator("#sendBtn").click();
  await page.locator(".stream-error-notice").waitFor();
  await page.locator("#newConversationBtn:enabled").waitFor();
  await page.reload();
  await page.locator(".message.assistant.incomplete").waitFor();
  assert.match(await page.locator(".message.assistant").last().innerText(), /中断前已经生成的正文/);
  await page.screenshot({path: path.join(output, "interrupted-desktop.png")});
  await page.setViewportSize({width: 768, height: 900});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow on tablet");
  await page.screenshot({path: path.join(output, "conversation-tablet.png")});
  await page.setViewportSize({width: 390, height: 844});
  await page.locator("#menuBtn").click();
  assert.equal(await page.locator("#sidebarBackdrop").isVisible(), true);
  await page.locator("#modelsTab").click();
  await page.locator("[data-model=demo-chat]").click();
  assert.equal(await page.locator("#sendBtn").isDisabled(), true);
  assert.equal(await page.locator("#sidebarBackdrop").isVisible(), false);
  assert.equal(await page.locator(".main").evaluate(el => el.inert), false);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#input").evaluate(el => el === document.activeElement), true, "Escape keeps focus in the composer when no overlay is open");
  await page.screenshot({path: path.join(output, "chat-mobile.png")});
  for (const width of [320, 360, 390]) {
    await page.setViewportSize({width, height: 740});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}px`);
  }
  await page.locator("#topSettingsBtn").click();
  await page.locator("#newProviderBtn").click();
  await page.locator("#presetQuickGrid button[data-preset-quick=deepseek]").click();
  await page.locator("#wizardNextBtn").click();
  await page.screenshot({path: path.join(output, "setup-mobile.png")});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow on mobile");
  assert.equal(await page.locator("#apiKey").evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#providerModal").isVisible(), false);
  assert.deepEqual(errors, []);
  console.log("UI acceptance passed: onboarding, validation, cancellation, chat, history locking, interrupted reply recovery/regeneration, history restore, responsive layout, mobile drawer, no page errors.");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
