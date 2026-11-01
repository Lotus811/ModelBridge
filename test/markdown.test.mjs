import test from "node:test";
import assert from "node:assert/strict";
import {renderMarkdown} from "../web/markdown.js";

test("renders common chat markdown blocks", () => {
  const html = renderMarkdown(`# 标题

这是 **重点** 和 \`inline\`。

- 第一项
- 第二项

| 模型 | 状态 |
| :--- | ---: |
| Kimi | 可用 |

\`\`\`js
console.log("ok")
\`\`\``);

  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>重点<\/strong>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(html, /<table>/);
  assert.match(html, /data-action="copy-code"/);
  assert.match(html, /console\.log\(&quot;ok&quot;\)/);
});

test("escapes raw HTML and blocks unsafe markdown links", () => {
  const html = renderMarkdown(`<img src=x onerror=alert(1)>

[危险](javascript:alert(1))

[安全](https://example.com?q=1&x=2)`);

  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.match(html, /href="https:\/\/example\.com\?q=1&amp;x=2"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("renders blockquotes, task lists, and strikethrough", () => {
  const html = renderMarkdown(`> 引用内容

- [x] 已完成
- [ ] 待处理

~~旧内容~~`);

  assert.match(html, /<blockquote>/);
  assert.match(html, /type="checkbox" disabled checked/);
  assert.match(html, /type="checkbox" disabled/);
  assert.match(html, /<del>旧内容<\/del>/);
});
