import test from "node:test";
import assert from "node:assert/strict";
import {normalizeUsage, summarizeUsage} from "../web/usage.js";

test("normalizes OpenAI and Responses-style token usage", () => {
  assert.deepEqual(normalizeUsage({prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, prompt_tokens_details: {cached_tokens: 3}}), {
    inputTokens: 12, outputTokens: 5, cachedTokens: 3, totalTokens: 17
  });
  assert.deepEqual(normalizeUsage({input_tokens: 9, output_tokens: 4, input_tokens_details: {cached_tokens: 2}}), {
    inputTokens: 9, outputTokens: 4, cachedTokens: 2, totalTokens: 13
  });
});

test("summarizes cumulative and daily token usage", () => {
  const summary = summarizeUsage([
    {at: "2026-10-31T01:00:00.000Z", inputTokens: 10, outputTokens: 5, cachedTokens: 2, totalTokens: 15, usageAvailable: true},
    {at: "2026-10-30T01:00:00.000Z", inputTokens: 8, outputTokens: 2, totalTokens: 10, usageAvailable: true},
    {at: "2026-10-31T02:00:00.000Z", usageAvailable: false}
  ], "2026-10-31");
  assert.deepEqual(summary, {requests: 3, missing: 1, inputTokens: 18, outputTokens: 7, cachedTokens: 2, totalTokens: 25, todayTokens: 15});
});
