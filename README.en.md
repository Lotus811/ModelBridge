# ModelBridge

ModelBridge is a local-first, dependency-free chat client for OpenAI-compatible model APIs. Add an API key and Base URL in the browser, then switch between providers and models from one interface.

## Highlights

- Multiple local provider profiles
- Presets for Alibaba Cloud Model Studio, OpenAI, DeepSeek, OpenRouter, SiliconFlow, the Gemini/Claude compatibility layers, and Ollama
- A three-step onboarding flow with a real minimal chat probe before saving
- Separate conversation/model sidebar views, editable prompt starters, mobile drawer navigation, and keyboard focus management
- Structured diagnostics for authentication, quota, networking, model discovery, streaming, token-limit parameters, and usage reporting
- Automatic `/models` discovery with a manual model-list fallback
- Standards-compliant SSE streaming, stop-button or `Esc` cancellation, reasoning display, and safe Markdown rendering
- One-click dual-format copy: rich text for Word/email, raw Markdown for text editors, plus per-code-block copy
- Conversation export to JSON/Markdown and message restore from ModelBridge JSON backups
- IndexedDB multi-conversation history with search, rename, pin, delete, and one-time migration from the legacy single conversation
- Automatic retry when a model rejects an unsupported optional parameter
- Automatic compatibility between modern `max_completion_tokens` and common `max_tokens` endpoints
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

With a built-in preset, beginners only need to paste the API key; ModelBridge configures the Base URL, authentication, and model discovery. Advanced fields remain available on demand, together with a one-click reset to the recommended configuration. In particular, the DeepSeek preset uses `https://api.deepseek.com`; its `/anthropic` URL is for the Anthropic Messages protocol and is rejected with a specific explanation here.

## Scope

ModelBridge currently supports the OpenAI Chat Completions protocol. The official Gemini and Claude OpenAI compatibility layers work for core chat, subject to each vendor's documented limitations. Native Anthropic Messages, Gemini `generateContent`, image, audio, and video APIs still require separate adapters and are not represented as compatible when they are not.

Images are sent as Base64 `image_url` content parts and PDFs as `file` content parts. DOCX, text, and code files are read locally and sent as text context, so DOCX does not require native file support from the provider. Paragraphs, table text, headers, footers, and notes are extracted; complex layout, comments, charts, and embedded images are not preserved. Legacy `.doc` files must first be saved as `.docx`. Support for image and PDF inputs still depends on the selected provider and model. Alibaba Cloud's hosted Kimi models accept public image URLs rather than local Base64 images, so the client blocks that unsupported combination. Encoded attachments are capped at 24 MB and the complete request at 31 MB. Attachment bytes remain in page memory and are not persisted after a reload.

## Token usage and model profiles

The token dashboard records API-reported input, output, cached, and total tokens locally in the browser. It does not estimate voucher balance. Alibaba Cloud coupon balances belong to the separate billing API and require an Alibaba Cloud identity plus `bss:DescribeCoupons`; the Model Studio API key cannot query them.

For Alibaba Cloud Model Studio, ModelBridge augments the OpenAI-compatible model list with the official model catalog when available, including modalities, tool support, context limits, and output limits. The capability center lets users override these values per model. Saved overrides immediately affect attachment validation, optional parameter adaptation, and context budgeting.

## Markdown and copy

Assistant messages render headings, emphasis, strikethrough, quotes, ordered/unordered/task lists, tables, links, inline code, and fenced code blocks. Raw HTML is escaped and links are restricted to `http`, `https`, and `mailto`. Streaming updates are coalesced by animation frame to avoid rerendering the full answer for every token.

The message copy action writes both the original Markdown and rendered HTML when the browser supports multi-format clipboard data. Rich-text applications such as Word retain formatting, while text editors receive the Markdown source. Older browsers fall back to plain Markdown. Code blocks also have a dedicated copy action.

## Streaming, local history, and conversation backups

The streaming parser follows SSE event framing and handles arbitrary network chunk boundaries, BOMs, comments, `CR`/`LF`/`CRLF` line endings, and multiline `data` fields. While generation is active, use the stop button or press `Esc` when no modal is open; the browser aborts the upstream request and keeps content already received.

Non-empty conversations are stored in the current browser's IndexedDB. The sidebar can search, rename, pin, and delete them, and the legacy `localStorage` conversation is migrated once. If IndexedDB is unavailable, ModelBridge falls back to the original single-conversation storage path. History never enters the backend configuration or leaves the browser.

The “Conversation data” controls export a restorable JSON backup or a readable Markdown transcript. Importing JSON creates a new local conversation. Exports contain conversation text, provider/model identifiers, selected generation metadata, and attachment metadata only; they **never contain API keys, extra request headers, or image/PDF attachment bytes**. Reattach the original files if a restored conversation needs them again.

## Development

Click the model name in the header to switch models. Starter cards fill an editable prompt before sending. Provider setup includes progress and cancellation, while technical diagnostic details and generation settings are collapsed by default.

```bash
npm run check
npm test
npm start
```

Optional browser acceptance: with Playwright and a browser installed, run `npm run test:ui`. `PLAYWRIGHT_MODULE` can point to an existing Playwright `index.mjs`, and `BROWSER_EXECUTABLE` can specify a browser executable. It uses mocked APIs only and writes screenshots to the ignored `.ui-artifacts/` directory.

## Security

Provider settings are written with a temporary file and atomic replacement. Local API routes validate both the loopback Host header and browser Origin. Remote providers require HTTPS unless they use a loopback host; upstream redirects are rejected so credentials do not follow a redirect. Model-list, error, probe, and non-stream response bodies are bounded, and an idle chat stream is aborted after five minutes.

A custom Base URL is an operator-controlled trust boundary: the backend will contact a saved HTTPS endpoint that is reachable from the machine, and it does not provide a general DNS/IP sandbox. Add only providers you trust and do not let untrusted users edit provider settings. API keys are still stored as plaintext in `config.local.json`; Unix mode `0600` is attempted, but Windows file modes do not provide equivalent owner/group isolation.

The server binds to `127.0.0.1` by default. Do not commit `config.local.json`, `api.txt`, or `.env`. If a key has ever entered Git history, rotate it at the provider rather than relying on `.gitignore`.

After the first GitHub push, enable [Secret Scanning and Push Protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning), [CodeQL default setup](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning), and a [`main` branch protection rule or ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches) that requires CI and blocks force pushes.

## License

[MIT](LICENSE)
