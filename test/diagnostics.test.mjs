import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDiagnosticReport,
  classifyDiagnosticError,
  diagnosticCheck,
  diagnosticOverall,
  redactDiagnosticText
} from "../diagnostics.mjs";

test("redacts credentials and URL secrets from diagnostic text", () => {
  const value = "Bearer secret-token-123 https://user:pass@example.com/v1?api_key=hidden sk-example123456789";
  const redacted = redactDiagnosticText(value, ["secret-token-123"]);
  assert.doesNotMatch(redacted, /secret-token-123|user:pass|api_key=hidden|sk-example/);
  assert.match(redacted, /Bearer \*\*\*/);
  assert.match(redacted, /example\.com\/v1\?%E2%80%A6|example\.com\/v1\?…/);
});

test("keeps human-readable Bearer labels and Chinese punctuation intact", () => {
  const redacted = redactDiagnosticText("使用 https://api.deepseek.com，认证方式使用 Bearer Token");
  assert.match(redacted, /api\.deepseek\.com/);
  assert.match(redacted, /，认证方式使用 Bearer Token/);
  assert.doesNotMatch(redacted, /xn--/);
});

test("classifies actionable provider failures", () => {
  assert.deepEqual(classifyDiagnosticError(Object.assign(new Error("bad key"), {status: 401})), {
    status: "fail",
    code: "authentication",
    summary: "认证失败",
    detail: "bad key",
    suggestion: "检查 API Key、认证方式以及 Base URL 是否属于同一平台或区域"
  });
  assert.equal(classifyDiagnosticError(Object.assign(new Error("missing"), {status: 404}), "models").code, "not_found");
  assert.equal(classifyDiagnosticError(Object.assign(new Error("connect"), {cause: {code: "ENOTFOUND"}})).code, "dns");
  assert.equal(classifyDiagnosticError(new Error("certificate expired")).code, "tls");
});

test("summarizes diagnostic checks without treating unknown capability as failure", () => {
  assert.equal(diagnosticOverall([diagnosticCheck("config", "pass", "ok")]), "pass");
  assert.equal(diagnosticOverall([diagnosticCheck("files", "unknown", "unknown")]), "partial");
  assert.equal(diagnosticOverall([diagnosticCheck("models", "needs_input", "manual")]), "needs_input");
  assert.equal(diagnosticOverall([diagnosticCheck("chat", "fail", "bad")]), "fail");
});

test("builds a versioned sanitized report", () => {
  const report = buildDiagnosticReport({
    provider: {name: "Demo", presetId: "custom", baseUrl: "https://example.com/v1?token=secret"},
    startedAt: "2026-11-02T00:00:00.000Z",
    finishedAt: "2026-11-02T00:00:01.000Z",
    checks: [diagnosticCheck("chat", "pass", "聊天正常")],
    observed: {testedModel: "demo", streaming: true, modelCount: 2, rejectedParameters: ["max_tokens"]}
  });
  assert.equal(report.version, 1);
  assert.equal(report.overall, "pass");
  assert.equal(report.observed.streaming, true);
  assert.doesNotMatch(JSON.stringify(report), /token=secret/);
});

test("sanitizes successful observations as well as failure details", () => {
  const secret = "success-secret-123456";
  const report = buildDiagnosticReport({
    provider: {name: `Provider ${secret}`, presetId: "custom", baseUrl: "https://example.com/v1", apiKey: secret},
    checks: [diagnosticCheck("chat", "pass", `called ${secret}`, {detail: `model-${secret}`})],
    observed: {testedModel: `model-${secret}`, rejectedParameters: [secret]},
    startedAt: "2026-11-02T00:00:00.000Z"
  });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.match(serialized, /\*\*\*/);
});
