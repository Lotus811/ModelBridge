# ModelBridge

ModelBridge is a local-first, dependency-free chat client for OpenAI-compatible model APIs. Add an API key and Base URL in the browser, then switch between providers and models from one interface.

## Highlights

- Multiple local provider profiles
- Presets for Alibaba Cloud Model Studio, OpenAI, DeepSeek, OpenRouter, SiliconFlow, and Ollama
- Automatic `/models` discovery with a manual model-list fallback
- Streaming chat, stop generation, reasoning display, and safe Markdown rendering
- One-click dual-format copy: rich text for Word/email, raw Markdown for text editors, plus per-code-block copy
- Automatic retry when a model rejects an unsupported optional parameter
- Stale-backend detection and automatic local-port selection
- Image, PDF, Word (DOCX), text, and code attachments with file picking and drag-and-drop
- Local token dashboard with per-request and cumulative input, output, cached, and total tokens
- Per-model capability profiles merged from provider metadata, built-in rules, name inference, and user overrides
- Bearer, `x-api-key`, `api-key`, custom-header, and keyless authentication
- Secrets stay in the local Node.js backend and are never returned to the browser
- Zero npm dependencies

## Run

Node.js 20 or newer is required.

```bash
node server.mjs
```

Open <http://127.0.0.1:8000>. Windows users can double-click `启动聊天.bat`; macOS/Linux users can run `./start-chat.sh`.

The first launch opens provider setup. Saved credentials live in the git-ignored `config.local.json` file.

## Scope

ModelBridge currently supports the OpenAI Chat Completions protocol. Native Anthropic Messages, Gemini `generateContent`, image, audio, and video APIs require separate adapters and are not represented as compatible when they are not.

Images are sent as Base64 `image_url` content parts and PDFs as `file` content parts. DOCX, text, and code files are read locally and sent as text context, so DOCX does not require native file support from the provider. Paragraphs, table text, headers, footers, and notes are extracted; complex layout, comments, charts, and embedded images are not preserved. Legacy `.doc` files must first be saved as `.docx`. Support for image and PDF inputs still depends on the selected provider and model. Alibaba Cloud's hosted Kimi models accept public image URLs rather than local Base64 images, so the client blocks that unsupported combination. Encoded attachments are capped at 24 MB and the complete request at 31 MB. Attachment bytes remain in page memory and are not persisted after a reload.

## Token usage and model profiles

The token dashboard records API-reported input, output, cached, and total tokens locally in the browser. It does not estimate voucher balance. Alibaba Cloud coupon balances belong to the separate billing API and require an Alibaba Cloud identity plus `bss:DescribeCoupons`; the Model Studio API key cannot query them.

For Alibaba Cloud Model Studio, ModelBridge augments the OpenAI-compatible model list with the official model catalog when available, including modalities, tool support, context limits, and output limits. The capability center lets users override these values per model. Saved overrides immediately affect attachment validation, optional parameter adaptation, and context budgeting.

## Markdown and copy

Assistant messages render headings, emphasis, strikethrough, quotes, ordered/unordered/task lists, tables, links, inline code, and fenced code blocks. Raw HTML is escaped and links are restricted to `http`, `https`, and `mailto`. Streaming updates are coalesced by animation frame to avoid rerendering the full answer for every token.

The message copy action writes both the original Markdown and rendered HTML when the browser supports multi-format clipboard data. Rich-text applications such as Word retain formatting, while text editors receive the Markdown source. Older browsers fall back to plain Markdown. Code blocks also have a dedicated copy action.

## Development

```bash
npm run check
npm test
npm start
```

## Security

Provider settings are written with a temporary file and atomic replacement. Local API routes validate both the loopback Host header and browser Origin. API keys are still stored as plaintext in `config.local.json`; Unix mode `0600` is attempted, but Windows file modes do not provide equivalent owner/group isolation.

The server binds to `127.0.0.1` by default. Do not commit `config.local.json`, `api.txt`, or `.env`. If a key has ever entered Git history, rotate it at the provider rather than relying on `.gitignore`.

## License

[MIT](LICENSE)
