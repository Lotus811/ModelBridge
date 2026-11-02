function textDelta(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map(part => {
    if (typeof part === "string") return part;
    return typeof part?.text === "string" ? part.text : typeof part?.refusal === "string" ? part.refusal : "";
  }).join("");
}

export function extractChunk(payload) {
  const choice = payload?.choices?.[0];
  const delta = choice?.delta || choice?.message || {};
  return {
    content: textDelta(delta.content),
    refusal: textDelta(delta.refusal),
    reasoning: typeof (delta.reasoning_content ?? delta.reasoning) === "string" ? (delta.reasoning_content ?? delta.reasoning) : "",
    finishReason: choice?.finish_reason || "",
    usage: payload?.usage && typeof payload.usage === "object" ? payload.usage : null
  };
}

export function createSseParser(onEvent) {
  if (typeof onEvent !== "function") throw new TypeError("onEvent must be a function");

  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines = [];
  let eventType = "";
  let sawText = false;
  let stopped = false;
  let eventChars = 0;
  const maxEventChars = 1_000_000;

  const append = text => {
    if (!text) return;
    let value = text;
    if (!sawText) {
      sawText = true;
      if (value.charCodeAt(0) === 0xFEFF) value = value.slice(1);
    }
    buffer += value;
  };

  const dispatch = () => {
    if (!dataLines.length) {
      eventType = "";
      return !stopped;
    }
    const event = {type: eventType || "message", data: dataLines.join("\n")};
    dataLines = [];
    eventType = "";
    eventChars = 0;
    if (onEvent(event) === false) stopped = true;
    return !stopped;
  };

  const processLine = line => {
    if (line === "") return dispatch();
    eventChars += line.length + 1;
    if (eventChars > maxEventChars) throw new Error("模型平台返回的单个流式事件过大");
    if (line.startsWith(":")) return !stopped;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
    }
    else if (field === "event") eventType = value;
    return !stopped;
  };

  const drain = allowTrailingCarriageReturn => {
    while (!stopped && buffer) {
      const match = /[\r\n]/.exec(buffer);
      if (!match) break;
      const index = match.index;
      const separator = buffer[index];
      if (separator === "\r" && index === buffer.length - 1 && !allowTrailingCarriageReturn) break;
      const separatorLength = separator === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + separatorLength);
      processLine(line);
    }
    return !stopped;
  };

  return {
    push(chunk) {
      if (stopped) return false;
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, {stream: true});
      append(text);
      const active = drain(false);
      if (eventChars + buffer.length > maxEventChars) throw new Error("模型平台返回的单个流式事件过大");
      return active;
    },
    finish() {
      if (stopped) return false;
      append(decoder.decode());
      drain(true);
      if (!stopped && buffer) {
        const line = buffer;
        buffer = "";
        processLine(line);
      }
      if (!stopped) dispatch();
      return !stopped;
    }
  };
}
