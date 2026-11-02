import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyModel,
  contextCharBudget,
  effectiveMaxTokens,
  endpointUrl,
  extractModelIds,
  knownUnsupportedParameters,
  limitMessageContext,
  modelCapabilities,
  modelProfile,
  normalizeBaseUrl,
  normalizeEndpointPath,
  normalizeModelOverride,
  normalizeProvider,
  parseLegacyApiText,
  providerProtocolIssue,
  publicProvider,
  readResponseText,
  sanitizeMessageContent,
  trustedHost,
  trustedOrigin,
  unsupportedOptionalParameter
} from "../server.mjs";

test("normalizes secure and local Base URLs", () => {
  assert.equal(normalizeBaseUrl("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1");
  assert.throws(() => normalizeBaseUrl("http://example.com/v1"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("file:///tmp/api"), /HTTP/);
});

test("accepts API keys without requiring an sk- prefix", () => {
  const provider = normalizeProvider({
    name: "Test",
    presetId: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "provider.key_with-any-format",
    authMode: "bearer",
    modelsMode: "manual",
    manualModels: "model-a\nmodel-b"
  });
  assert.equal(provider.apiKey, "provider.key_with-any-format");
  assert.deepEqual(provider.manualModels, ["model-a", "model-b"]);
});

test("rejects API keys and header values that cannot be sent as HTTP headers", () => {
  assert.throws(() => normalizeProvider({
    name: "Bad key",
    presetId: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "你的 API Key",
    authMode: "bearer",
    modelsMode: "auto"
  }), /API Key 包含中文/);
  assert.throws(() => normalizeProvider({
    name: "Bad header",
    presetId: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "valid-key",
    authMode: "bearer",
    modelsMode: "auto",
    extraHeaders: {"X-Label": "你好"}
  }), /请求头 X-Label 的值包含中文/);
});

test("explains protocol-specific and full endpoint URLs before connecting", () => {
  const deepseekAnthropic = normalizeProvider({
    name: "DeepSeek Anthropic",
    presetId: "deepseek",
    baseUrl: "https://api.deepseek.com/anthropic",
    apiKey: "valid-key",
    authMode: "api-key",
    modelsMode: "auto"
  });
  assert.equal(providerProtocolIssue(deepseekAnthropic).code, "anthropic_endpoint");
  assert.match(providerProtocolIssue(deepseekAnthropic).suggestion, /https:\/\/api\.deepseek\.com/);
  assert.equal(providerProtocolIssue({...deepseekAnthropic, baseUrl: "https://example.com/v1/chat/completions"}).code, "full_endpoint");
  assert.equal(providerProtocolIssue({...deepseekAnthropic, baseUrl: "https://api.deepseek.com"}), null);
});

test("supports keyless local providers", () => {
  const provider = normalizeProvider({
    name: "Local",
    presetId: "ollama",
    baseUrl: "http://localhost:11434/v1",
    authMode: "none",
    modelsMode: "auto"
  });
  assert.equal(provider.authMode, "none");
  assert.equal(provider.apiKey, "");
});

test("never exposes API keys in public provider state", () => {
  const provider = normalizeProvider({
    name: "Test",
    presetId: "custom",
    baseUrl: "https://example.com/v1",
    apiKey: "secret-value-1234",
    authMode: "bearer",
    modelsMode: "auto"
  });
  const result = publicProvider(provider);
  assert.equal("apiKey" in result, false);
  assert.equal(result.hasApiKey, true);
  assert.equal(result.apiKeyHint, "••••1234");
});

test("migrates the legacy api.txt format", () => {
  const legacy = parseLegacyApiText([
    "any-key-format.123",
    "API HOST:workspace.example.com",
    "openai兼容地址：https://workspace.example.com/compatible-mode/v1",
    "dashscope：https://workspace.example.com/api/v1"
  ].join("\n"));
  assert.equal(legacy.apiKey, "any-key-format.123");
  assert.equal(legacy.baseUrl, "https://workspace.example.com/compatible-mode/v1");
});

test("classifies common non-chat model families", () => {
  assert.equal(classifyModel("qwen-plus"), "文本对话");
  assert.equal(classifyModel("text-embedding-v3"), "向量/排序");
  assert.equal(classifyModel("wan2.7-image"), "图像生成");
  assert.equal(classifyModel("qwen3-vl-plus"), "多模态");
  assert.equal(classifyModel("speech-tts"), "语音/实时");
  assert.equal(classifyModel("kimi/kimi-k3"), "多模态");
});

test("sanitizes and limits remote model IDs", () => {
  const models = Array.from({length: 550}, (_, index) => ({id: `model-${index}`}));
  models.unshift("  direct-model  ", {id: 42}, {name: "x".repeat(301)}, {model: "direct-model"});
  const ids = extractModelIds({data: models});
  assert.equal(ids[0], "direct-model");
  assert.equal(ids.length, 500);
  assert.equal(ids.includes("42"), false);
  assert.equal(ids.some(id => id.length > 300), false);
});

test("reads upstream bodies with a strict byte limit", async () => {
  assert.equal(await readResponseText(new Response("hello"), 5, "测试响应"), "hello");
  await assert.rejects(
    readResponseText(new Response("你好", {headers: {"Content-Length": "2"}}), 5, "测试响应"),
    /测试响应超过 5 字节限制/
  );
  await assert.rejects(
    readResponseText(new Response("small", {headers: {"Content-Length": "100"}}), 5, "测试响应"),
    /测试响应超过 5 字节限制/
  );
});

test("describes conservative model input capabilities", () => {
  const kimi = modelCapabilities("kimi/kimi-k3", {presetId: "aliyun-bailian"});
  assert.equal(kimi.chat, true);
  assert.equal(kimi.imageInput, "url-only");
  assert.equal(kimi.localImageInput, false);
  assert.equal(kimi.pdfInput, "unsupported");
  assert.equal(kimi.reasoning, "supported");
  assert.deepEqual(kimi.reasoningEfforts, ["max"]);
  assert.equal(kimi.contextWindow, 1_048_576);
  assert.equal(kimi.inputPrice, 20);
  assert.equal(kimi.outputPrice, 100);
  assert.equal(modelCapabilities("text-embedding-v3", {}).chat, false);
});

test("merges saved model capability and price overrides", () => {
  const override = normalizeModelOverride({
    imageInput: "base64",
    pdfInput: "supported",
    contextWindow: "131072",
    maxOutputTokens: 8192,
    inputPrice: "1.25",
    outputPrice: 5,
    reasoningEfforts: "low,high,max,invalid"
  });
  const profile = modelProfile("custom-chat", {presetId: "custom", modelOverrides: {"custom-chat": override}});
  assert.equal(profile.imageInput, "base64");
  assert.equal(profile.pdfInput, "supported");
  assert.equal(profile.contextWindow, 131072);
  assert.equal(profile.inputPrice, 1.25);
  assert.deepEqual(profile.reasoningEfforts, ["low", "high", "max"]);
  assert.equal(profile.custom, true);
});

test("joins endpoint paths without losing the Base URL path", () => {
  assert.equal(
    endpointUrl({baseUrl: "https://example.com/compatible-mode/v1"}, "/chat/completions"),
    "https://example.com/compatible-mode/v1/chat/completions"
  );
  assert.equal(normalizeEndpointPath("/deployments/demo/chat/completions?api-version=1", "/chat/completions"), "/deployments/demo/chat/completions?api-version=1");
  assert.throws(() => normalizeEndpointPath("https://evil.example/chat", "/chat/completions"), /完整 URL/);
});

test("sanitizes supported Chat Completions attachments", () => {
  const content = sanitizeMessageContent([
    {type: "text", text: "describe these files"},
    {type: "image_url", image_url: {url: "data:image/png;base64,aGVsbG8=", detail: "high"}},
    {type: "file", file: {filename: "sample.pdf", file_data: "data:application/pdf;base64,aGVsbG8="}}
  ], "user");
  assert.equal(content.length, 3);
  assert.equal(content[1].image_url.detail, "high");
  assert.equal(content[2].file.filename, "sample.pdf");
});

test("rejects unsupported attachment types and non-user arrays", () => {
  assert.throws(() => sanitizeMessageContent([
    {type: "file", file: {filename: "sample.docx", file_data: "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,aGVsbG8="}}
  ], "user"), /PDF/);
  assert.throws(() => sanitizeMessageContent([{type: "text", text: "no"}], "assistant"), /用户消息/);
});

test("detects optional parameters rejected by compatible model APIs", () => {
  const payload = {temperature: 0.7, top_p: 1, max_tokens: 4096};
  assert.equal(
    unsupportedOptionalParameter("Parameter 'temperature'=0.7 is not supported for kimi-k3 model.", payload),
    "temperature"
  );
  assert.equal(unsupportedOptionalParameter("top_p must be 0.95", payload), "top_p");
  assert.equal(unsupportedOptionalParameter("authentication failed", payload), "");
  assert.equal(unsupportedOptionalParameter("reasoning_effort is unsupported", payload), "");
  assert.equal(
    unsupportedOptionalParameter("max_tokens is deprecated; use max_completion_tokens instead", payload),
    "max_tokens"
  );
  assert.equal(
    unsupportedOptionalParameter("max_completion_tokens is not supported", {max_completion_tokens: 4096}),
    "max_completion_tokens"
  );
});

test("preemptively omits fixed Kimi K3 sampling parameters", () => {
  assert.deepEqual(knownUnsupportedParameters("kimi-k3"), ["temperature", "top_p"]);
  assert.deepEqual(knownUnsupportedParameters("kimi/kimi-k3"), ["temperature", "top_p"]);
  assert.deepEqual(knownUnsupportedParameters("kimi/kimi-k3.1-pro"), ["temperature", "top_p"]);
  assert.deepEqual(knownUnsupportedParameters("kimi-k2.7-code-highspeed"), ["temperature", "top_p"]);
  assert.deepEqual(knownUnsupportedParameters("kimi-k2.6"), ["temperature", "top_p"]);
});

test("limits old context while retaining the system prompt and newest turn", () => {
  const result = limitMessageContext([
    {role: "system", content: "system"},
    {role: "user", content: "old".repeat(4_000)},
    {role: "assistant", content: "answer".repeat(4_000)},
    {role: "user", content: "latest".repeat(4_000)}
  ], 10_000);
  assert.equal(result.truncated, true);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages.at(-1).role, "user");
  assert.match(result.messages.at(-1).content, /^latest/);
});

test("respects small context windows and reserves room for input", () => {
  const profile = {contextWindow: 4_096, maxOutputTokens: 4_096};
  const maxTokens = effectiveMaxTokens("small-chat", profile, 4_096);
  assert.equal(maxTokens, 3_584);
  assert.equal(contextCharBudget(profile, maxTokens), 1_280);

  const result = limitMessageContext([
    {role: "system", content: "system"},
    {role: "user", content: "latest".repeat(100)}
  ], 100);
  assert.equal(result.truncated, true);
  assert.equal(result.messages[0].role, "system");
  assert.equal(result.messages.at(-1).role, "user");
  assert.ok(result.messages.reduce((total, message) => total + message.content.length, 0) <= 100);

  const minimal = limitMessageContext([
    {role: "system", content: "system"},
    {role: "user", content: "latest"}
  ], 1);
  assert.equal(minimal.messages.at(-1).role, "user");
  assert.equal(minimal.messages.at(-1).content, "l");
});

test("uses the Kimi K3 minimum output budget consistently", () => {
  assert.equal(effectiveMaxTokens("kimi/kimi-k3", modelProfile("kimi/kimi-k3", {presetId: "aliyun-bailian"}), 64), 8_192);
});

test("accepts only loopback Host headers for local APIs", () => {
  assert.equal(trustedHost({headers: {host: "127.0.0.1:8000"}}, 8000), true);
  assert.equal(trustedHost({headers: {host: "localhost:8000"}}, 8000), true);
  assert.equal(trustedHost({headers: {host: "localhost"}}, 8000), false);
  assert.equal(trustedHost({headers: {host: "localhost"}}, 80), true);
  assert.equal(trustedHost({headers: {host: "attacker.example:8000"}}, 8000), false);
  assert.equal(trustedHost({headers: {host: "127.0.0.1:9000"}}, 8000), false);
});

test("accepts only same-port HTTP loopback Origins", () => {
  assert.equal(trustedOrigin({headers: {}}, 8000), true);
  assert.equal(trustedOrigin({headers: {origin: "http://127.0.0.1:8000"}}, 8000), true);
  assert.equal(trustedOrigin({headers: {origin: "http://localhost"}}, 8000), false);
  assert.equal(trustedOrigin({headers: {origin: "https://localhost:8000"}}, 8000), false);
  assert.equal(trustedOrigin({headers: {origin: "http://attacker.example:8000"}}, 8000), false);
});
