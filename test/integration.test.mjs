import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {once} from "node:events";
import {createAppServer, normalizeProvider} from "../server.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

function close(server) {
  server.closeAllConnections?.();
  server.close();
}

function request(port, {method = "GET", path = "/", body = "", host = `127.0.0.1:${port}`} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        Host: host,
        ...(body ? {"Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)} : {})
      }
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8")}));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("proxies Kimi streams with adapted parameters and blocks untrusted Host headers", async t => {
  let receivedPayload;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, {"Content-Type": "text/event-stream"});
    res.write(`data: ${JSON.stringify({choices: [{delta: {reasoning_content: "thinking"}, finish_reason: null}]})}\n\n`);
    res.write(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: "length"}]})}\n\n`);
    res.end(`data: ${JSON.stringify({choices: [], usage: {prompt_tokens: 2, completion_tokens: 3, total_tokens: 5}})}\n\ndata: [DONE]\n\n`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const provider = normalizeProvider({
    name: "Mock Kimi",
    presetId: "aliyun-bailian",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: "test-key",
    authMode: "bearer",
    modelsMode: "manual",
    manualModels: "kimi/kimi-k3"
  });
  const app = createAppServer({port: 0, config: {version: 1, activeProviderId: provider.id, providers: [provider]}});
  const appPort = await listen(app.server);
  t.after(() => close(app.server));

  let denied;
  try {
    denied = await request(appPort, {path: "/api/state", host: "attacker.example"});
  } catch (error) {
    if (error.code === "EACCES") {
      t.skip("this environment blocks loopback client connections");
      return;
    }
    throw error;
  }
  assert.equal(denied.status, 403);

  const body = JSON.stringify({
    providerId: provider.id,
    model: "kimi/kimi-k3",
    messages: [{role: "user", content: "hello"}],
    temperature: 0.7,
    top_p: 1,
    max_tokens: 4096,
    reasoning_effort: "high"
  });
  const result = await request(appPort, {method: "POST", path: "/api/chat", body});
  assert.equal(result.status, 200);
  assert.match(result.body, /reasoning_content/);
  assert.equal(receivedPayload.temperature, 1);
  assert.equal(receivedPayload.top_p, 0.95);
  assert.equal(receivedPayload.reasoning_effort, "max");
  assert.equal(receivedPayload.max_tokens, 8192);
  assert.deepEqual(receivedPayload.stream_options, {include_usage: true});
  assert.equal(result.headers["x-modelbridge-omitted-parameters"], undefined);
  assert.equal(result.headers["x-modelbridge-adapted-parameters"], "temperature=1,top_p=0.95,reasoning_effort=max,max_tokens=8192");
});

test("closing the browser request aborts an upstream request before response headers", async t => {
  let upstreamStartedResolve;
  let upstreamClosedResolve;
  const upstreamStarted = new Promise(resolve => { upstreamStartedResolve = resolve; });
  const upstreamClosed = new Promise(resolve => { upstreamClosedResolve = resolve; });
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    upstreamStartedResolve();
    res.once("close", upstreamClosedResolve);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const provider = normalizeProvider({
    name: "Slow",
    presetId: "custom",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authMode: "none",
    modelsMode: "manual",
    manualModels: "slow-model"
  });
  const app = createAppServer({port: 0, config: {version: 1, activeProviderId: provider.id, providers: [provider]}});
  const appPort = await listen(app.server);
  t.after(() => close(app.server));

  const body = JSON.stringify({model: "slow-model", messages: [{role: "user", content: "wait"}]});
  const client = http.request({
    host: "127.0.0.1",
    port: appPort,
    path: "/api/chat",
    method: "POST",
    headers: {Host: `127.0.0.1:${appPort}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)}
  });
  const clientError = new Promise(resolve => client.once("error", resolve));
  client.end(body);
  const started = await Promise.race([
    upstreamStarted.then(() => true),
    clientError.then(error => {
      if (error.code === "EACCES") return false;
      throw error;
    })
  ]);
  if (!started) {
    t.skip("this environment blocks loopback client connections");
    return;
  }
  client.destroy();
  await Promise.race([
    upstreamClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream request was not aborted")), 2_000))
  ]);
});

test("normalizes pretty-printed non-stream JSON into a single SSE data event", async t => {
  const upstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, {"Content-Type": "application/json"});
    res.end(JSON.stringify({choices: [{message: {content: "pretty response"}, finish_reason: "stop"}]}, null, 2));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const provider = normalizeProvider({
    name: "Pretty JSON",
    presetId: "custom",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    authMode: "none",
    modelsMode: "manual",
    manualModels: "pretty-model"
  });
  const app = createAppServer({port: 0, config: {version: 1, activeProviderId: provider.id, providers: [provider]}});
  const appPort = await listen(app.server);
  t.after(() => close(app.server));

  const body = JSON.stringify({model: "pretty-model", messages: [{role: "user", content: "hello"}]});
  let result;
  try {
    result = await request(appPort, {method: "POST", path: "/api/chat", body});
  } catch (error) {
    if (error.code === "EACCES") {
      t.skip("this environment blocks loopback client connections");
      return;
    }
    throw error;
  }
  assert.equal(result.status, 200);
  assert.match(result.body, /^data: \{"choices":/);
  assert.match(result.body, /"content":"pretty response"/);
  assert.match(result.body, /data: \[DONE]/);
});

test("tests Kimi K3 providers with the same minimum output budget as chat", async t => {
  let receivedPayload;
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, {"Content-Type": "application/json"});
      res.end(JSON.stringify({data: [{id: "kimi/kimi-k3"}]}));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, {"Content-Type": "text/event-stream"});
    res.end(`data: ${JSON.stringify({choices: [{delta: {content: "OK"}, finish_reason: "stop"}]})}\n\ndata: [DONE]\n\n`);
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const app = createAppServer({port: 0, config: {version: 1, activeProviderId: "", providers: []}});
  const appPort = await listen(app.server);
  t.after(() => close(app.server));
  const body = JSON.stringify({
    name: "Mock Kimi",
    presetId: "aliyun-bailian",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    apiKey: "test-key",
    authMode: "bearer",
    modelsMode: "auto"
  });

  let result;
  try {
    result = await request(appPort, {method: "POST", path: "/api/providers/test", body});
  } catch (error) {
    if (error.code === "EACCES") {
      t.skip("this environment blocks loopback client connections");
      return;
    }
    throw error;
  }
  assert.equal(result.status, 200);
  assert.equal(receivedPayload.max_tokens, 8_192);
  assert.equal(receivedPayload.reasoning_effort, "max");
});
