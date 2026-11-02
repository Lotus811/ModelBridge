const MAX_DIAGNOSTIC_TEXT = 1_000;

function asDiagnosticText(value) {
  return typeof value === "string" ? value.slice(0, MAX_DIAGNOSTIC_TEXT) : "";
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    if (url.search) url.search = "?…";
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function redactDiagnosticText(value, secrets = []) {
  let text = String(value || "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) text = text.split(secret).join("***");
  }
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{4,}/gi, "Bearer ***")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}/gi, "***")
    .replace(/https?:\/\/[^\s<>'\"]+/gi, redactUrl);
  return text.slice(0, MAX_DIAGNOSTIC_TEXT);
}

export function diagnosticSecrets(provider = {}) {
  return [
    provider.apiKey,
    ...Object.values(provider.extraHeaders || {})
  ].filter(value => typeof value === "string" && value.length >= 4);
}

export function diagnosticCheck(id, status, summary, options = {}) {
  const allowedStatuses = new Set(["pass", "warning", "fail", "needs_input", "unknown", "skipped"]);
  return {
    id: asDiagnosticText(id),
    status: allowedStatuses.has(status) ? status : "unknown",
    summary: asDiagnosticText(summary),
    ...(options.detail ? {detail: asDiagnosticText(options.detail)} : {}),
    ...(options.suggestion ? {suggestion: asDiagnosticText(options.suggestion)} : {}),
    ...(Number.isFinite(options.durationMs) ? {durationMs: Math.max(0, Math.round(options.durationMs))} : {})
  };
}

export function diagnosticOverall(checks) {
  if (checks.some(check => check.status === "fail")) return "fail";
  if (checks.some(check => check.status === "needs_input")) return "needs_input";
  if (checks.some(check => ["warning", "unknown"].includes(check.status))) return "partial";
  return "pass";
}

function errorCode(error) {
  return String(error?.code || error?.cause?.code || "").toUpperCase();
}

export function classifyDiagnosticError(error, stage = "connection", secrets = []) {
  const status = Number(error?.status);
  const code = errorCode(error);
  const detail = redactDiagnosticText(error?.message || "未知错误", secrets);
  const result = {status: "fail", detail};

  if (status === 401) return {...result, code: "authentication", summary: "认证失败", suggestion: "检查 API Key、认证方式以及 Base URL 是否属于同一平台或区域"};
  if (status === 402) return {...result, code: "quota", summary: "账户余额或额度不足", suggestion: "前往平台控制台检查余额、套餐或调用额度"};
  if (status === 403) return {...result, code: "permission", summary: "当前密钥没有访问权限", suggestion: "检查模型授权、工作空间、区域或套餐限制"};
  if (status === 404) return {...result, code: "not_found", summary: stage === "models" ? "平台没有提供标准模型列表" : "接口路径或模型不存在", suggestion: stage === "models" ? "改用手动模型 ID；这不代表聊天接口不可用" : "检查 Base URL、接口路径和模型 ID"};
  if (status === 405) return {...result, code: "method_not_allowed", summary: "接口不接受当前请求方法", suggestion: "检查是否填写了 API 根地址而不是控制台或单个页面地址"};
  if (status === 429) return {...result, code: "rate_limit", summary: "请求过于频繁或已触发额度限制", suggestion: "稍后重试，或检查平台并发与速率限制"};
  if (status >= 500) return {...result, code: "upstream", summary: "模型平台暂时不可用", suggestion: "稍后重试；若持续失败，请查看平台状态页"};
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return {...result, code: "dns", summary: "无法解析平台域名", suggestion: "检查 Base URL 拼写、DNS 和网络连接"};
  if (["ECONNREFUSED", "UND_ERR_SOCKET"].includes(code)) return {...result, code: "connection_refused", summary: "目标地址拒绝连接", suggestion: "确认服务已启动，主机和端口正确"};
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code) || /certificate|tls|ssl/i.test(detail)) return {...result, code: "tls", summary: "TLS 或证书验证失败", suggestion: "使用有效 HTTPS 证书；本机模型请使用 localhost 或 127.0.0.1"};
  if (["ABORT_ERR", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"].includes(code) || /timeout|超时/i.test(detail)) return {...result, code: "timeout", summary: "连接或响应超时", suggestion: "检查网络、代理和平台状态后重试"};
  if (/valid json|有效 json|返回格式|html/i.test(detail)) return {...result, code: "format", summary: "返回格式不是兼容 API 数据", suggestion: "确认填写的是 API Base URL，而不是平台控制台网页地址"};
  return {...result, code: code.toLowerCase() || "unknown", summary: stage === "models" ? "模型列表读取失败" : "平台连接失败", suggestion: "检查地址、认证配置和平台返回的错误详情"};
}

export function buildDiagnosticReport({provider, checks, observed = {}, startedAt, finishedAt = new Date().toISOString()}) {
  const secrets = diagnosticSecrets(provider);
  const safeChecks = (Array.isArray(checks) ? checks : []).slice(0, 20).map(check => ({
    ...check,
    id: redactDiagnosticText(check.id, secrets),
    summary: redactDiagnosticText(check.summary, secrets),
    ...(check.detail ? {detail: redactDiagnosticText(check.detail, secrets)} : {}),
    ...(check.suggestion ? {suggestion: redactDiagnosticText(check.suggestion, secrets)} : {})
  }));
  return {
    version: 1,
    overall: diagnosticOverall(safeChecks),
    protocol: "openai-chat-completions",
    provider: {
      name: redactDiagnosticText(asDiagnosticText(provider?.name), secrets),
      presetId: asDiagnosticText(provider?.presetId),
      baseUrl: redactDiagnosticText(provider?.baseUrl, secrets)
    },
    startedAt,
    finishedAt,
    checks: safeChecks,
    observed: {
      ...(typeof observed.modelSource === "string" ? {modelSource: observed.modelSource} : {}),
      ...(typeof observed.testedModel === "string" ? {testedModel: redactDiagnosticText(observed.testedModel.slice(0, 300), secrets)} : {}),
      ...(typeof observed.streaming === "boolean" ? {streaming: observed.streaming} : {}),
      ...(typeof observed.usageAvailable === "boolean" ? {usageAvailable: observed.usageAvailable} : {}),
      ...(typeof observed.outputTokenParameter === "string" ? {outputTokenParameter: redactDiagnosticText(observed.outputTokenParameter, secrets)} : {}),
      ...(Array.isArray(observed.rejectedParameters) ? {rejectedParameters: observed.rejectedParameters.slice(0, 10).map(value => redactDiagnosticText(value, secrets))} : {}),
      ...(Number.isInteger(observed.modelCount) ? {modelCount: Math.max(0, observed.modelCount)} : {})
    }
  };
}
