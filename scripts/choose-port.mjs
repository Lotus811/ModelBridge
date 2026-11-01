import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {version} = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const requested = Number(process.env.MODELBRIDGE_PORT || process.env.BAILIAN_PORT || 0);
const candidates = requested
  ? [requested]
  : Array.from({length: 11}, (_, index) => 8000 + index);

async function currentServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {signal: AbortSignal.timeout(500)});
    const data = await response.json();
    return response.ok && data?.ok === true && data?.app === "ModelBridge" && data?.version === version;
  } catch {
    return false;
  }
}

function portIsFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({host: "127.0.0.1", port, exclusive: true}, () => {
      server.close(() => resolve(true));
    });
  });
}

if (candidates.some(port => !Number.isInteger(port) || port < 1 || port > 65_535)) {
  console.log("ERROR invalid-port");
  process.exitCode = 2;
} else {
  let selected = "";
  for (const port of candidates) {
    if (await currentServer(port)) {
      selected = `REUSE ${port}`;
      break;
    }
  }
  if (!selected) {
    for (const port of candidates) {
      if (await portIsFree(port)) {
        selected = `START ${port}`;
        break;
      }
    }
  }
  if (selected) console.log(selected);
  else {
    console.log(`ERROR ${requested ? "port-in-use" : "no-free-port"}`);
    process.exitCode = 2;
  }
}
