import test from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationMetadata,
  buildSearchPreview,
  deriveConversationTitle,
  openConversationDatabase
} from "../web/storage.js";

test("derives a compact conversation title from the first user message", () => {
  const title = deriveConversationTitle([
    {role: "assistant", content: "ignored until a user message exists"},
    {role: "user", content: "  请帮我   制定一个很清晰的项目计划  "}
  ]);
  assert.equal(title, "请帮我 制定一个很清晰的项目计划");
});

test("builds searchable metadata without retaining an API credential field", () => {
  const metadata = buildConversationMetadata({
    id: "conversation-1",
    messages: [{role: "user", content: "Hello Gemini"}],
    providerName: "Google",
    model: "gemini-test",
    apiKey: "must-not-appear",
    updatedAt: "2026-11-02T00:00:00.000Z"
  });
  assert.equal(metadata.id, "conversation-1");
  assert.equal(metadata.title, "Hello Gemini");
  assert.match(metadata.searchPreview, /hello gemini/);
  assert.equal("apiKey" in metadata, false);
});

test("normalizes conversation search text and enforces a size bound", () => {
  const preview = buildSearchPreview([{role: "user", content: `HELLO   ${"x".repeat(20_000)}`}]);
  assert.ok(preview.startsWith("hello x"));
  assert.equal(preview.length, 12_000);
});

test("reports IndexedDB unavailability without a synchronous crash", async () => {
  await assert.rejects(openConversationDatabase(null), /不支持 IndexedDB/);
});
