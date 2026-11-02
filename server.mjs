import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
  buildDiagnosticReport,
  classifyDiagnosticError,
  diagnosticCheck,
  diagnosticSecrets,
  redactDiagnosticText
} from "./diagnostics.mjs";
import {createSseParser} from "./web/sse.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.local.json");
const LEGACY_CONFIG_PATH = path.join(ROOT, "api.txt");
const APP_VERSION = "1.9.1";
const CONFIG_VERSION = 1;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_TEXT_CHARS = 240_000;
const MAX_MODEL_LIST_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_MODEL_CATALOG_ENTRIES = 1_000;
const MAX_REMOTE_ERROR_BYTES = 64 * 1024;
const MAX_NON_STREAM_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;
const CHAT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const OPTIONAL_CHAT_PARAMETERS = Object.freeze(["temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "stream_options"]);
const modelCompatibilityCache = new Map();
const modelCatalogCache = new Map();
const remoteModelsCache = new Map();
const MODEL_CATALOG_PROFILE = Symbol("modelCatalogProfile");
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const REMOTE_MODELS_TTL_MS = 5 * 60 * 1000;

export const PROVIDER_PRESETS = Object.freeze([
  {
    id: "aliyun-bailian",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "工作空间专属地址可直接覆盖此地址",
    beginnerNote: "通常只需粘贴百炼 API Key，其余保持推荐配置",
    recommendedModels: ["qwen-plus", "qwen-flash"]
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "标准 OpenAI Chat Completions 接口",
    beginnerNote: "只需粘贴 OpenAI API Key，程序会自动读取模型",
    recommendedModels: ["gpt-4.1-mini"]
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "DeepSeek 官方 OpenAI 兼容接口；不要填写 /anthropic 地址",
    beginnerNote: "只需粘贴 DeepSeek API Key；不要把 Claude Code 使用的 /anthropic 地址填到这里",
    recommendedModels: ["deepseek-flash", "deepseek-v4-pro"]
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "一个 Key 使用多个模型供应商",
    beginnerNote: "只需粘贴 OpenRouter API Key，模型会自动读取"
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "SiliconFlow 中国站",
    beginnerNote: "只需粘贴硅基流动 API Key，模型会自动读取"
  },
  {
    id: "gemini",
    name: "Google Gemini（OpenAI 兼容）",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "适合基础聊天；Gemini 原生高级能力需要独立适配",
    beginnerNote: "使用 Google AI Studio 的 Gemini API Key；这里走官方 OpenAI 兼容层"
  },
  {
    id: "anthropic",
    name: "Anthropic Claude（OpenAI 兼容）",
    baseUrl: "https://api.anthropic.com/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "适合基础聊天；Claude 原生文件与缓存能力需要独立适配",
    beginnerNote: "使用 Claude Console API Key；这里只验证 OpenAI 兼容聊天"
  },
  {
    id: "ollama",
    name: "Ollama（本机）",
    baseUrl: "http://127.0.0.1:11434/v1",
    authMode: "none",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "本机 Ollama，无需 API Key",
    beginnerNote: "保持 Ollama 正在运行即可，不需要填写 API Key"
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    baseUrl: "",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "适用于其他 OpenAI-compatible 平台",
    beginnerNote: "需要从平台文档找到 OpenAI 兼容 Base URL；Anthropic/Gemini 原生地址不能直接使用"
  }
]);

const AUTH_MODES = new Set(["bearer", "x-api-key", "api-key", "custom", "none"]);
const BLOCKED_EXTRA_HEADERS = new Set([
  "authorization", "proxy-authorization", "cookie", "set-cookie", "host",
  "content-length", "transfer-encoding", "x-api-key", "api-key"
]);

function now() {
  return new Date().toISOString();
}

function asText(value, max = 1000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeFilename(value) {
  return String(value || "attachment").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 240) || "attachment";
}

export function sanitizeMessageContent(content, role = "user") {
  if (typeof content === "string") return content.slice(0, 1_000_000);
  if (role !== "user" || !Array.isArray(content) || content.length === 0) {
    throw new Error("只有用户消息支持附件内容");
  }

  const parts = [];
  for (const part of content.slice(0, 20)) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({type: "text", text: part.text.slice(0, 1_000_000)});
      continue;
    }
    if (part.type === "image_url") {
      const image = typeof part.image_url === "string" ? {url: part.image_url} : part.image_url;
      const url = typeof image?.url === "string" ? image.url : "";
      const isDataImage = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/i.test(url);
      const isHttpsImage = /^https:\/\/[^\s]+$/i.test(url);
      if (!isDataImage && !isHttpsImage) throw new Error("图片必须是 PNG/JPEG/WEBP/GIF 的 Base64 数据或 HTTPS URL");
      if (url.length > 12_000_000) throw new Error("单张图片数据过大");
      const detail = ["auto", "low", "high", "original"].includes(image?.detail) ? image.detail : "auto";
      parts.push({type: "image_url", image_url: {url, detail}});
      continue;
    }
    if (part.type === "file") {
      const file = part.file;
      const fileData = typeof file?.file_data === "string" ? file.file_data : "";
      if (!/^data:application\/pdf;base64,[A-Za-z0-9+/=\r\n]+$/i.test(fileData)) {
        throw new Error("Chat Completions 附件只接受 Base64 PDF 文件");
      }
      if (fileData.length > 16_000_000) throw new Error("PDF 文件数据过大");
      parts.push({type: "file", file: {filename: safeFilename(file.filename || "document.pdf"), file_data: fileData}});
    }
  }
  if (!parts.length) throw new Error("附件消息中没有可用内容");
  return parts;
}

function isLocalHostname(hostname) {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export function normalizeBaseUrl(value) {
  const raw = asText(value, 2048);
  if (!raw) throw new Error("请填写 Base URL");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Base URL 格式不正确，应以 http:// 或 https:// 开头");
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Base URL 只支持 HTTP 或 HTTPS");
  if (parsed.username || parsed.password) throw new Error("Base URL 中不能包含用户名或密码");
  if (parsed.search || parsed.hash) throw new Error("Base URL 中不能包含查询参数或锚点");
  if (parsed.protocol === "http:" && !isLocalHostname(parsed.hostname)) {
    throw new Error("远程 API 必须使用 HTTPS；HTTP 仅允许 localhost/127.0.0.1");
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

export function normalizeEndpointPath(value, fallback) {
  const result = asText(value || fallback, 1000);
  if (!result.startsWith("/") || result.includes("://") || result.includes("\\")) {
    throw new Error("接口路径必须以 / 开头，且不能是完整 URL");
  }
  return result;
}

function parseManualModels(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return [...new Set(values.map(item => asText(String(item), 300)).filter(Boolean))].slice(0, 500);
}

function normalizeExtraHeaders(value) {
  if (!value) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("附加请求头必须是 JSON 对象");
  const result = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = asText(rawName, 100);
    const headerValue = asText(String(rawValue), 1000);
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`请求头名称不合法：${name}`);
    if (BLOCKED_EXTRA_HEADERS.has(name.toLowerCase())) throw new Error(`请使用认证设置配置请求头：${name}`);
    if (/[\r\n]/.test(headerValue) || /[^\u0009\u0020-\u00ff]/.test(headerValue)) {
      throw new Error(`请求头 ${name} 的值包含中文或不支持的字符；请只填写平台文档给出的英文/数字值`);
    }
    if (headerValue) result[name] = headerValue;
  }
  return result;
}

function presetById(id) {
  return PROVIDER_PRESETS.find(item => item.id === id) || PROVIDER_PRESETS.at(-1);
}

const PROFILE_ENUMS = Object.freeze({
  imageInput: new Set(["unknown", "unsupported", "base64", "url-only"]),
  pdfInput: new Set(["unknown", "unsupported", "supported"]),
  toolCalling: new Set(["unknown", "unsupported", "supported"]),
  reasoning: new Set(["unknown", "unsupported", "supported"]),
  streamOnly: new Set(["unknown", "yes", "no"]),
  temperatureMode: new Set(["unknown", "flexible", "fixed", "unsupported"]),
  topPMode: new Set(["unknown", "flexible", "fixed", "unsupported"])
});

function optionalNumber(value, {min = 0, max = Number.MAX_SAFE_INTEGER, integer = false} = {}) {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const bounded = Math.max(min, Math.min(max, number));
  return integer ? Math.round(bounded) : bounded;
}

export function normalizeModelOverride(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result = {};
  for (const [field, values] of Object.entries(PROFILE_ENUMS)) {
    if (values.has(value[field])) result[field] = value[field];
  }
  const reasoningEfforts = parseManualModels(value.reasoningEfforts)
    .filter(item => ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item));
  if (reasoningEfforts.length) result.reasoningEfforts = reasoningEfforts;
  for (const [field, options] of Object.entries({
    temperatureValue: {min: 0, max: 2},
    topPValue: {min: 0, max: 1},
    contextWindow: {min: 1, max: 10_000_000, integer: true},
    maxOutputTokens: {min: 1, max: 10_000_000, integer: true},
    inputPrice: {min: 0, max: 1_000_000},
    outputPrice: {min: 0, max: 1_000_000},
    cachedInputPrice: {min: 0, max: 1_000_000}
  })) {
    const number = optionalNumber(value[field], options);
    if (number !== null) result[field] = number;
  }
  return result;
}

