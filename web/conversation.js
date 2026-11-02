const FORMAT = "modelbridge-conversation";
const FORMAT_VERSION = 1;
const MAX_MESSAGES = 80;
const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_TOTAL_CHARS = 4_000_000;
const ATTACHMENT_KINDS = new Set(["image", "pdf", "docx", "text"]);

function text(value, max = MAX_MESSAGE_CHARS) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function visibleMessageText(message) {
  if (typeof message?.displayContent === "string") return message.displayContent;
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter(part => part?.type === "text" && typeof part.text === "string")
    .map(part => part.text)
    .join("\n");
}

function portableAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === "object" && typeof item.name === "string")
    .slice(0, 5)
    .map(item => ({
      name: text(item.name, 240).replace(/\s+/g, " ").trim() || "attachment",
      type: text(item.type, 200),
      size: Number.isFinite(Number(item.size)) ? Math.max(0, Number(item.size)) : 0,
      kind: ATTACHMENT_KINDS.has(item.kind) ? item.kind : "text",
      previewUrl: "",
      retained: false
    }));
}

function portableUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const field of [
    "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens",
    "inputTokens", "outputTokens", "cachedTokens", "totalTokens"
  ]) {
    const number = Number(value[field]);
    if (Number.isFinite(number) && number >= 0) result[field] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

function portableMessage(message, index) {
  if (!message || typeof message !== "object" || !["user", "assistant"].includes(message.role)) {
    throw new Error(`第 ${index + 1} 条消息格式无效`);
  }
  const content = visibleMessageText(message);
  if (!content) throw new Error(`第 ${index + 1} 条消息没有可导出的文本`);
  if (content.length > MAX_MESSAGE_CHARS) throw new Error(`第 ${index + 1} 条消息超过 ${MAX_MESSAGE_CHARS} 字符限制`);
  const result = {role: message.role, content};
  const rawReasoning = typeof message.reasoning === "string" ? message.reasoning : "";
  if (rawReasoning.length > MAX_MESSAGE_CHARS) throw new Error(`第 ${index + 1} 条消息的推理过程过大`);
  const reasoning = rawReasoning;
  const model = text(message.model, 300);
  const providerName = text(message.providerName, 100);
  const finishReason = text(message.finishReason, 100);
  const attachments = portableAttachments(message.attachments);
  const usage = portableUsage(message.usage);
  if (reasoning) result.reasoning = reasoning;
  if (model) result.model = model;
  if (providerName) result.providerName = providerName;
  if (finishReason) result.finishReason = finishReason;
  if (message.incomplete === true) result.incomplete = true;
  if (attachments.length) result.attachments = attachments;
  if (usage) result.usage = usage;
  return result;
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("导入文件中没有对话消息");
  if (value.length > MAX_MESSAGES) throw new Error(`单个对话最多支持 ${MAX_MESSAGES} 条消息`);
  const messages = value.map(portableMessage);
  const totalChars = messages.reduce((total, message) => total + message.content.length + (message.reasoning?.length || 0), 0);
  if (totalChars > MAX_TOTAL_CHARS) throw new Error("导入的对话文本过大，请拆分后再导入");
  return messages;
}

function portableSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const field of ["temperature", "topP", "maxTokens"]) {
    const number = Number(value[field]);
    if (Number.isFinite(number)) result[field] = number;
  }
  if (typeof value.reasoningEffort === "string") result.reasoningEffort = value.reasoningEffort.slice(0, 30);
  return result;
}

export function createConversationExport(messages, metadata = {}) {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: typeof metadata.exportedAt === "string" ? metadata.exportedAt : new Date().toISOString(),
    app: {name: "ModelBridge", version: text(metadata.appVersion, 30)},
    context: {
      providerName: text(metadata.providerName, 100),
      model: text(metadata.model, 300),
      settings: portableSettings(metadata.settings)
    },
    messages: normalizeMessages(messages)
  };
}

export function importConversationExport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("导入文件不是有效的对话对象");
  if (value.format !== FORMAT || value.version !== FORMAT_VERSION) {
    throw new Error("只支持 ModelBridge v1 对话备份 JSON");
  }
  return normalizeMessages(value.messages);
}

function singleLine(value) {
  return text(value, 300).replace(/\s+/g, " ").trim();
}

export function conversationToMarkdown(exported) {
  const messages = importConversationExport(exported);
  const lines = ["# ModelBridge 对话", ""];
  const exportedAt = singleLine(exported.exportedAt);
  const provider = singleLine(exported.context?.providerName);
  const model = singleLine(exported.context?.model);
  if (exportedAt) lines.push(`> 导出时间：${exportedAt}`);
  if (provider) lines.push(`> 平台：${provider}`);
  if (model) lines.push(`> 模型：${model}`);
  if (lines.at(-1)?.startsWith(">")) lines.push("");

  messages.forEach((message, index) => {
    const title = message.role === "user" ? "用户" : `助手${message.model ? ` · ${singleLine(message.model)}` : ""}`;
    lines.push(`## ${title}`, "", message.content, "");
    if (message.attachments?.length) {
      lines.push("### 附件（仅保留元数据）", "", ...message.attachments.map(item => `- ${item.name}`), "");
    }
    if (message.reasoning) lines.push("### 推理过程", "", message.reasoning, "");
    if (message.incomplete) lines.push("> 此回答在导出时标记为未完成。", "");
    if (index < messages.length - 1) lines.push("---", "");
  });
  return `${lines.join("\n").trim()}\n`;
}
