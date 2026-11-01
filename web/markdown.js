const TOKEN_PREFIX = "\u0000MODELBRIDGE";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeLink(rawUrl) {
  const value = String(rawUrl || "").trim();
  try {
    const url = new URL(value, "https://modelbridge.invalid/");
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return "";
    if (url.hostname === "modelbridge.invalid" && !/^(?:https?:|mailto:)/i.test(value)) return "";
    return value;
  } catch {
    return "";
  }
}

function token(index) {
  return `${TOKEN_PREFIX}${index}\u0000`;
}

function restoreTokens(value, tokens) {
  return value.replace(/\u0000MODELBRIDGE(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || "");
}

export function renderInlineMarkdown(source) {
  let value = String(source ?? "");
  const tokens = [];
  const protect = html => {
    const placeholder = token(tokens.length);
    tokens.push(html);
    return placeholder;
  };

  value = value.replace(/(`+)([\s\S]*?[^`])\1(?!`)|(`)([^`\n]*)\3/g, (_match, fence, fencedText, single, singleText) => {
    const text = fencedText ?? singleText ?? "";
    return protect(`<code>${escapeHtml(text.trim())}</code>`);
  });

  value = value.replace(/\[([^\]\n]+)]\((\S+?)(?:\s+["']([^"']*)["'])?\)/g, (_match, label, href, title) => {
    const safe = safeLink(href);
    if (!safe) return `${label}（${href}）`;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return protect(`<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${renderInlineMarkdown(label)}</a>`);
  });

  value = escapeHtml(value);
  value = value
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+?)__/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+?)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, "$1<em>$2</em>");

  return restoreTokens(value, tokens);
}

function splitTableRow(line) {
  let value = String(line).trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|")) value = value.slice(0, -1);
  const cells = [];
  let current = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function tableAlignment(cell) {
  const value = cell.trim();
  if (!/^:?-{3,}:?$/.test(value)) return null;
  if (value.startsWith(":") && value.endsWith(":")) return "center";
  if (value.endsWith(":")) return "right";
  return "left";
}

function isFence(line) {
  return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

function isBlockStart(lines, index) {
  const line = lines[index] || "";
  if (!line.trim()) return true;
  if (isFence(line)) return true;
  if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
  if (/^ {0,3}>\s?/.test(line)) return true;
  if (/^ {0,3}(?:[-*_]\s*){3,}$/.test(line)) return true;
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) return true;
  if (index + 1 < lines.length && line.includes("|") && splitTableRow(lines[index + 1]).every(cell => tableAlignment(cell) !== null)) return true;
  return false;
}

function renderCodeBlock(code, language = "") {
  const safeLanguage = String(language).toLowerCase().replace(/[^a-z0-9_+.-]/g, "").slice(0, 40);
  const label = safeLanguage || "代码";
  return `<div class="markdown-code"><div class="code-toolbar"><span>${escapeHtml(label)}</span><button type="button" data-action="copy-code">复制代码</button></div><pre><code${safeLanguage ? ` class="language-${escapeHtml(safeLanguage)}"` : ""}>${escapeHtml(code)}</code></pre></div>`;
}

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || "";
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      html.push(renderCodeBlock(body.join("\n"), language));
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^ {0,3}(?:[-*_]\s*){3,}$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }

    if (index + 1 < lines.length && line.includes("|")) {
      const headers = splitTableRow(line);
      const alignments = splitTableRow(lines[index + 1]).map(tableAlignment);
      if (headers.length === alignments.length && alignments.every(Boolean)) {
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
          const cells = splitTableRow(lines[index]);
          while (cells.length < headers.length) cells.push("");
          rows.push(cells.slice(0, headers.length));
          index += 1;
        }
        const head = headers.map((cell, cellIndex) => `<th style="text-align:${alignments[cellIndex]}">${renderInlineMarkdown(cell)}</th>`).join("");
        const body = rows.map(row => `<tr>${row.map((cell, cellIndex) => `<td style="text-align:${alignments[cellIndex]}">${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("");
        html.push(`<div class="markdown-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }
    }

    const listMatch = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const tag = ordered ? "ol" : "ul";
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        let text = item[2];
        index += 1;
        while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
          text += `\n${lines[index].trim()}`;
          index += 1;
        }
        const task = text.match(/^\[([ xX])]\s+(.*)$/s);
        if (task) {
          const checked = task[1].toLowerCase() === "x";
          items.push(`<li class="task-item"><input type="checkbox" disabled${checked ? " checked" : ""}> <span>${renderInlineMarkdown(task[2]).replace(/\n/g, "<br>")}</span></li>`);
        } else {
          items.push(`<li>${renderInlineMarkdown(text).replace(/\n/g, "<br>")}</li>`);
        }
      }
      html.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join("<br>\n")}</p>`);
  }

  return html.join("\n");
}

export function renderMarkdownInto(element, markdown) {
  element.innerHTML = renderMarkdown(markdown);
  return element;
}