function normalizeModelOverrides(value, fallback = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  const result = {};
  for (const [rawModel, rawProfile] of Object.entries(source || {}).slice(0, 500)) {
    const model = asText(rawModel, 300);
    const profile = normalizeModelOverride(rawProfile);
    if (model && Object.keys(profile).length) result[model] = profile;
  }
  return result;
}

export function normalizeProvider(input, existing = null) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("供应商配置无效");
  const preset = presetById(asText(input.presetId, 100));
  const authMode = asText(input.authMode, 30) || preset.authMode;
  if (!AUTH_MODES.has(authMode)) throw new Error("不支持的认证方式");

  const apiKey = input.apiKey === undefined || input.apiKey === ""
    ? (existing?.apiKey || "")
    : asText(input.apiKey, 20_000);
  if (authMode !== "none" && !apiKey) throw new Error("请填写 API Key");
  if (apiKey && !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error("API Key 包含中文、空格或换行；请只粘贴平台生成的 Key 本身，不要粘贴“你的 API Key”等说明文字");
  }

  const modelsMode = input.modelsMode === "manual" ? "manual" : "auto";
  const manualModels = parseManualModels(input.manualModels);
  if (modelsMode === "manual" && manualModels.length === 0) throw new Error("手动模式至少要填写一个模型 ID");

  const apiKeyHeader = authMode === "custom" ? asText(input.apiKeyHeader, 100) : "";
  if (authMode === "custom" && !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(apiKeyHeader)) {
    throw new Error("请填写合法的自定义认证请求头名称");
  }

  const createdAt = existing?.createdAt || now();
  return {
    id: existing?.id || asText(input.id, 100) || crypto.randomUUID(),
    name: asText(input.name, 100) || preset.name,
    presetId: preset.id,
    protocol: "openai-chat-completions",
    baseUrl: normalizeBaseUrl(input.baseUrl || preset.baseUrl),
    apiKey,
    authMode,
    apiKeyHeader,
    authScheme: authMode === "bearer" ? (asText(input.authScheme, 30) || "Bearer") : "",
    modelsMode,
    manualModels,
    defaultModel: asText(input.defaultModel, 300),
    modelsPath: normalizeEndpointPath(input.modelsPath, preset.modelsPath),
    chatPath: normalizeEndpointPath(input.chatPath, preset.chatPath),
    extraHeaders: normalizeExtraHeaders(input.extraHeaders),
    modelOverrides: normalizeModelOverrides(input.modelOverrides, existing?.modelOverrides),
    createdAt,
    updatedAt: now()
  };
}

export function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    presetId: provider.presetId,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    hasApiKey: Boolean(provider.apiKey),
    apiKeyHint: provider.apiKey ? `••••${provider.apiKey.slice(-4)}` : "",
    authMode: provider.authMode,
    apiKeyHeader: provider.apiKeyHeader,
    authScheme: provider.authScheme,
    modelsMode: provider.modelsMode,
    manualModels: provider.manualModels,
    defaultModel: provider.defaultModel,
    modelsPath: provider.modelsPath,
    chatPath: provider.chatPath,
    extraHeaders: provider.extraHeaders,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt
  };
}

export function classifyModel(modelId) {
  const name = String(modelId || "").toLowerCase();
  if (["embedding", "embed-", "rerank"].some(word => name.includes(word))) return "向量/排序";
  if (["image", "flux", "stable-diffusion", "z-image"].some(word => name.includes(word)) || /^wan[\d.-]/.test(name)) return "图像生成";
  if (["tts", "speech", "asr", "transcribe", "livetranslate", "s2s"].some(word => name.includes(word))) return "语音/实时";
  if (/(?:^|\/)kimi-k(?:2\.6|2\.7|3)(?:[./-]|$)/.test(name)) return "多模态";
  if (["audio", "omni", "vision", "-vl", "/vl", "ocr", "gui"].some(word => name.includes(word))) return "多模态";
  return "文本对话";
}

function isKimiModel(modelId) {
  return /(?:^|\/)kimi-k(?:2\.6|2\.7|3)(?:[./-]|$)/.test(String(modelId || "").toLowerCase());
}

function isKimiK3ReasoningModel(modelId) {
  return /(?:^|\/)kimi-k3(?:$|\.1-pro(?:-highspeed)?$)/.test(String(modelId || "").toLowerCase());
}

function isAliyunKimi(provider, modelId) {
  return provider?.presetId === "aliyun-bailian" && isKimiModel(modelId);
}

function knownModelProfile(modelId, provider) {
  const id = String(modelId || "").toLowerCase();
  const result = {};
  if (isKimiModel(id)) {
    Object.assign(result, {
      reasoning: "supported",
      streamOnly: "no",
      temperatureMode: "fixed",
      temperatureValue: id.includes("k2.6") ? 1 : 1,
      topPMode: "fixed",
      topPValue: 0.95
    });
  }
  if (isKimiK3ReasoningModel(id)) {
    Object.assign(result, {
      toolCalling: "supported",
      reasoningEfforts: ["max"],
      contextWindow: 1_048_576,
      maxOutputTokens: 1_048_576
    });
  }
  const prices = [
    [/kimi-k3(?:$|\.1-pro)/, [20, 100, 2]],
    [/kimi-k2\.7-code-highspeed$/, [13, 54, null]],
    [/kimi-k2\.(?:7-code|6)$/, [6.5, 27, null]],
    [/kimi-k2\.5$/, [4, 21, null]]
  ].find(([pattern]) => pattern.test(id))?.[1];
  if (provider?.presetId === "aliyun-bailian" && prices) {
    Object.assign(result, {
      inputPrice: prices[0],
      outputPrice: prices[1],
      ...(prices[2] !== null ? {cachedInputPrice: prices[2]} : {}),
      priceAsOf: "2026-10-31"
    });
  }
  return result;
}

function catalogProfile(entry) {
  if (!entry) return {};
  if (entry[MODEL_CATALOG_PROFILE]) return entry[MODEL_CATALOG_PROFILE];
  const requestModalities = entry.inference_metadata?.request_modality || entry.inferenceMetadata?.requestModality || [];
  const features = (entry.features || []).map(item => String(item).toLowerCase());
  const capabilities = (entry.capabilities || []).map(item => String(item).toLowerCase());
  const modelInfo = entry.model_info || entry.modelInfo || {};
  const result = {
    ...(requestModalities.some(item => String(item).toLowerCase() === "image") ? {imageInput: "unknown"} : {}),
    ...(features.includes("function-calling") ? {toolCalling: "supported"} : {}),
    ...(capabilities.some(item => item.includes("reason")) ? {reasoning: "supported"} : {}),
    contextWindow: optionalNumber(modelInfo.context_window ?? modelInfo.contextWindow, {min: 1, max: 10_000_000, integer: true}),
    maxOutputTokens: optionalNumber(modelInfo.max_output_tokens ?? modelInfo.maxOutputTokens, {min: 1, max: 10_000_000, integer: true})
  };
  const priceRanges = Array.isArray(entry.prices) ? entry.prices : [];
  const range = priceRanges.find(item => /default|默认/i.test(String(item.range_name || item.rangeName || ""))) || priceRanges[0];
  for (const priceItem of range?.prices || []) {
    const label = `${priceItem.type || ""} ${priceItem.price_name || priceItem.priceName || ""}`.toLowerCase();
    const unit = String(priceItem.price_unit || priceItem.priceUnit || "");
    if (unit && !/百万|million/i.test(unit)) continue;
    const price = optionalNumber(priceItem.price, {min: 0, max: 1_000_000});
    if (price === null) continue;
    if (/cache|缓存/.test(label) && /input|输入/.test(label)) result.cachedInputPrice = price;
    else if (/output|输出/.test(label)) result.outputPrice = price;
    else if (/input|输入/.test(label)) result.inputPrice = price;
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== null));
}

