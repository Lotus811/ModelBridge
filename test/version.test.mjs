import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("keeps package, backend, and frontend versions synchronized", () => {
  const packageVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const server = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(server, new RegExp(`const APP_VERSION = "${packageVersion.replaceAll(".", "\\.")}"`));
  assert.match(client, new RegExp(`const CLIENT_VERSION = "${packageVersion.replaceAll(".", "\\.")}"`));
});
