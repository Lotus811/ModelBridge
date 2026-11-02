import test from "node:test";
import assert from "node:assert/strict";
import {createSseParser, extractChunk} from "../web/sse.js";

test("parses SSE event blocks across chunks and joins data lines", () => {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  parser.push("\uFEFF: keep-alive\r\nevent: message\r\ndata: {\"choices\":[\r");
  parser.push("\ndata: {\"delta\":{\"content\":\"ok\"}}]}\r\n\r\n");

  assert.deepEqual(events, [{
    type: "message",
    data: '{"choices":[\n{"delta":{"content":"ok"}}]}'
  }]);
  assert.equal(JSON.parse(events[0].data).choices[0].delta.content, "ok");
});

test("supports CR line endings and flushes a final unterminated event", () => {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  parser.push('event: error\rdata: {"error":{"message":"bad"}}\r');
  assert.equal(events.length, 0);
  assert.equal(parser.finish(), true);
  assert.deepEqual(events, [{type: "error", data: '{"error":{"message":"bad"}}'}]);
});

test("stops immediately when the event handler rejects further data", () => {
  const events = [];
  const parser = createSseParser(event => {
    events.push(event.data);
    return event.data !== "[DONE]";
  });
  const result = parser.push("data: [DONE]\n\ndata: should-not-run\n\n");
  assert.equal(result, false);
  assert.deepEqual(events, ["[DONE]"]);
  assert.equal(parser.finish(), false);
});

test("decodes UTF-8 characters split across byte chunks", () => {
  const events = [];
  const parser = createSseParser(event => events.push(event));
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"中文"}}]}\n\n');
  const splitAt = bytes.indexOf(0xE4) + 1;
  parser.push(bytes.slice(0, splitAt));
  parser.push(bytes.slice(splitAt));
  parser.finish();
  assert.equal(JSON.parse(events[0].data).choices[0].delta.content, "中文");
});

test("extracts content, refusal, reasoning, finish state, and usage", () => {
  const usage = {prompt_tokens: 2, completion_tokens: 3, total_tokens: 5};
  assert.deepEqual(extractChunk({
    choices: [{
      delta: {content: [{text: "answer"}], refusal: "cannot comply", reasoning_content: "thinking"},
      finish_reason: "stop"
    }],
    usage
  }), {
    content: "answer",
    refusal: "cannot comply",
    reasoning: "thinking",
    finishReason: "stop",
    usage
  });
});

test("rejects an unbounded single SSE event", () => {
  const parser = createSseParser(() => {});
  assert.throws(() => parser.push(`data: ${"x".repeat(1_000_001)}`), /单个流式事件过大/);
  const commentParser = createSseParser(() => {});
  assert.throws(() => commentParser.push(`:${"x".repeat(1_000_001)}\n`), /单个流式事件过大/);
});