export function modelProfile(modelId, provider = {}, catalogEntry = null) {
  const category = classifyModel(modelId);
  const chat = category === "文本对话" || category === "多模态";
  const aliyunKimi = isAliyunKimi(provider, modelId);
  const profile = {
    chat,
    imageInput: category === "多模态" ? (aliyunKimi ? "url-only" : "unknown") : "unsupported",
    pdfInput: aliyunKimi ? "unsupported" : (provider?.presetId === "openai" ? "supported" : "unknown"),
    toolCalling: "unknown",
    reasoning: "unknown",
    streamOnly: "unknown",
    temperatureMode: "unknown",
    topPMode: "unknown",
    reasoningEfforts: [],
    contextWindow: null,
    maxOutputTokens: null,
    inputPrice: null,
    outputPrice: null,
    cachedInputPrice: null,
    currency: "CNY",
    priceUnit: "每百万 Token",
    sources: ["名称推断"]
  };
  const known = knownModelProfile(modelId, provider);
  if (Object.keys(known).length) {
    Object.assign(profile, known);
    profile.sources.push("内置规则");
  }
  const catalog = catalogProfile(catalogEntry);
  if (Object.keys(catalog).length) {
    if (catalog.imageInput === "unknown" && profile.imageInput !== "unknown") delete catalog.imageInput;
    Object.assign(profile, catalog);
    profile.sources.push("阿里云模型目录");
  }
  const override = provider?.modelOverrides?.[modelId];
  if (override) {
    Object.assign(profile, override);
    profile.sources.push("用户覆盖");
    profile.custom = true;
  } else {
    profile.custom = false;
  }
  profile.localImageInput = profile.imageInput !== "unsupported" && profile.imageInput !== "url-only";
  profile.sources = [...new Set(profile.sources)];
  return profile;
}

export function modelCapabilities(modelId, provider = {}, catalogEntry = null) {
  return modelProfile(modelId, provider, catalogEntry);
}

export function endpointUrl(provider, endpointPath) {
  return `${provider.baseUrl.replace(/\/+$/, "")}${endpointPath}`;
}

export function providerProtocolIssue(provider) {
  let url;
  try { url = new URL(provider?.baseUrl); }
  catch { return null; }
  const path = url.pathname.replace(/\/+$/, "").toLowerCase();
  if (url.hostname.toLowerCase() === "api.deepseek.com" && /^\/anthropic(?:\/|$)/.test(path)) {
    return {
      code: "anthropic_endpoint",
      summary: "选错了接口协议：这是 DeepSeek 的 Anthropic API 地址",
      detail: "https://api.deepseek.com/anthropic 是给 Claude Code 或 Anthropic SDK 使用的 Messages API，不是 OpenAI Chat Completions",
      suggestion: "选择 DeepSeek 预设并恢复推荐配置：Base URL 使用 https://api.deepseek.com，认证方式使用 Bearer Token"
    };
  }
  if (/\/v1\/messages$/.test(path) || /\/messages$/.test(path)) {
    return {
      code: "anthropic_endpoint",
      summary: "填写的是 Anthropic Messages API 地址",
      detail: "ModelBridge 当前这个接入方式使用 OpenAI Chat Completions 协议",
      suggestion: "查找平台文档中的 OpenAI 兼容 Base URL，或选择已有平台预设"
    };
  }
  if (/generatecontent/i.test(path)) {
    return {
      code: "gemini_native_endpoint",
      summary: "填写的是 Gemini 原生 generateContent 地址",
      detail: "ModelBridge 当前这个接入方式使用 OpenAI Chat Completions 协议",
      suggestion: "选择 Google Gemini（OpenAI 兼容）预设，不要粘贴完整 generateContent 地址"
    };
  }
  if (/\/(?:chat\/completions|models)$/.test(path)) {
    return {
      code: "full_endpoint",
      summary: "Base URL 填成了单个接口的完整地址",
      detail: `当前路径以 ${path.endsWith("/models") ? "/models" : "/chat/completions"} 结尾，程序还会自动追加接口路径`,
      suggestion: "删除末尾的接口名，只保留平台文档所说的 Base URL，或重新选择平台预设"
    };
  }
  return null;
}

export function unsupportedOptionalParameter(message, payload = {}) {
  const text = String(message || "").toLowerCase();
  const rejected = /not supported|unsupported|does not support|unknown parameter|unrecognized parameter|not allowed|invalid value|must be|only (?:supports?|accepts?)|deprecated|incompatible|use .+ instead|不支持|未知参数|无效参数|必须为|仅支持|只能|已弃用|不兼容|请改用/.test(text);
  if (!rejected) return "";
  return OPTIONAL_CHAT_PARAMETERS.find(parameter =>
    Object.prototype.hasOwnProperty.call(payload, parameter) && text.includes(parameter)
  ) || "";
}

export function knownUnsupportedParameters(model) {
  const id = String(model || "").trim().toLowerCase();
  if (/(?:^|\/)kimi-k(?:2\.6|2\.7(?:-code(?:-highspeed)?)?|3(?:\.1-pro(?:-highspeed)?)?)$/.test(id)) {
    return ["temperature", "top_p"];
  }
  return [];
}

function compatibilityKey(provider, model) {
  return `${provider.id}\u0000${provider.baseUrl}\u0000${model}`;
}

function rememberUnsupportedParameter(provider, model, parameter) {
  if (modelCompatibilityCache.size >= 500) modelCompatibilityCache.clear();
  const key = compatibilityKey(provider, model);
  const parameters = modelCompatibilityCache.get(key) || new Set();
  parameters.add(parameter);
  modelCompatibilityCache.set(key, parameters);
}

function preferredOutputTokenParameter(provider, unsupported = new Set()) {
  const preferred = provider.presetId === "openai" ? "max_completion_tokens" : "max_tokens";
  const fallback = preferred === "max_tokens" ? "max_completion_tokens" : "max_tokens";
  if (!unsupported.has(preferred)) return preferred;
  if (!unsupported.has(fallback)) return fallback;
  return "";
}

function buildHeaders(provider) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...provider.extraHeaders
  };
  if (provider.authMode === "bearer") headers.Authorization = `${provider.authScheme || "Bearer"} ${provider.apiKey}`;
  if (provider.authMode === "x-api-key") headers["x-api-key"] = provider.apiKey;
  if (provider.authMode === "api-key") headers["api-key"] = provider.apiKey;
  if (provider.authMode === "custom") headers[provider.apiKeyHeader] = provider.apiKey;
  return headers;
}

function timedSignal(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const abort = event => controller.abort(event.target.reason);
  signal.addEventListener("abort", abort, {once: true});
  timeout.addEventListener("abort", abort, {once: true});
  return controller.signal;
}

async function remoteFetch(provider, endpointPath, options = {}) {
  return fetch(endpointUrl(provider, endpointPath), {
    ...options,
    headers: {...buildHeaders(provider), ...(options.headers || {})},
    signal: options.signal || AbortSignal.timeout(300_000),
    redirect: "error"
  });
}

export async function readResponseText(response, maxBytes, label = "上游响应", onChunk = null) {
  const limit = Number(maxBytes);
  if (!Number.isInteger(limit) || limit < 1) throw new Error("响应大小限制无效");
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label}超过 ${limit} 字节限制`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}超过 ${limit} 字节限制`);
      }
      chunks.push(Buffer.from(value));
      onChunk?.();
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readResponseJson(response, maxBytes, label, onChunk = null) {
  const raw = await readResponseText(response, maxBytes, label, onChunk);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
}

function emptyConfig() {
  return {version: CONFIG_VERSION, activeProviderId: "", providers: []};
}

function safeJsonParse(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
}

