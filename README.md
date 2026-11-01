# ModelBridge

一个本地优先、零第三方依赖的多平台 AI API 聊天客户端。把 API Key、Base URL 和模型 ID 填进网页，就能用统一界面聊天、切换平台和切换模型。

> ModelBridge 当前面向 **OpenAI Chat Completions 兼容接口**。原生 Anthropic Messages API、Gemini `generateContent` 以及图像/语音生成接口需要独立适配器，不能仅靠更换 URL 接入。

[English](README.en.md)

## 功能

- 多平台管理：同时保存多个 API 平台并快速切换
- 内置预设：阿里云百炼、OpenAI、DeepSeek、OpenRouter、硅基流动、Ollama
- 自定义 OpenAI-compatible Base URL
- 支持 Bearer、`x-api-key`、`api-key`、自定义认证头和无认证模式
- 自动读取 `/models`，也可手动维护模型 ID
- 流式聊天、停止生成、推理内容折叠、安全 Markdown 渲染
- 一键复制回答：Word/邮件保留富文本格式，文本编辑器保留原始 Markdown；代码块可单独复制
- 图片、PDF、Word（DOCX）、文本和代码附件，支持选择文件与拖放
- 系统提示词、温度、Top P、最大 Token 和推理强度设置
- 模型拒绝不支持的可选参数时自动兼容重试，并记住该模型的限制
- Token 用量统计：记录每次及累计输入、输出、缓存和总 Token
- 模型能力自动适配中心：合并平台目录、内置规则、名称推断和用户覆盖
- 自动识别旧版后台与端口占用，避免浏览器误连过期进程
- 对话记录只保存在当前浏览器
- API Key 只保存在本机后端，不进入浏览器状态或前端代码
- 自动迁移旧版 `api.txt`
- Windows 一键启动，macOS/Linux 启动脚本
- 不依赖 npm 包，不需要执行 `npm install`

## 快速开始

### Windows

