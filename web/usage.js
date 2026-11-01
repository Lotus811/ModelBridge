export function normalizeUsage(usage) {
  const inputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0;
  const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? 0) || 0;
  const reportedTotal = Number(usage?.total_tokens);
  return {
    inputTokens: Math.max(0, inputTokens),
    outputTokens: Math.max(0, outputTokens),
    cachedTokens: Math.max(0, cachedTokens),
    totalTokens: Number.isFinite(reportedTotal) && reportedTotal >= 0 ? reportedTotal : Math.max(0, inputTokens) + Math.max(0, outputTokens)
  };
}

export function summarizeUsage(events, today = "") {
  const summary = {requests: 0, missing: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, todayTokens: 0};
  for (const event of Array.isArray(events) ? events : []) {
    summary.requests += 1;
    if (event.usageAvailable === false) summary.missing += 1;
    const input = Math.max(0, Number(event.inputTokens) || 0);
    const output = Math.max(0, Number(event.outputTokens) || 0);
    const cached = Math.max(0, Number(event.cachedTokens) || 0);
    const total = Math.max(0, Number(event.totalTokens) || input + output);
    summary.inputTokens += input;
    summary.outputTokens += output;
    summary.cachedTokens += cached;
    summary.totalTokens += total;
    if (today && String(event.day || event.at || "").slice(0, 10) === today) summary.todayTokens += total;
  }
  return summary;
}
