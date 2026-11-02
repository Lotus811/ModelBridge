import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationToMarkdown,
  createConversationExport,
  importConversationExport
} from "../web/conversation.js";

test("exports a versioned conversation without attachment payloads or secrets", () => {
  const exported = createConversationExport([
    {
      role: "user",
      content: [
        {type: "text", text: "hidden attachment body"},
        {type: "image_url", image_url: {url: "data:image/png;base64,SECRET"}}
      ],
      displayContent: "请分析附件",
      attachments: [{name: "demo.png", type: "image/png", size: 12, kind: "image", previewUrl: "data:image/png;base64,SECRET"}]
    },
    {role: "assistant", content: "分析结果", reasoning: "简短推理", model: "demo-model"}
  ], {
    exportedAt: "2026-11-01T00:00:00.000Z",
    appVersion: "1.8.0",
    providerName: "Demo",
    model: "demo-model",
    settings: {temperature: 0.7, maxTokens: 4096}
  });

  const serialized = JSON.stringify(exported);
  assert.equal(exported.format, "modelbridge-conversation");
  assert.equal(exported.version, 1);
  assert.equal(exported.messages[0].content, "请分析附件");
  assert.equal(exported.messages[0].attachments[0].retained, false);
  assert.doesNotMatch(serialized, /SECRET|hidden attachment body|apiKey/i);
  assert.deepEqual(importConversationExport(exported), exported.messages);
});

test("renders a readable Markdown transcript", () => {
  const exported = createConversationExport([
    {role: "user", content: "你好"},
    {role: "assistant", content: "你好！", model: "demo", incomplete: true}
  ], {exportedAt: "2026-11-01T00:00:00.000Z", providerName: "本地", model: "demo"});
  const markdown = conversationToMarkdown(exported);
  assert.match(markdown, /^# ModelBridge 对话/);
  assert.match(markdown, /## 用户\n\n你好/);
  assert.match(markdown, /## 助手 · demo/);
  assert.match(markdown, /标记为未完成/);
});

test("rejects unsupported or oversized conversation backups", () => {
  assert.throws(() => importConversationExport({format: "other", version: 1, messages: []}), /只支持/);
  assert.throws(() => importConversationExport({
    format: "modelbridge-conversation",
    version: 1,
    messages: [{role: "assistant", content: ""}]
  }), /没有可导出的文本/);
  assert.throws(() => importConversationExport({
    format: "modelbridge-conversation",
    version: 1,
    messages: Array.from({length: 5}, () => ({role: "user", content: "x".repeat(1_000_000)}))
  }), /文本过大/);
  assert.throws(() => importConversationExport({
    format: "modelbridge-conversation",
    version: 1,
    messages: [{role: "user", content: "x".repeat(1_000_001)}]
  }), /超过 1000000 字符限制/);
  assert.throws(() => importConversationExport({
    format: "modelbridge-conversation",
    version: 1,
    messages: Array.from({length: 81}, () => ({role: "user", content: "x"}))
  }), /最多支持 80 条消息/);
});
