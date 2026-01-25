# Copilot OpenRoute

**Expose GitHub Copilot Models as OpenAI-Compatible Endpoints.**

> 🔀 **Total Conversion Fork of [antigravity-copilot](https://github.com/pmanalan/antigravity-copilot)**: A ground-up rewrite using the official `@github/copilot-sdk`, replacing the legacy CLIProxyAPI architecture with a modern, SDK-native gateway.

---

## 🎯 What Is This?

Copilot OpenRoute is a VS Code extension that runs a local HTTP server, translating OpenAI-compatible API requests into GitHub Copilot SDK calls. This allows you to use premium Copilot models (Claude Sonnet 4, GPT-4.1, Gemini 2.5 Pro, o3, etc.) in **any tool** that supports OpenAI endpoints:

- **RooCode** / **Cline** / **Continue**
- **OpenCode** (Terminal Agent)
- **curl** / **httpie** / Custom Scripts
- Any IDE or CLI with OpenAI API support

---

## 🌟 Key Features

| Feature                           | Description                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **🔗 OpenAI-Compatible API**      | Standard `/v1/chat/completions` and `/v1/models` endpoints. Drop-in replacement for OpenAI.                  |
| **🔧 Native Tool Calling**        | Full support for function/tool calls. Agents like RooCode can use `read_file`, `edit_file`, etc. seamlessly. |
| **🚀 Direct Device Flow Auth**    | Simple "Copy code & Open browser" login. No complex configuration or token juggling.                         |
| **🧠 Thinking Model Support**     | Native handling of reasoning models with extended thinking blocks.                                           |
| **📦 Buffered Response Fallback** | Handles models that skip streaming deltas (e.g., GPT-5 mini), ensuring responses always arrive.              |
| **🔄 Dynamic Port Allocation**    | Automatically finds an available port if the default (9317) is in use.                                       |
| **🎨 Sidebar Dashboard**          | Beautiful, self-contained UI to monitor status, select models, and control the gateway.                      |

---

## 🚀 Quick Start

### 1. Install & Login

```
1. Install the .vsix package.
2. Run command: "OpenRoute: Login with GitHub"
3. Copy the 8-character code and authorize in your browser.
```

### 2. Start the Gateway

```
1. Open the "OpenRoute" sidebar in VS Code.
2. Click "Start Server".
3. The gateway fetches your available models from GitHub automatically.
```

### 3. Connect Your Tools

| Setting      | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| **Base URL** | `http://localhost:9317/v1`                                            |
| **API Key**  | `openroute` (or any non-empty string)                                 |
| **Model**    | Choose from the sidebar dropdown (e.g., `claude-sonnet-4`, `gpt-4.1`) |

---

## ⚙️ Configuration

| Setting                           | Default | Description                                           |
| --------------------------------- | ------- | ----------------------------------------------------- |
| `openroute.server.port`           | `9317`  | Base port for the gateway (auto-increments if busy).  |
| `openroute.server.executablePath` | `null`  | Path to the `copilot` CLI (auto-detected if not set). |

---

## 🏗️ Technical Architecture

```
┌─────────────────────┐       ┌─────────────────────┐       ┌─────────────────────┐
│   External Tool     │       │   OpenRoute Gateway │       │   GitHub Copilot    │
│ (RooCode, curl...)  │ ────▶ │   (localhost:9317)  │ ────▶ │       SDK           │
│                     │ HTTP  │                     │ SDK   │                     │
└─────────────────────┘       └─────────────────────┘       └─────────────────────┘
        OpenAI Format                Translator                   Turn-Based Events
```

1. **SDK-Native Core**: Powered by `@github/copilot-sdk`. No external binaries or legacy CLIProxyAPI.
2. **Device Code Auth**: Implements OAuth Device Flow for simple, headless-compatible authentication.
3. **Protocol Translator**: Converts OpenAI `messages` to SDK Turns, and SDK events to SSE chunks.
4. **Tool Registry**: Manages suspended sessions for multi-turn tool calling workflows.
5. **Thinking Adapter**: Extracts and formats extended thinking blocks for reasoning models.

---

## 🔧 Tool Calling (Agentic Use)

Copilot OpenRoute fully supports the OpenAI tool calling protocol, enabling agents like RooCode to:

1. Send a request with `tools: [...]`.
2. Receive a `tool_calls` response.
3. Send back `role: tool` messages with results.
4. Continue the conversation seamlessly.

The gateway uses a `ToolRegistry` to suspend SDK sessions while waiting for tool results, then resumes them correctly when results arrive.

---

## 📦 Installation

### From VSIX (Recommended)

1. Download `copilot-openroute-1.0.0.vsix` from Releases.
2. In VS Code: `Extensions` → `...` → `Install from VSIX...`.

### From Source

```bash
git clone https://github.com/pmanalan/copilot-openroute.git
cd copilot-openroute
npm install
npm run build
npx @vscode/vsce package
```

---

## 🆚 Comparison with antigravity-copilot

| Aspect             | antigravity-copilot           | copilot-openroute                   |
| ------------------ | ----------------------------- | ----------------------------------- |
| **Core Engine**    | CLIProxyAPI (external binary) | `@github/copilot-sdk` (npm package) |
| **Authentication** | CLI `auth login` command      | Direct OAuth Device Flow            |
| **Tool Calling**   | Not supported                 | Full native support                 |
| **Architecture**   | Proxy to external process     | In-process SDK integration          |
| **VSIX Size**      | ~23 MB (with webview-ui)      | ~650 KB                             |
| **Complexity**     | Multiple moving parts         | Single, self-contained extension    |

---

## Credits

- **Punal Manalan** — Author and maintainer
- **[@github/copilot-sdk](https://github.com/github/copilot-sdk)** — The official SDK powering this extension
- **antigravity-copilot** — The original project that inspired this total conversion

---

## ⚠️ Disclaimer

This project is **unofficial** and is not affiliated with, endorsed by, or supported by GitHub, Microsoft, or OpenAI. It is a community-driven tool designed to enhance developer productivity by providing an integration layer for the GitHub Copilot SDK.

**Usage must comply with the [GitHub Copilot Terms of Service](https://docs.github.com/en/copilot/overview-of-github-copilot/about-github-copilot-for-individuals#github-copilot-terms-of-service).**

---

## 📜 License

MIT
