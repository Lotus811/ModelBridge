import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, "config.local.json");
const LEGACY_CONFIG_PATH = path.join(ROOT, "api.txt");
const APP_VERSION = "1.7.0";
const CONFIG_VERSION = 1;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_CONTEXT_TEXT_CHARS = 240_000;
const OPTIONAL_CHAT_PARAMETERS = Object.freeze(["temperature", "top_p", "max_tokens", "reasoning_effort", "stream_options"]);
const modelCompatibilityCache = new Map();
const modelCatalogCache = new Map();
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;

export const PROVIDER_PRESETS = Object.freeze([
  {
    id: "aliyun-bailian",
    name: "阿里云百炼",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "工作空间专属地址可直接覆盖此地址"
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "标准 OpenAI Chat Completions 接口"
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "DeepSeek 官方 OpenAI 兼容接口"
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "一个 Key 使用多个模型供应商"
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "SiliconFlow 中国站"
  },
  {
    id: "ollama",
    name: "Ollama（本机）",
    baseUrl: "http://127.0.0.1:11434/v1",
    authMode: "none",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "本机 Ollama，无需 API Key"
  },
  {
    id: "custom",
    name: "自定义 OpenAI 兼容接口",
    baseUrl: "",
    authMode: "bearer",
    modelsPath: "/models",
    chatPath: "/chat/completions",
    hint: "适用于其他 OpenAI-compatible 平台"
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

export function unsupportedOptionalParameter(message, payload = {}) {
  const text = String(message || "").toLowerCase();
  const rejected = /not supported|unsupported|does not support|unknown parameter|unrecognized parameter|not allowed|invalid value|must be|only (?:supports?|accepts?)|不支持|未知参数|无效参数|必须为|仅支持|只能/.test(text);
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

async function remoteFetch(provider, endpointPath, options = {}) {
  return fetch(endpointUrl(provider, endpointPath), {
    ...options,
    headers: {...buildHeaders(provider), ...(options.headers || {})},
    signal: options.signal || AbortSignal.timeout(300_000)
  });
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

async function readRemoteError(response, provider) {
  const raw = (await response.text().catch(() => "")).slice(0, 4000);
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
  return new Error(`${friendly}（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
}

async function fetchRemoteModels(provider) {
  const response = await remoteFetch(provider, provider.modelsPath, {method: "GET", signal: AbortSignal.timeout(30_000)});
  if (!response.ok) throw await readRemoteError(response, provider);
  const data = await response.json().catch(() => ({}));
  const ids = extractModelIds(data);
  if (!ids.length) throw new Error("平台返回了空模型列表；可以改用手动模型模式");
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

  const entries = [];
  for (let pageNo = 1; pageNo <= 10; pageNo += 1) {
    const response = await fetch(aliyunCatalogUrl(provider, pageNo), {
      method: "GET",
      headers: buildHeaders(provider),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw await readRemoteError(response, provider);
    const data = await response.json().catch(() => ({}));
    const page = Array.isArray(data?.output?.models) ? data.output.models : [];
    entries.push(...page);
    const total = Number(data?.output?.total || entries.length);
    if (!page.length || entries.length >= total) break;
  }

  const models = new Map();
  for (const entry of entries) {
    const id = asText(entry.model || entry.id || entry.name, 300);
    if (!id) continue;
    models.set(id.toLowerCase(), entry);
    models.set(id.toLowerCase().split("/").at(-1), entry);
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
    try {
      ids = await fetchRemoteModels(provider);
      source = "remote";
    } catch (error) {
      if (!provider.manualModels.length) throw error;
      ids = provider.manualModels;
      source = "fallback";
      warning = `自动读取失败，已使用备用列表：${error.message}`;
    }
  }
  let catalog = new Map();
  try { catalog = await fetchAliyunModelCatalog(provider); }
  catch (error) { warning = [warning, `能力与价格目录读取失败，已使用内置规则：${error.message}`].filter(Boolean).join("；"); }
  return {ids, source, warning, catalog};
}

async function probeProvider(provider) {
  const ids = provider.modelsMode === "auto" ? await fetchRemoteModels(provider) : provider.manualModels;
  const model = provider.defaultModel || ids.find(id => modelCapabilities(id, provider).chat) || ids[0];
  if (!model) throw new Error("没有可以用于实际调用测试的模型");
  const probeMaxTokens = effectiveMaxTokens(model, modelProfile(model, provider), isKimiK3ReasoningModel(model) ? 64 : 16);
  const payload = {
    model,
    messages: [{role: "user", content: "Reply with OK."}],
    max_tokens: probeMaxTokens,
    stream: true
  };
  if (isKimiK3ReasoningModel(model)) payload.reasoning_effort = "max";
  const response = await remoteFetch(provider, provider.chatPath, {
    method: "POST",
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw await readRemoteError(response, provider);
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const raw = (await response.text()).slice(0, 200_000);
    const validChunk = raw.split(/\r?\n/).some(line => {
      if (!line.startsWith("data:")) return false;
      const value = line.slice(5).trim();
      if (!value || value === "[DONE]") return false;
      try { return Array.isArray(JSON.parse(value)?.choices); }
      catch { return false; }
    });
    if (!validChunk) throw new Error("平台已响应，但流式返回格式不是 OpenAI Chat Completions SSE");
  } else {
    const data = await response.json().catch(() => ({}));
    if (!data?.choices?.length) throw new Error("平台已响应，但返回格式不是 OpenAI Chat Completions");
  }
  return {
    ok: true,
    method: "chat",
    count: ids.length,
    testedModel: model,
    message: `连接成功：读取到 ${ids.length} 个模型，并已实际调用 ${model}`
  };
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

async function handleChat(req, res, config) {
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

  const payload = {model, messages, stream: true};
  if (typeof data.temperature === "number") payload.temperature = Math.max(0, Math.min(2, data.temperature));
  if (typeof data.top_p === "number") payload.top_p = Math.max(0, Math.min(1, data.top_p));
  if (Number.isInteger(data.max_tokens)) payload.max_tokens = adaptedMaxTokens;
  if (["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(data.reasoning_effort)) payload.reasoning_effort = data.reasoning_effort;
  if (["aliyun-bailian", "openai", "deepseek", "openrouter", "siliconflow"].includes(provider.presetId)) {
    payload.stream_options = {include_usage: true};
  }

  const omittedParameters = [];
  const adaptedParameters = [];
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
  const cachedUnsupported = modelCompatibilityCache.get(compatibilityKey(provider, model)) || new Set();
  for (const parameter of cachedUnsupported) {
    if (Object.prototype.hasOwnProperty.call(payload, parameter)) {
      delete payload[parameter];
      omittedParameters.push(parameter);
    }
  }

  const upstreamController = new AbortController();
  let timedOut = false;
  const abortUpstream = () => {
    if (!upstreamController.signal.aborted) upstreamController.abort();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  const timeout = setTimeout(() => {
    timedOut = true;
    abortUpstream();
  }, 300_000);

  let response;
  for (let attempt = 0; attempt <= OPTIONAL_CHAT_PARAMETERS.length; attempt += 1) {
    try {
      response = await remoteFetch(provider, provider.chatPath, {
        method: "POST",
        body: JSON.stringify(payload),
        signal: upstreamController.signal
      });
    } catch (error) {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
      if (res.destroyed || upstreamController.signal.aborted && !timedOut) return;
      return sendJson(res, timedOut ? 504 : 502, {error: {message: timedOut ? "模型响应超时（5 分钟）" : `无法连接模型平台：${error.message}`}});
    }
    if (response.ok) break;

    const status = response.status;
    const error = await readRemoteError(response, provider);
    const unsupported = [400, 422].includes(status) ? unsupportedOptionalParameter(error.message, payload) : "";
    if (!unsupported) {
      clearTimeout(timeout);
      req.off("aborted", abortUpstream);
      return sendJson(res, status, {error: {message: error.message}});
    }

    delete payload[unsupported];
    rememberUnsupportedParameter(provider, model, unsupported);
    omittedParameters.push(unsupported);
  }

  if (!response?.ok) {
    clearTimeout(timeout);
    req.off("aborted", abortUpstream);
    return sendJson(res, 400, {error: {message: "模型不接受当前可选参数，自动兼容重试仍未成功"}});
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
      const raw = await response.text();
      const payload = JSON.parse(raw);
      await writeResponseChunk(res, `data: ${JSON.stringify(payload)}\n\n`);
      if (!res.destroyed) res.end("data: [DONE]\n\n");
    } catch (error) {
      if (!res.destroyed) {
        const message = timedOut ? "模型响应超时（5 分钟）" : error.message;
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
      if (!await writeResponseChunk(res, value)) break;
    }
  } catch (error) {
    if (!res.destroyed && (timedOut || !upstreamController.signal.aborted)) {
      const message = timedOut ? "模型响应超时（5 分钟）" : error.message;
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
        return sendJson(res, 200, await probeProvider(provider));
      }

      if (req.method === "POST" && pathname === "/api/providers") {
        const data = await readJson(req);
        const existing = data.id ? providerById(config, data.id) : null;
        if (data.id && !existing) return sendJson(res, 404, {error: {message: "要编辑的平台不存在"}});
        if (!existing && config.providers.length >= 30) return sendJson(res, 400, {error: {message: "最多保存 30 个平台"}});
        const provider = normalizeProvider(data, existing);
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

      if (req.method === "POST" && pathname === "/api/chat") return handleChat(req, res, config);
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