function normalizeStoredConfig(raw) {
  const result = emptyConfig();
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.providers)) return result;
  for (const item of raw.providers.slice(0, 30)) {
    try {
      result.providers.push(normalizeProvider(item, item));
    } catch (error) {
      console.warn(`忽略无效供应商配置：${error.message}`);
    }
  }
  result.activeProviderId = result.providers.some(item => item.id === raw.activeProviderId)
    ? raw.activeProviderId
    : (result.providers[0]?.id || "");
  return result;
}

export function parseLegacyApiText(text) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const urlLines = lines.filter(line => /https?:\/\//i.test(line));
  const preferredUrlLine = urlLines.find(line => /兼容|compatible|openai/i.test(line)) || urlLines[0] || "";
  const url = preferredUrlLine.match(/https?:\/\/[^\s]+/i)?.[0] || "";
  const keyLine = lines.find(line => !/https?:\/\//i.test(line) && !/^(api\s*host|host)\s*:/i.test(line)) || "";
  const key = keyLine.replace(/^(api[_ -]?key|key)\s*[:=]\s*/i, "").trim();
  return {apiKey: key, baseUrl: url};
}

function writeConfig(config) {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, CONFIG_PATH);
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (fs.existsSync(temporaryPath)) {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
  }
}

function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    return normalizeStoredConfig(safeJsonParse(fs.readFileSync(CONFIG_PATH, "utf8"), "config.local.json"));
  }

  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    const legacy = parseLegacyApiText(fs.readFileSync(LEGACY_CONFIG_PATH, "utf8"));
    if (legacy.apiKey && legacy.baseUrl) {
      const provider = normalizeProvider({
        name: "阿里云百炼",
        presetId: "aliyun-bailian",
        baseUrl: legacy.baseUrl,
        apiKey: legacy.apiKey,
        authMode: "bearer",
        modelsMode: "auto"
      });
      const migrated = {version: CONFIG_VERSION, activeProviderId: provider.id, providers: [provider]};
      writeConfig(migrated);
      console.log("已将 api.txt 自动迁移到 config.local.json（原文件保留）。");
      return migrated;
    }
  }

  const envKey = asText(process.env.AI_API_KEY, 20_000);
  const envBaseUrl = asText(process.env.AI_BASE_URL, 2048);
  if (envBaseUrl && (envKey || process.env.AI_AUTH_MODE === "none")) {
    const provider = normalizeProvider({
      name: process.env.AI_PROVIDER_NAME || "环境变量 API",
      presetId: "custom",
      baseUrl: envBaseUrl,
      apiKey: envKey,
      authMode: process.env.AI_AUTH_MODE || "bearer",
      defaultModel: process.env.AI_MODEL || "",
      manualModels: process.env.AI_MODEL || "",
      modelsMode: process.env.AI_MODEL ? "manual" : "auto"
    });
    return {version: CONFIG_VERSION, activeProviderId: provider.id, providers: [provider]};
  }
  return emptyConfig();
}

function refreshConfigFromDisk(config) {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const latest = normalizeStoredConfig(safeJsonParse(fs.readFileSync(CONFIG_PATH, "utf8"), "config.local.json"));
  config.version = latest.version;
  config.activeProviderId = latest.activeProviderId;
  config.providers.splice(0, config.providers.length, ...latest.providers);
}

function publicState(config) {
  return {
    app: {name: "ModelBridge", version: APP_VERSION, protocol: "openai-chat-completions"},
    configured: config.providers.length > 0,
    activeProviderId: config.activeProviderId,
    providers: config.providers.map(publicProvider),
    presets: PROVIDER_PRESETS
  };
}

function providerById(config, id) {
  const providerId = asText(id, 100) || config.activeProviderId;
  return config.providers.find(item => item.id === providerId) || null;
}

export function extractModelIds(data) {
  const raw = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    const candidate = typeof item === "string" ? item : item?.id || item?.model || item?.name;
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || id.length > 300 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 500) break;
  }
  return ids;
}