安装 [Node.js 20+](https://nodejs.org/)，然后双击：

```text
启动聊天.bat
```

### macOS / Linux

```bash
chmod +x start-chat.sh
./start-chat.sh
```

也可以在所有平台直接运行：

```bash
node server.mjs
```

浏览器打开 <http://127.0.0.1:8000>，在首次设置页面中选择平台、填写 Base URL 和 API Key，然后点击“测试连接”或“保存并使用”。

如果 8000 端口被旧版 ModelBridge 占用，一键启动器会自动选择 8001–8010 中的空闲端口并打开正确版本。确认新版正常后，可以关闭旧的命令行窗口。

## 平台兼容性

| 类型 | 支持情况 | 说明 |
|---|---|---|
| OpenAI Chat Completions 兼容 API | 支持 | 使用 `/models` 与 `/chat/completions` |
| 不提供 `/models` 的兼容 API | 支持 | 选择“手动填写模型” |
| Azure 风格兼容端点 | 部分支持 | 在高级设置中填写自定义路径和 `api-key` 认证 |
| Ollama 本地服务 | 支持 | 默认地址 `http://127.0.0.1:11434/v1` |
| 原生 Anthropic Messages API | 暂不支持 | 请求体和流式事件格式不同 |
| 原生 Gemini API | 暂不支持 | 请求与响应协议不同 |
| 图片输入 | 支持 | 使用 OpenAI-compatible `image_url`，需要视觉模型 |
| PDF 输入 | 部分支持 | 使用 Chat Completions `file_data`，取决于平台与模型 |
| Word（DOCX）输入 | 支持 | 浏览器本地提取文字后作为文本上下文发送 |
| 文本和代码附件 | 支持 | 本地读取后作为文本上下文发送 |
| 图像生成、语音、视频、Embedding API | 暂不支持 | 这些是独立的生成/向量接口 |

官方兼容性参考：

- [阿里云百炼 Base URL](https://help.aliyun.com/en/model-studio/base-url)
- [DeepSeek API](https://api-docs.deepseek.com/en/)
- [OpenRouter](https://openrouter.ai/developers)
- [硅基流动快速上手](https://docs.siliconflow.cn/docs/userguide/quickstart)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

## 附件

| 附件 | 限制 | 发送方式 |
|---|---:|---|
| PNG、JPEG、WEBP、GIF | 单个 5 MB | Base64 `image_url` 内容部分 |
| PDF | 单个 8 MB | Base64 `file` 内容部分 |
| Word（`.docx`） | 单个 8 MB | 浏览器本地解压并提取文字，作为 `text` 内容发送 |
| 文本、Markdown、JSON、CSV、代码和配置文件 | 单个 512 KB | 读取后拼入 `text` 内容 |

每条消息最多添加 5 个附件，附件编码后的总量不超过 24 MB，请求整体不超过 31 MB。图片和 PDF 是否可用取决于所选模型；普通文本模型可能拒绝多模态内容。DOCX 会在本机浏览器中提取段落、表格文字、页眉页脚和脚注，因此普通文本模型也能读取；复杂排版、批注、图表及文档内嵌图片不会保留。旧版二进制 `.doc` 不支持，请先在 Word/WPS 中另存为 `.docx`。

阿里云百炼直供 Kimi 的图片接口只接受公网 HTTPS URL，不接受本机图片转换出的 Base64 数据，因此 ModelBridge 会阻止向该接口直接上传本机图片。PDF 输入也会按模型能力提示或阻止，避免把“OpenAI 兼容”误解为所有文件能力都相同。

根据 [OpenAI 官方文件输入说明](https://developers.openai.com/api/docs/guides/file-inputs)，Chat Completions 的通用文件内容只覆盖 PDF，DOCX 及其他文本/代码文件由本应用读取后作为文字发送。

附件内容只在当前页面会话的内存中保留，不写入 `config.local.json`。刷新页面后仍会看到附件名称，但附件本体不再参与后续上下文；如需继续分析，请重新添加。

## Token 用量统计

顶部“Token”按钮显示当前浏览器累计记录的 Token。每次请求结束后，ModelBridge 读取 API 返回的输入、输出、缓存和总 Token，并展示累计用量、今日用量及最近请求。历史只保存在当前浏览器的 `localStorage` 中，不会上传或修改阿里云控制台数据。

阿里云 OpenAI 兼容流需要 `stream_options={"include_usage":true}` 才会在最后一个数据块返回用量，ModelBridge 会自动请求并在模型不支持时回退。详情参见[阿里云流式输出](https://help.aliyun.com/zh/model-studio/stream)。模型 API 不返回学生券余额；代金券属于费用与成本接口，需要单独的阿里云身份与 `bss:DescribeCoupons` 权限，因此本项目不根据 Token 猜测余额。真实余额请在阿里云控制台查看，也可参考官方的 [QueryCashCoupons](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querycashcoupons) 接口说明。

## 模型能力自动适配

“◇”按钮打开当前模型档案。阿里云百炼平台会优先读取[官方模型目录](https://help.aliyun.com/zh/model-studio/list-models)中的输入模态、工具调用、上下文长度和最大输出，再与内置规则及模型名称推断合并。其他兼容平台使用保守推断；可逐模型覆盖图片、PDF、工具调用、思考模式、仅流式调用、采样参数、上下文和输出限制。

保存后的用户档案优先级最高，并立即参与发送前附件校验、参数修正和上下文裁剪；“恢复自动识别”会删除该模型的用户覆盖。

## Markdown 与复制

助手回答会在浏览器中渲染标题、粗体、斜体、删除线、引用、有序/无序/任务列表、表格、链接、行内代码和围栏代码块。流式生成时按浏览器绘制帧合并更新，避免每个 Token 都触发一次完整页面重排。模型返回的原始 HTML 一律转义，链接只允许 `http`、`https` 和 `mailto`，避免回答内容在本机页面中执行脚本。

每条消息右上角的“复制”按钮始终可见。复制助手回答时，剪贴板会同时写入原始 Markdown 和渲染后的 HTML：粘贴到 Word、邮件等富文本软件时保留标题、列表和表格；粘贴到记事本、VS Code、Obsidian 等纯文本编辑器时得到原始 Markdown。每个代码块右上角还提供“复制代码”。不支持多格式剪贴板的旧浏览器会自动回退为复制原始 Markdown。

## 本地配置

网页保存的平台配置位于：

```text
config.local.json
```

这个文件包含 API Key，已在 `.gitignore` 中排除。仓库中的 `config.example.json` 只用于展示格式，不应填入真实 Key 后提交。

旧版项目中的 `api.txt` 会在首次启动时自动迁移到 `config.local.json`，原文件不会被删除。确认迁移成功后，可以自行安全删除旧文件。

也可以使用环境变量启动一个临时配置：

```powershell
$env:AI_PROVIDER_NAME = "My API"
$env:AI_BASE_URL = "https://example.com/v1"
$env:AI_API_KEY = "your-key"
$env:AI_MODEL = "model-id"       # 可选；填写后使用手动模型模式
node server.mjs
```

无认证的本地服务可以设置：

```powershell
$env:AI_AUTH_MODE = "none"
```

## 安全设计

- 服务默认只监听 `127.0.0.1`，不会暴露到局域网或公网。
- API Key 不通过 `/api/state` 返回给浏览器；界面只能看到末四位提示。
- 附件由浏览器读取，并通过本机后端直接发送到当前所选模型平台，不会写入项目目录。
- 远程 Base URL 强制使用 HTTPS；HTTP 只允许 localhost。
- 本机配置通过临时文件与原子替换写入 `config.local.json`，降低断电或多进程写入导致配置损坏的风险。
- 后端校验本机 Host 与 Origin，拒绝其他网站通过本机接口读取或修改配置。
- 附加请求头不能覆盖认证头、Cookie、Host 或 Content-Length。

`config.local.json` 中的 API Key 仍是本机明文数据。Unix 系统会尝试设置 `0600`；Windows 的 Node.js 文件权限不能完整区分所有者、组和其他用户，因此不要把本机账户共享给不受信任的人。请勿把 `config.local.json`、`api.txt` 或 `.env` 提交到 Git。如果密钥曾经进入 Git 历史，仅添加 `.gitignore` 并不能移除它，应立即去平台控制台轮换密钥。

为避免长论文和多轮对话超过模型上下文，后端会保留系统提示、最近消息及最新问题，并在文本上下文超过安全预算时省略较早内容；界面会明确提示发生了截断。

如果把本项目部署到公网，不能继续使用当前的本地信任模型；必须增加登录、用户隔离、加密密钥存储、限流和账单保护。

## 开发

项目只使用 Node.js 标准库和原生 HTML/CSS/JavaScript：

```bash
npm run check
npm test
npm start
```

目录结构：

```text
.
├── server.mjs             # 本地 HTTP 服务、配置管理和 API 代理
├── scripts/
│   ├── check-runtime.mjs   # 检查 Node.js 运行时版本
│   └── choose-port.mjs     # 识别当前版本并选择可用本机端口
├── web/
│   ├── index.html         # 应用页面
│   ├── styles.css         # 响应式界面
│   ├── docx.js            # DOCX 本地解压与文字提取
│   ├── usage.js           # Token 用量标准化与汇总
│   ├── markdown.js        # 安全 Markdown 渲染
│   └── app.js             # 前端状态、配置与聊天逻辑
├── test/                  # 配置、安全与 DOCX 解析测试
├── config.example.json    # 无真实密钥的配置示例
├── 启动聊天.bat           # Windows 启动器
└── start-chat.sh          # macOS/Linux 启动器
```

### 自定义端口

```powershell
$env:MODELBRIDGE_PORT = "9000"
node server.mjs
```

## GitHub 发布前检查

```bash
npm run check
npm test
git status --short
git check-ignore api.txt config.local.json
```

确保输出中没有真实 Key。建议启用 GitHub Secret Scanning，并在仓库说明中明确要求用户使用自己的 API Key。

## License

[MIT](LICENSE)