async function readRemoteError(response, provider, onChunk = null) {
  let raw = "";
  try {
    raw = await readResponseText(response, MAX_REMOTE_ERROR_BYTES, "模型平台错误响应", onChunk);
  } catch (error) {
    raw = error.message;
  }
  raw = raw.slice(0, 4000);
  let detail = raw;
  try {
    const parsed = JSON.parse(raw);
    detail = parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {}
  if (detail && typeof detail === "object") {
    detail = detail.message || detail.detail || detail.code || JSON.stringify(detail);
  }
  detail = String(detail || `HTTP ${response.status}`);
  if (provider.apiKey) detail = detail.split(provider.apiKey).join("***");
  const friendly = {
    400: "请求参数或模型名称不被平台接受",
    401: "认证失败，请检查 API Key 与 Base URL 是否属于同一平台/区域",
    402: "账户余额或额度不足",
    403: "没有访问权限，请检查模型授权或套餐限制",
    404: "接口路径或模型不存在",
    429: "请求过于频繁或已触发额度限制"
  }[response.status] || (response.status >= 500 ? "模型平台暂时不可用" : "请求失败");
  const error = new Error(`${friendly}（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  error.status = response.status;
  error.code = "UPSTREAM_HTTP";
  return error;
}

function remoteModelsCacheKey(provider) {
  const authFingerprint = crypto.createHash("sha256")
    .update(JSON.stringify([provider.authMode, provider.authScheme, provider.apiKeyHeader, provider.apiKey, provider.extraHeaders]))
    .digest("base64url")
    .slice(0, 16);
  return `${provider.id}\u0000${provider.baseUrl}\u0000${provider.modelsPath}\u0000${authFingerprint}`;
}

function cachedRemoteModels(provider, freshOnly = false) {
  const cached = remoteModelsCache.get(remoteModelsCacheKey(provider));
  if (!cached || freshOnly && Date.now() - cached.at >= REMOTE_MODELS_TTL_MS) return null;
  return cached.ids;
}

async function fetchRemoteModels(provider, {cache = true, signal = null} = {}) {
  const response = await remoteFetch(provider, provider.modelsPath, {method: "GET", signal: timedSignal(signal, 30_000)});
  if (!response.ok) throw await readRemoteError(response, provider);
  const data = await readResponseJson(response, MAX_MODEL_LIST_BYTES, "模型列表响应");
  const ids = extractModelIds(data);
  if (!ids.length) throw new Error("平台返回了空模型列表；可以改用手动模型模式");
  if (cache) {
    remoteModelsCache.set(remoteModelsCacheKey(provider), {at: Date.now(), ids});
    if (remoteModelsCache.size > 50) remoteModelsCache.delete(remoteModelsCache.keys().next().value);
  }
  return ids;
}

function aliyunCatalogUrl(provider, pageNo) {
  const url = new URL(provider.baseUrl);
  url.pathname = "/api/v1/models";
  url.search = new URLSearchParams({page_no: String(pageNo), page_size: "100", language: "zh-CN", supports: "inference"}).toString();
  return url;
}

async function fetchAliyunModelCatalog(provider) {
  if (provider.presetId !== "aliyun-bailian") return new Map();
  const cacheKey = `${provider.id}\u0000${provider.baseUrl}`;
  const cached = modelCatalogCache.get(cacheKey);
  if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS) return cached.models;

  const models = new Map();
  let entryCount = 0;
  let totalBytes = 0;
  for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
    const response = await fetch(aliyunCatalogUrl(provider, pageNo), {
      method: "GET",
      headers: buildHeaders(provider),
      signal: AbortSignal.timeout(30_000),
      redirect: "error"
    });
    if (!response.ok) throw await readRemoteError(response, provider);
    const raw = await readResponseText(response, MAX_MODEL_LIST_BYTES, "阿里云模型目录响应");
    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_MODEL_CATALOG_BYTES) throw new Error("阿里云模型目录累计响应过大");
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error("阿里云模型目录响应不是有效 JSON"); }
    const page = Array.isArray(data?.output?.models) ? data.output.models : [];
    for (const entry of page) {
      if (entryCount >= MAX_MODEL_CATALOG_ENTRIES) throw new Error("阿里云模型目录条目过多");
      entryCount += 1;
      const id = asText(entry?.model || entry?.id || entry?.name, 300);
      if (!id) continue;
      const compact = {[MODEL_CATALOG_PROFILE]: catalogProfile(entry)};
      models.set(id.toLowerCase(), compact);
      models.set(id.toLowerCase().split("/").at(-1), compact);
    }
    const total = Number(data?.output?.total || entryCount);
    if (!page.length || entryCount >= total) break;
  }
  modelCatalogCache.set(cacheKey, {at: Date.now(), models});
  if (modelCatalogCache.size > 50) modelCatalogCache.delete(modelCatalogCache.keys().next().value);
  return models;
}

function catalogEntryFor(catalog, modelId) {
  const id = String(modelId || "").toLowerCase();
  return catalog?.get(id) || catalog?.get(id.split("/").at(-1)) || null;
}

function activeModelProfile(provider, modelId) {
  const cacheKey = `${provider.id}\u0000${provider.baseUrl}`;
  const catalog = modelCatalogCache.get(cacheKey)?.models;
  return modelProfile(modelId, provider, catalogEntryFor(catalog, modelId));
}

export function effectiveMaxTokens(model, profile = {}, requested = 4096) {
  const numeric = Number(requested);
  let result = Number.isFinite(numeric) ? Math.max(1, Math.min(131_072, Math.round(numeric))) : 4096;
  if (isKimiK3ReasoningModel(model) && result < 8_192) result = 8_192;
  if (profile.maxOutputTokens) result = Math.min(result, profile.maxOutputTokens);
  if (profile.contextWindow) {
    const inputReserve = Math.min(2_048, Math.max(256, Math.floor(profile.contextWindow / 8)));
    result = Math.min(result, Math.max(1, profile.contextWindow - inputReserve));
  }
  return result;
}

export function contextCharBudget(profile, maxOutputTokens = 4096) {
  if (!profile.contextWindow) return MAX_CONTEXT_TEXT_CHARS;
  const availableInputTokens = Math.max(0, profile.contextWindow - Math.max(1, maxOutputTokens));
  return Math.min(2_000_000, Math.max(1, Math.floor(availableInputTokens * 2.5)));
}

async function loadModels(provider) {
  let ids;
  let source;
  let warning = "";
  if (provider.modelsMode === "manual") {
    ids = provider.manualModels;
    source = "manual";
    warning = "当前使用手动模型列表";
  } else {
    const fresh = cachedRemoteModels(provider, true);
    if (fresh) {
      ids = fresh;
      source = "cache";
    } else {
      try {
        ids = await fetchRemoteModels(provider);
        source = "remote";
      } catch (error) {
        const stale = cachedRemoteModels(provider);
        if (stale) {
          ids = stale;
          source = "stale-cache";
          warning = `自动读取失败，已使用上次成功的模型列表：${error.message}`;
        } else {
          if (!provider.manualModels.length) throw error;
          ids = provider.manualModels;
          source = "fallback";
          warning = `自动读取失败，已使用备用列表：${error.message}`;
        }
      }
    }
  }
  let catalog = new Map();
  try { catalog = await fetchAliyunModelCatalog(provider); }
  catch (error) { warning = [warning, `能力与价格目录读取失败，已使用内置规则：${error.message}`].filter(Boolean).join("；"); }
  return {ids, source, warning, catalog};
}

function inspectProbeSse(raw) {
  let validChunk = false;
  let usageAvailable = false;
  let doneSeen = false;
  const parser = createSseParser(event => {
    if (!["message", "error"].includes(event.type)) return true;
    const value = event.data.trim();
    if (!value) return true;
    if (value === "[DONE]") {
      doneSeen = true;
      return false;
    }
    let payload;
    try { payload = JSON.parse(value); }
    catch { throw new Error("平台已响应，但流式返回包含无法解析的数据"); }
    if (event.type === "error" || payload.error) {
      const detail = payload.error;
      throw new Error(typeof detail === "string" ? detail : detail?.message || payload.message || "平台返回流式错误");
    }
    if (Array.isArray(payload?.choices)) validChunk = true;
    if (payload?.usage && typeof payload.usage === "object") usageAvailable = true;
    return true;
  });
  parser.push(raw);
  parser.finish();
  return {validChunk, usageAvailable, doneSeen};
}

async function probeChat(provider, model, {signal = null} = {}) {
  const probeMaxTokens = effectiveMaxTokens(model, modelProfile(model, provider), isKimiK3ReasoningModel(model) ? 64 : 16);
  const payload = {
    model,
    messages: [{role: "user", content: "Reply with OK."}],
    stream: true
  };
  const rejectedParameters = new Set(modelCompatibilityCache.get(compatibilityKey(provider, model)) || []);
  const initialOutputTokenParameter = preferredOutputTokenParameter(provider, rejectedParameters);
  if (initialOutputTokenParameter) payload[initialOutputTokenParameter] = probeMaxTokens;
  if (isKimiK3ReasoningModel(model)) payload.reasoning_effort = "max";
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await remoteFetch(provider, provider.chatPath, {
      method: "POST",
      body: JSON.stringify(payload),
      signal: timedSignal(signal, 60_000)
    });
    if (response.ok) break;
    const error = await readRemoteError(response, provider);
    const unsupported = [400, 422].includes(response.status) ? unsupportedOptionalParameter(error.message, payload) : "";
    if (!["max_tokens", "max_completion_tokens"].includes(unsupported)) throw error;
    delete payload[unsupported];
    rejectedParameters.add(unsupported);
    rememberUnsupportedParameter(provider, model, unsupported);
    const alternate = preferredOutputTokenParameter(provider, rejectedParameters);
    if (alternate) payload[alternate] = probeMaxTokens;
  }
  if (!response?.ok) throw new Error("模型不接受连接测试使用的输出 Token 参数");
  const contentType = response.headers.get("content-type") || "";
  let usageAvailable = false;
  let doneSeen = false;
  if (contentType.includes("text/event-stream")) {
    const raw = await readResponseText(response, MAX_PROBE_RESPONSE_BYTES, "连接测试响应");
    const inspected = inspectProbeSse(raw);
    usageAvailable = inspected.usageAvailable;
    doneSeen = inspected.doneSeen;
    if (!inspected.validChunk) throw new Error("平台已响应，但流式返回格式不是 OpenAI Chat Completions SSE");
  } else {
    const data = await readResponseJson(response, MAX_NON_STREAM_RESPONSE_BYTES, "连接测试响应");
    if (!data?.choices?.length) throw new Error("平台已响应，但返回格式不是 OpenAI Chat Completions");
    usageAvailable = Boolean(data.usage && typeof data.usage === "object");
  }
  const outputTokenParameter = Object.hasOwn(payload, "max_completion_tokens")
    ? "max_completion_tokens"
    : Object.hasOwn(payload, "max_tokens") ? "max_tokens" : "";
  return {
    testedModel: model,
    streaming: contentType.includes("text/event-stream"),
    usageAvailable,
    doneSeen,
    outputTokenParameter,
    rejectedParameters: [...rejectedParameters]
  };
}

async function probeProvider(provider) {
  const ids = provider.modelsMode === "auto" ? await fetchRemoteModels(provider, {cache: false}) : provider.manualModels;
  const model = provider.defaultModel || ids.find(id => modelCapabilities(id, provider).chat) || ids[0];
  if (!model) throw new Error("没有可以用于实际调用测试的模型");
  const result = await probeChat(provider, model);
  return {
    ok: true,
    method: "chat",
    count: ids.length,
    ...result,
    message: `连接成功：读取到 ${ids.length} 个模型，并已实际调用 ${model}`
  };
}

function diagnosticFailureCheck(id, error, stage, secrets, options = {}) {
  const failure = classifyDiagnosticError(error, stage, secrets);
  return diagnosticCheck(id, options.status || failure.status, options.summary || failure.summary, {
    detail: failure.detail,
    suggestion: options.suggestion || failure.suggestion,
    durationMs: options.durationMs
  });
}

async function diagnoseProvider(provider, {signal = null} = {}) {
  const startedAt = now();
  const started = Date.now();
  const checks = [diagnosticCheck("configuration", "pass", "平台配置格式有效", {
    detail: `${provider.protocol} · ${provider.authMode === "none" ? "无需认证" : "已配置认证"}`
  })];
  const observed = {};
  const secrets = diagnosticSecrets(provider);
  let ids = [];
  let modelSource = provider.modelsMode;
  const finishReport = () => {
    const report = buildDiagnosticReport({provider, checks, observed, startedAt});
    report.durationMs = Date.now() - started;
    return report;
  };
  const protocolIssue = providerProtocolIssue(provider);
  if (protocolIssue) {
    checks.push(diagnosticCheck("protocol", "fail", protocolIssue.summary, {
      detail: protocolIssue.detail,
      suggestion: protocolIssue.suggestion
    }));
    return finishReport();
  }

  if (provider.modelsMode === "manual") {
    ids = provider.manualModels;
    checks.push(diagnosticCheck("models", "pass", `使用 ${ids.length} 个手动模型 ID`, {
      suggestion: "手动模型不会调用 /models；请在模型下线或更名后及时更新"
    }));
  } else {
    const modelStarted = Date.now();
    try {
      ids = await fetchRemoteModels(provider, {cache: false, signal});
      modelSource = "remote";
      checks.push(diagnosticCheck("models", "pass", `标准模型列表可用，共发现 ${ids.length} 个模型`, {
        durationMs: Date.now() - modelStarted
      }));
    } catch (error) {
      const fallbackIds = [...new Set([provider.defaultModel, ...provider.manualModels].filter(Boolean))];
      const failure = classifyDiagnosticError(error, "models", secrets);
      const canUseManualModel = fallbackIds.length > 0;
      const modelListOptional = ["not_found", "method_not_allowed", "format"].includes(failure.code)
        || /空模型列表|empty model|模型列表响应/i.test(error.message || "");
      if (canUseManualModel) {
        ids = fallbackIds;
        modelSource = "fallback";
        checks.push(diagnosticFailureCheck("models", error, "models", secrets, {
          status: "warning",
          summary: `自动读取模型失败，改用 ${ids.length} 个手动模型 ID`,
          suggestion: "聊天接口仍会继续验证；保存时建议使用手动模型模式",
          durationMs: Date.now() - modelStarted
        }));
      } else if (modelListOptional) {
        checks.push(diagnosticFailureCheck("models", error, "models", secrets, {
          status: "needs_input",
          summary: "无法自动发现模型，需要手动填写模型 ID",
          suggestion: "填写平台文档中的模型 ID 后重新检测；/models 缺失不代表聊天接口不兼容",
          durationMs: Date.now() - modelStarted
        }));
        observed.modelSource = "unavailable";
        return finishReport();
      } else {
        checks.push(diagnosticFailureCheck("models", error, "models", secrets, {durationMs: Date.now() - modelStarted}));
        observed.modelSource = "unavailable";
        return finishReport();
      }
    }
  }

  observed.modelSource = modelSource;
  observed.modelCount = ids.length;
  const model = provider.defaultModel || ids.find(id => modelCapabilities(id, provider).chat) || ids[0];
  if (!model) {
    checks.push(diagnosticCheck("model_selection", "needs_input", "没有可用于聊天测试的模型", {
      suggestion: "手动填写一个支持 Chat Completions 的文本或多模态模型 ID"
    }));
    return finishReport();
  }

  const chatStarted = Date.now();
  try {
    const result = await probeChat(provider, model, {signal});
    Object.assign(observed, result);
    checks.push(diagnosticCheck("chat", result.streaming ? "pass" : "warning", result.streaming
      ? "Chat Completions 与 SSE 流式响应可用"
      : "Chat Completions 可用，但平台返回的是非流式响应", {
      detail: `已用 ${model} 完成最小回复测试`,
      suggestion: result.streaming ? "" : "ModelBridge 会把非流式 JSON 转换后显示，但不会逐字输出",
      durationMs: Date.now() - chatStarted
    }));
    checks.push(diagnosticCheck("output_tokens", "pass", result.outputTokenParameter
      ? `输出上限参数使用 ${result.outputTokenParameter}`
      : "平台不接受输出上限参数，已在测试中省略", {
      detail: result.rejectedParameters.length ? `已拒绝：${result.rejectedParameters.join("、")}` : "未触发参数回退"
    }));
    checks.push(diagnosticCheck("usage", result.usageAvailable ? "pass" : "skipped", result.usageAvailable
      ? "平台返回 Token 用量"
      : "本次测试未返回 Token 用量"));
    checks.push(diagnosticCheck("capabilities", "skipped", "未主动测试图片、PDF 与工具调用", {
      suggestion: "这些能力应以官方目录、模型档案或用户覆盖设置为准"
    }));
  } catch (error) {
    const safeError = new Error(redactDiagnosticText(error.message, secrets), {cause: error.cause});
    safeError.status = error.status;
    safeError.code = error.code;
    checks.push(diagnosticFailureCheck("chat", safeError, "chat", secrets, {durationMs: Date.now() - chatStarted}));
  }

  return finishReport();
}

function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
}

function sendJson(res, status, value) {
  if (res.headersSent) return;
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8", "Content-Length": body.length});
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!size) throw new Error("请求体为空");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
}

function urlPort(url) {
  if (url.port) return Number(url.port);
  if (url.protocol === "http:") return 80;
  if (url.protocol === "https:") return 443;
  return 0;
}

export function trustedOrigin(req, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isLocalHostname(parsed.hostname) && urlPort(parsed) === port;
  } catch {
    return false;
  }
}

export function trustedHost(req, port) {
  const host = String(req.headers?.host || "").trim();
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return isLocalHostname(parsed.hostname) && urlPort(parsed) === port;
  } catch {
    return false;
  }
}

function textLength(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => total + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0);
}

function clippedText(value, limit) {
  if (value.length <= limit) return value;
  const marker = "\n\n[ModelBridge：为适配模型上下文，已省略中间的部分较早文本]\n\n";
  if (limit <= marker.length) return value.slice(0, Math.max(0, limit));
  const available = Math.max(0, limit - marker.length);
  const tail = Math.min(2_000, Math.floor(available * 0.15));
  return `${value.slice(0, available - tail)}${marker}${tail ? value.slice(-tail) : ""}`;
}

function clipContent(content, limit) {
  if (typeof content === "string") return clippedText(content, limit);
  if (!Array.isArray(content)) return content;
  let remaining = limit;
  return content.map(part => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    if (remaining <= 0) return {...part, text: ""};
    const text = clippedText(part.text, Math.max(0, remaining));
    remaining = Math.max(0, remaining - text.length);
    return {...part, text};
  });
}

export function limitMessageContext(messages, maxChars = MAX_CONTEXT_TEXT_CHARS) {
  const systemMessages = messages.filter(message => message.role === "system").slice(0, 1);
  const conversation = messages.filter(message => message.role !== "system");
  const kept = [];
  const numericLimit = Number(maxChars);
  let remaining = Math.max(1, Math.floor(Number.isFinite(numericLimit) ? numericLimit : MAX_CONTEXT_TEXT_CHARS));
  let truncated = systemMessages.length + conversation.length < messages.length;

  if (systemMessages[0]) {
    const limit = Math.min(16_000, conversation.length ? Math.floor(remaining / 4) : remaining);
    if (limit <= 0) {
      systemMessages.length = 0;
      truncated = true;
    } else {
      const content = clipContent(systemMessages[0].content, limit);
      if (textLength(content) < textLength(systemMessages[0].content)) truncated = true;
      systemMessages[0] = {...systemMessages[0], content};
      remaining -= textLength(content);
    }
  }

  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    const message = conversation[index];
    const length = textLength(message.content);
    if (length <= remaining) {
      kept.push(message);
      remaining -= length;
      continue;
    }
    if (!kept.length && remaining > 0) {
      kept.push({...message, content: clipContent(message.content, remaining)});
    }
    truncated = true;
    break;
  }

  kept.reverse();
  return {messages: [...systemMessages, ...kept], truncated};
}

function validateModelAttachments(provider, model, messages, capabilities = activeModelProfile(provider, model)) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === "image_url" && /^data:image\//i.test(part.image_url?.url || "") && !capabilities.localImageInput) {
        throw new Error("阿里云 Kimi 的图片接口只接受公网 HTTPS URL，不能直接发送本机/Base64 图片；请改用支持 Base64 图片的模型");
      }
      if (part?.type === "file" && capabilities.pdfInput === "unsupported") {
        throw new Error("当前模型没有可确认的 PDF 文件输入能力；可将 PDF 转为文本，或切换支持 PDF 的模型");
      }
    }
  }
}

function waitForDrain(res) {
  if (!res.writableNeedDrain || res.destroyed) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

async function writeResponseChunk(res, chunk) {
  if (res.destroyed) return false;
  if (!res.write(chunk)) await waitForDrain(res);
  return !res.destroyed;
}

async function handleChat(req, res, config, idleTimeoutMs = CHAT_IDLE_TIMEOUT_MS) {
  let data;
  try { data = await readJson(req); }
  catch (error) { return sendJson(res, 400, {error: {message: error.message}}); }

  const provider = providerById(config, data.providerId);
  if (!provider) return sendJson(res, 409, {error: {message: "请先配置并选择模型平台"}});
  const model = asText(data.model, 300);
  if (!model || !Array.isArray(data.messages) || !data.messages.length) {
    return sendJson(res, 400, {error: {message: "model 和 messages 不能为空"}});
  }
  const sanitizedMessages = [];
  try {
    for (const message of data.messages.slice(-80)) {
      if (!["system", "user", "assistant"].includes(message?.role)) continue;
      sanitizedMessages.push({role: message.role, content: sanitizeMessageContent(message.content, message.role)});
    }
  } catch (error) {
    return sendJson(res, 400, {error: {message: error.message}});
  }
  if (!sanitizedMessages.length) return sendJson(res, 400, {error: {message: "没有有效消息"}});

  const profile = activeModelProfile(provider, model);
  const requestedMaxTokens = Number.isInteger(data.max_tokens) ? Math.max(1, Math.min(131_072, data.max_tokens)) : 4096;
  const adaptedMaxTokens = effectiveMaxTokens(model, profile, requestedMaxTokens);
  const maxTokensAdapted = Number.isInteger(data.max_tokens) && adaptedMaxTokens !== requestedMaxTokens;
  const limitedContext = limitMessageContext(sanitizedMessages, contextCharBudget(profile, adaptedMaxTokens));
  const messages = limitedContext.messages;
  try { validateModelAttachments(provider, model, messages, profile); }
  catch (error) { return sendJson(res, 400, {error: {message: error.message}}); }

  const compatibilityCacheKey = compatibilityKey(provider, model);
  const cachedUnsupported = modelCompatibilityCache.get(compatibilityCacheKey) || new Set();
  const rejectedParameters = new Set(cachedUnsupported);
  const omittedParameters = [];
  const adaptedParameters = [];
  const payload = {model, messages, stream: true};
  if (typeof data.temperature === "number") payload.temperature = Math.max(0, Math.min(2, data.temperature));
  if (typeof data.top_p === "number") payload.top_p = Math.max(0, Math.min(1, data.top_p));
  if (Number.isInteger(data.max_tokens)) {
    const outputTokenParameter = preferredOutputTokenParameter(provider, cachedUnsupported);
    if (outputTokenParameter) payload[outputTokenParameter] = adaptedMaxTokens;
  }
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(data.reasoning_effort)) payload.reasoning_effort = data.reasoning_effort;
  if (["aliyun-bailian", "openai", "deepseek", "openrouter", "siliconflow"].includes(provider.presetId)) {
    payload.stream_options = {include_usage: true};
  }

  if (profile.temperatureMode === "unsupported" && Object.hasOwn(payload, "temperature")) {
    delete payload.temperature;
    omittedParameters.push("temperature");
  } else if (profile.temperatureMode === "fixed" && profile.temperatureValue !== null && Object.hasOwn(payload, "temperature") && payload.temperature !== profile.temperatureValue) {
    payload.temperature = profile.temperatureValue;
    adaptedParameters.push(`temperature=${profile.temperatureValue}`);
  }
  if (profile.topPMode === "unsupported" && Object.hasOwn(payload, "top_p")) {
    delete payload.top_p;
    omittedParameters.push("top_p");
  } else if (profile.topPMode === "fixed" && profile.topPValue !== null && Object.hasOwn(payload, "top_p") && payload.top_p !== profile.topPValue) {
    payload.top_p = profile.topPValue;
    adaptedParameters.push(`top_p=${profile.topPValue}`);
  }
  if (profile.reasoning === "unsupported" && Object.hasOwn(payload, "reasoning_effort")) {
    delete payload.reasoning_effort;
    omittedParameters.push("reasoning_effort");
  } else if (profile.reasoningEfforts.length && payload.reasoning_effort && !profile.reasoningEfforts.includes(payload.reasoning_effort)) {
    payload.reasoning_effort = profile.reasoningEfforts[0];
    adaptedParameters.push(`reasoning_effort=${profile.reasoningEfforts[0]}`);
  }
  if (maxTokensAdapted) adaptedParameters.push(`max_tokens=${adaptedMaxTokens}`);
  for (const parameter of knownUnsupportedParameters(model)) {
    if (parameter === "temperature" && profile.temperatureMode === "fixed") continue;
    if (parameter === "top_p" && profile.topPMode === "fixed") continue;
    if (Object.prototype.hasOwnProperty.call(payload, parameter)) {
      delete payload[parameter];
      omittedParameters.push(parameter);
    }
  }
  for (const parameter of cachedUnsupported) {
    if (Object.prototype.hasOwnProperty.call(payload, parameter)) {
      delete payload[parameter];
      omittedParameters.push(parameter);
    }
  }

  const upstreamController = new AbortController();
  let timedOut = false;
  let timeout;
  const abortUpstream = () => {
    if (!upstreamController.signal.aborted) upstreamController.abort();
  };
  const resetIdleTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      abortUpstream();
    }, idleTimeoutMs);
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  resetIdleTimeout();

  let response;
  for (let attempt = 0; attempt <= OPTIONAL_CHAT_PARAMETERS.length; attempt += 1) {
    try {
      response = await remoteFetch(provider, provider.chatPath, {
        method: "POST",
        body: JSON.stringify(payload),
        signal: upstreamController.signal
      });
      resetIdleTimeout();
    } catch (error) {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
      if (res.destroyed || upstreamController.signal.aborted && !timedOut) return;
      return sendJson(res, timedOut ? 504 : 502, {error: {message: timedOut ? "模型平台长时间没有返回数据" : `无法连接模型平台：${error.message}`}});
    }
    if (response.ok) break;

    const status = response.status;
    const error = await readRemoteError(response, provider, resetIdleTimeout);
    if (timedOut) {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
      return sendJson(res, 504, {error: {message: "模型平台长时间没有返回数据"}});
    }
    const unsupported = [400, 422].includes(status) ? unsupportedOptionalParameter(error.message, payload) : "";
    if (!unsupported) {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
      return sendJson(res, status, {error: {message: error.message}});
    }

    delete payload[unsupported];
    rememberUnsupportedParameter(provider, model, unsupported);
    rejectedParameters.add(unsupported);
    if (["max_tokens", "max_completion_tokens"].includes(unsupported)) {
      const alternate = unsupported === "max_tokens" ? "max_completion_tokens" : "max_tokens";
      if (!rejectedParameters.has(alternate)) payload[alternate] = adaptedMaxTokens;
    } else {
      omittedParameters.push(unsupported);
    }
  }

  if (!response?.ok) {
    clearTimeout(timeout);
    req.off("aborted", abortUpstream);
    return sendJson(res, 400, {error: {message: "模型不接受当前可选参数，自动兼容重试仍未成功"}});
  }

  if (Number.isInteger(data.max_tokens)) {
    if (Object.hasOwn(payload, "max_completion_tokens")) {
      adaptedParameters.push("max_tokens->max_completion_tokens");
    } else if (!Object.hasOwn(payload, "max_tokens")) {
      omittedParameters.push("max_tokens");
    }
  }

  const responseHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "close",
    "X-Accel-Buffering": "no"
  };
  if (omittedParameters.length) {
    responseHeaders["X-ModelBridge-Omitted-Parameters"] = [...new Set(omittedParameters)].join(",");
  }
  if (adaptedParameters.length) responseHeaders["X-ModelBridge-Adapted-Parameters"] = adaptedParameters.join(",");
  if (limitedContext.truncated) responseHeaders["X-ModelBridge-Context-Truncated"] = "true";
  res.writeHead(200, responseHeaders);

  if (!response.body) {
    clearTimeout(timeout);
    req.off("aborted", abortUpstream);
    return res.end("data: [DONE]\n\n");
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    try {
      const payload = await readResponseJson(response, MAX_NON_STREAM_RESPONSE_BYTES, "模型非流式响应", resetIdleTimeout);
      await writeResponseChunk(res, `data: ${JSON.stringify(payload)}\n\n`);
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    } catch (error) {
      if (!res.destroyed) {
        const message = timedOut ? "模型平台长时间没有返回数据" : error.message;
        await writeResponseChunk(res, `event: error\ndata: ${JSON.stringify({error: {message}})}\n\n`);
        res.end();
      }
    } finally {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
    }
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done || res.destroyed) break;
      resetIdleTimeout();
      if (!await writeResponseChunk(res, value)) break;
    }
  } catch (error) {
    if (!res.destroyed && (timedOut || !upstreamController.signal.aborted)) {
      const message = timedOut ? "模型平台长时间没有返回数据" : error.message;
      await writeResponseChunk(res, `event: error\ndata: ${JSON.stringify({error: {message}})}\n\n`);
    }
  } finally {
    clearTimeout(timeout);
    req.off("aborted", abortUpstream);
    if (res.destroyed && !res.writableEnded) reader.cancel().catch(() => {});
  }
  if (!res.destroyed) res.end();
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStatic(urlPath, res) {
  const relative = urlPath === "/" || urlPath === "/index.html" ? "web/index.html" : urlPath.replace(/^\//, "");
  const filePath = path.resolve(ROOT, relative);
  const webRoot = path.resolve(ROOT, "web");
  if (!filePath.startsWith(`${webRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(res, 404, {error: {message: "页面不存在"}});
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {"Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream", "Content-Length": body.length});
  res.end(body);
}

export function createAppServer(options = {}) {
  const port = Number(options.port ?? process.env.MODELBRIDGE_PORT ?? process.env.BAILIAN_PORT ?? 8000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("服务端口必须是 0 到 65535 之间的整数");
  const chatIdleTimeoutMs = Number(options.chatIdleTimeoutMs ?? CHAT_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(chatIdleTimeoutMs) || chatIdleTimeoutMs <= 0) throw new Error("聊天空闲超时必须是正数");
  const config = options.config || loadConfig();
  const usesPersistentConfig = !options.config;

  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    const requestUrl = new URL(req.url, `http://localhost:${port}`);
    const pathname = requestUrl.pathname;
    const address = server.address();
    const trustedPort = address && typeof address === "object" ? address.port : port;

    if (pathname.startsWith("/api/") && (!trustedHost(req, trustedPort) || !trustedOrigin(req, trustedPort))) {
      return sendJson(res, 403, {error: {message: "拒绝来自其他网站或主机名的本机 API 请求"}});
    }

    try {
      if (usesPersistentConfig && pathname.startsWith("/api/")) refreshConfigFromDisk(config);
      if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, {ok: true, app: "ModelBridge", version: APP_VERSION});
      if (req.method === "GET" && pathname === "/api/state") return sendJson(res, 200, publicState(config));

      if (req.method === "GET" && pathname === "/api/models") {
        const provider = providerById(config, requestUrl.searchParams.get("providerId"));
        if (!provider) return sendJson(res, 409, {error: {message: "请先添加模型平台"}});
        const result = await loadModels(provider);
        const models = result.ids.map(id => ({
          id,
          category: classifyModel(id),
          capabilities: modelProfile(id, provider, catalogEntryFor(result.catalog, id))
        }))
          .sort((a, b) => Number(a.category !== "文本对话") - Number(b.category !== "文本对话") || a.id.localeCompare(b.id));
        return sendJson(res, 200, {data: models, count: models.length, source: result.source, warning: result.warning});
      }

      if (req.method === "POST" && pathname === "/api/providers/test") {
        const data = await readJson(req);
        const existing = data.id ? providerById(config, data.id) : null;
        const provider = normalizeProvider(data, existing);
        const issue = providerProtocolIssue(provider);
        if (issue) throw new Error(`${issue.summary}。${issue.suggestion}`);
        return sendJson(res, 200, await probeProvider(provider));
      }

      if (req.method === "POST" && pathname === "/api/providers/diagnose") {
        const data = await readJson(req);
        const existing = data.id ? providerById(config, data.id) : null;
        if (data.id && !existing) return sendJson(res, 404, {error: {message: "要检测的平台不存在"}});
        const provider = normalizeProvider(data, existing);
        const controller = new AbortController();
        const abortDiagnosis = () => controller.abort(new Error("客户端已取消平台诊断"));
        req.once("aborted", abortDiagnosis);
        res.once("close", abortDiagnosis);
        try {
          const report = await diagnoseProvider(provider, {signal: controller.signal});
          if (!res.destroyed) return sendJson(res, 200, report);
        } finally {
          req.off("aborted", abortDiagnosis);
          res.off("close", abortDiagnosis);
        }
        return undefined;
      }

      if (req.method === "POST" && pathname === "/api/providers") {
        const data = await readJson(req);
        const existing = data.id ? providerById(config, data.id) : null;
        if (data.id && !existing) return sendJson(res, 404, {error: {message: "要编辑的平台不存在"}});
        if (!existing && config.providers.length >= 30) return sendJson(res, 400, {error: {message: "最多保存 30 个平台"}});
        const provider = normalizeProvider(data, existing);
        const issue = providerProtocolIssue(provider);
        if (issue) throw new Error(`${issue.summary}。${issue.suggestion}`);
        if (existing) config.providers[config.providers.findIndex(item => item.id === existing.id)] = provider;
        else config.providers.push(provider);
        if (data.activate !== false || !config.activeProviderId) config.activeProviderId = provider.id;
        writeConfig(config);
        return sendJson(res, existing ? 200 : 201, {provider: publicProvider(provider), state: publicState(config)});
      }

      const profileMatch = pathname.match(/^\/api\/providers\/([^/]+)\/models\/([^/]+)\/profile$/);
      if (req.method === "PATCH" && profileMatch) {
        const provider = providerById(config, decodeURIComponent(profileMatch[1]));
        if (!provider) return sendJson(res, 404, {error: {message: "平台不存在"}});
        const model = asText(decodeURIComponent(profileMatch[2]), 300);
        if (!model) return sendJson(res, 400, {error: {message: "模型 ID 不能为空"}});
        const data = await readJson(req);
        provider.modelOverrides ||= {};
        if (data.reset === true) delete provider.modelOverrides[model];
        else {
          const override = normalizeModelOverride(data);
          if (!Object.keys(override).length) return sendJson(res, 400, {error: {message: "没有有效的能力或价格设置"}});
          provider.modelOverrides[model] = override;
        }
        provider.updatedAt = now();
        writeConfig(config);
        let catalog = new Map();
        try { catalog = await fetchAliyunModelCatalog(provider); } catch {}
        return sendJson(res, 200, {model, profile: modelProfile(model, provider, catalogEntryFor(catalog, model))});
      }

      const activateMatch = pathname.match(/^\/api\/providers\/([^/]+)\/activate$/);
      if (req.method === "POST" && activateMatch) {
        const provider = providerById(config, decodeURIComponent(activateMatch[1]));
        if (!provider) return sendJson(res, 404, {error: {message: "平台不存在"}});
        config.activeProviderId = provider.id;
        writeConfig(config);
        return sendJson(res, 200, publicState(config));
      }

      const deleteMatch = pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]);
        const index = config.providers.findIndex(item => item.id === id);
        if (index < 0) return sendJson(res, 404, {error: {message: "平台不存在"}});
        config.providers.splice(index, 1);
        if (config.activeProviderId === id) config.activeProviderId = config.providers[0]?.id || "";
        writeConfig(config);
        return sendJson(res, 200, publicState(config));
      }

      if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res, config, chatIdleTimeoutMs);
      if (req.method === "GET") return serveStatic(pathname, res);
      return sendJson(res, 405, {error: {message: "不支持的请求方法"}});
    } catch (error) {
      console.error(error);
      return sendJson(res, 400, {error: {message: error.message || "请求失败"}});
    }
  });
  return {server, port, config};
}

export function startServer(options = {}) {
  const host = options.host || process.env.MODELBRIDGE_HOST || process.env.BAILIAN_HOST || "127.0.0.1";
  const app = createAppServer(options);
  app.server.listen(app.port, host, () => {
    console.log(`ModelBridge 已启动：http://${host}:${app.port}`);
    console.log(app.config.providers.length
      ? `已加载 ${app.config.providers.length} 个模型平台，API Key 仅保存在本机。`
      : "尚未配置模型平台，请在浏览器中完成首次设置。");
    console.log("按 Ctrl+C 停止服务。");
  });
  app.server.on("error", error => {
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  });
  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) startServer();
