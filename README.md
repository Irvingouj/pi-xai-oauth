# pi-xai-oauth

[![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/BlockedPath/pi-xai-oauth?utm_source=oss&utm_medium=github&utm_campaign=BlockedPath%2Fpi-xai-oauth&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https://coderabbit.ai)
[![npm version](https://img.shields.io/npm/v/pi-xai-oauth)](https://www.npmjs.com/package/pi-xai-oauth)
[![npm downloads](https://img.shields.io/npm/dm/pi-xai-oauth)](https://www.npmjs.com/package/pi-xai-oauth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/BlockedPath/pi-xai-oauth?style=social)](https://github.com/BlockedPath/pi-xai-oauth/stargazers)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/BlockedPath/pi-xai-oauth/pulls)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typescriptlang.org/)
[![pi compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)

**xAI (Grok) OAuth provider for pi** — now with **Grok 4.5**, reasoning, long context, and custom xAI tools.

```bash
npx pi-xai-oauth
```

## ✨ New: Grok 4.5

| | |
|---|---|
| **Model ID** | `grok-4.5` |
| **Role** | xAI flagship for coding, agentic tasks, and knowledge work |
| **Context** | 500K tokens |
| **Input** | text + image |
| **Reasoning** | `low` / `medium` / `high` (defaults to **high**; cannot be disabled) |
| **Fast mode** | Same model with **`low`** reasoning effort — not a separate model ID |
| **Pricing** | $2 / $6 per 1M input/output · $0.50 cache read |

```bash
pi --model grok-4.5 "Ship this feature end-to-end"
pi --model grok-4.5:high "Review this architecture for failure modes"
pi --model grok-4.5:low "Quick status check"   # fast mode
```

This package adds **Grok 4.5** (default), **Grok 4.3**, **Grok Build**, and **Composer 2.5** as fully-integrated xAI OAuth models in pi, with proper OAuth login, automatic token refresh, and a suite of custom tools (`xai_generate_text`, `xai_web_search`, `xai_x_search`, etc.).

> **Latest release:** `pi-xai-oauth` **1.3.0** adds **Grok 4.5** as the default model (500K context, low/medium/high reasoning; fast mode = `low`). Existing npm installs should run `pi update npm:pi-xai-oauth`; local checkout installs should keep only one copy with `pi remove npm:pi-xai-oauth && pi install .`.
>
> **Compatibility note:** 1.2.4+ supports pi 0.79.8+'s OpenAI Responses API guard for Grok/xAI streaming.

---

## Table of Contents

- [✨ New: Grok 4.5](#-new-grok-45)
- [Features](#features)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Authentication](#authentication)
- [Usage](#usage)
  - [Switching Models](#switching-models)
  - [Reasoning / Thinking Levels](#reasoning--thinking-levels)
- [Custom Tools](#custom-tools)
- [Quick Reference](#quick-reference)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Agent Scaffolding](#agent-scaffolding)
- [Development](#development)
- [Contributing](#contributing)

---

## Features

- **Real OAuth login** — authenticates through xAI's official OAuth endpoint (same flow as the Grok CLI)
- **Automatic browser open** — pi opens your default browser automatically; fall back to manual paste if needed
- **Token refresh** — refresh tokens are stored and rotated automatically before expiry
- **Reuses existing credentials** — auto-detects `~/.grok/auth.json` from the official Grok CLI
- **Grok 4.5 flagship (default)** — xAI's newest model for coding, agentic tasks, and knowledge work; 500K context, text+image input, high reasoning by default
- **Grok 4.5 fast mode** — same model with `low` reasoning effort (`/think low` or `grok-4.5:low`); not a separate model ID
- **Long-context option** — Grok 4.3 still available with a full 1M context window
- **Coding models** — Grok Build and Composer 2.5 Fast are available from the same `xai-auth` provider
- **Reasoning support** — configurable thinking levels: `low` / `medium` / `high`
- **Custom xAI tools** — generate text, web search, X/Twitter search, multi-agent research, code analysis
- **Modern API** — uses OpenAI's `responses` API format via `https://api.x.ai/v1`, with Grok CLI endpoint routing for CLI-only models

> **✅ Verified (May 2026)**: All custom xAI tools (`xai_generate_text`, `xai_x_search`, `xai_web_search`, `xai_code_execution`, `xai_critique`, `xai_multi_agent`, `xai_deep_research`, image tools, etc.) have been tested end-to-end after the OAuth + payload repair. The provider now correctly handles mixed-model requests and native xAI tool shapes.

---

## How It Works

`pi-xai-oauth` registers an OAuth provider called `xai-auth` in pi's provider registry. When you run `pi /login xai-auth`:

1. pi starts a local HTTP callback server on `127.0.0.1`
2. It builds an xAI OAuth authorize URL with PKCE challenge
3. **Your default browser opens automatically** to the xAI login page
4. After you approve, xAI redirects to the local callback server
5. The authorization code is exchanged for access + refresh tokens
6. Tokens are persisted and refreshed automatically

If localhost callbacks are blocked (VPN, Docker, remote dev), the TUI shows a text field where you can paste the redirect URL manually.

---

## Installation

### One-command install (recommended)

```bash
npx pi-xai-oauth
```

This runs the setup script which:
1. Installs `npm:pi-xai-oauth` into pi
2. Sets `xai-auth` as your default provider
3. Sets `grok-4.5` as your default model
4. Enables `high` thinking level by default

### Manual install

```bash
pi install npm:pi-xai-oauth
```

Then optionally configure it as default:

```bash
# In ~/.pi/agent/settings.json:
{
  "defaultProvider": "xai-auth",
  "defaultModel": "grok-4.5",
  "defaultThinkingLevel": "high"
}
```

> **⚠️ Important: install only one copy**
>
> `pi-xai-oauth` registers fixed tool names such as `xai_generate_text`, `xai_web_search`, and `xai_x_search`. If you install more than one copy — for example `npm:pi-xai-oauth` plus a local checkout, or two different local checkouts — pi will fail to start with `Tool "xai_generate_text" conflicts with ...` errors.
>
> Check with:
> ```bash
> pi list
> ```
>
> For local development, keep only this checkout:
> ```bash
> pi remove npm:pi-xai-oauth
> pi remove /path/to/other/pi-xai-oauth-copy
> pi install .
> ```
>
> For the published npm package, remove local checkouts:
> ```bash
> pi remove /path/to/local/pi-xai-oauth-copy
> pi install npm:pi-xai-oauth
> ```
>
> Use the exact package spec/path shown by `pi list` when removing duplicates.

---

## Authentication

```bash
pi /login xai-auth
```

**What happens:**

1. pi checks for existing Grok CLI credentials (`~/.grok/auth.json`). If found, it asks if you want to skip re-authentication.
2. The xAI OAuth page opens in your **default browser**.
3. Sign in with your xAI / Grok account and approve the authorization.
4. The browser redirects back to pi's local server — you can close the browser tab.
5. Tokens are stored and refreshed automatically.

> **Choosing a different browser/profile?** The instructions in the TUI explain how. You can copy the shown URL, open your preferred browser manually, and paste it there.

### Re-authenticating

Tokens are refreshed automatically, but if you want to force a fresh login:

```bash
pi /login xai-auth
```

The existing `~/.grok/auth.json` prompt lets you either reuse or re-authenticate.

---

## Usage

Once authenticated, start using Grok:

```bash
pi "Explain quantum computing like I'm 5"
```

Or use a specific model:

```bash
pi --model grok-4.5 "Write a poem about Rust"
```

### Switching Models

| Model ID | Description |
|----------|-------------|
| `grok-4.5` | **Default.** xAI flagship for coding, agentic tasks, and knowledge work; reasoning low (**fast**) / medium / high (default), 500K context, text+image. |
| `grok-4.3` | Full reasoning, 1M context. |
| `grok-build` | Grok Build coding model via the Grok CLI OAuth endpoint, 512K context. |
| `grok-composer-2.5-fast` | Composer 2.5 Fast coding model via the Grok CLI OAuth endpoint, 200K context. |
| `grok-4.20-0309-reasoning` | Grok 4.20 with automatic reasoning, 2M context. |
| `grok-4.20-0309-non-reasoning` | Grok 4.20 fast responses, 2M context. |
| `grok-4.20-multi-agent-0309` | Grok 4.20 multi-agent research model, 2M context. |

From the pi TUI:

```
/model grok-4.5
/model grok-4.3
/model grok-build
/model grok-composer-2.5-fast
/model grok-4.20-0309-reasoning
/model grok-4.20-multi-agent-0309
```

From the command line:

```bash
pi --model grok-4.5 "Your prompt here"
pi --model grok-4.3 "Use the 1M-context model"
pi --model grok-build "Implement this feature"
pi --model grok-composer-2.5-fast "Refactor this module"
pi --model grok-4.20-0309-non-reasoning "Quick answer"
```

### Reasoning / Thinking Levels

Grok 4.5 and Grok 4.3 support configurable thinking levels via pi's `/think` command or `model:effort` syntax. There is **no separate `grok-4.5-fast` model** — on Grok 4.5, “fast mode” is **`reasoning_effort: "low"`** on the same model ID.

```
/think high
/think medium
/think low      # Grok 4.5 fast mode
```

Or via CLI:

```bash
pi --model grok-4.5:high "Solve a complex math problem"
pi --model grok-4.5:medium "Summarize this design doc"
pi --model grok-4.5:low "What's the weather?"   # fast / latency-sensitive
```

| Effort | Grok 4.5 behavior (per xAI docs) | Best for |
|--------|-----------------------------------|----------|
| **`high`** (default) | More reasoning tokens, deeper thinking | Hard coding, complex math, multi-step logic |
| **`medium`** | Balanced thinking vs latency | Analysis and longer-context work |
| **`low`** (**fast mode**) | Some reasoning, still fast | Latency-sensitive agents and simple tool calling |

`grok-4.5` defaults to **high** when no effort is specified; reasoning **cannot be disabled** (`/think off` is not supported for this model). `grok-build` and `grok-composer-2.5-fast` are routed through xAI's Grok CLI OAuth endpoint using the same X account OAuth token. `grok-composer-2.5-fast` does not accept configurable reasoning effort. `grok-4.20-0309-reasoning` reasons automatically and does not accept a configurable effort parameter. `grok-4.20-multi-agent-0309` uses `medium` for 4 agents and `high` for 16 agents.

### Grok 4.5 source notes

Official xAI sources used for this catalog update:

- [Grok 4.5 guide](https://docs.x.ai/developers/grok-4-5) — model ID, API usage, reasoning levels, tools, and availability notes.
- [Grok 4.5 model details](https://docs.x.ai/developers/models/grok-4.5) — text+image input, 500K context window, cached input pricing, regions, and rate-limit snapshot.
- [Reasoning docs](https://docs.x.ai/developers/model-capabilities/text/reasoning) — `low` / `medium` / `high` reasoning effort, default `high`, and non-disableable reasoning.
- [Launch announcement](https://x.ai/news/grok-4-5) — coding/agentic benchmark notes, Grok Build/Cursor availability, and EU availability caveat.

No Grok 4.5-specific model card, label card, system card, paper, or official max-output-token limit was found in the xAI docs/news/data sources during this update. The package keeps the existing Grok Responses max-token ceiling as a placeholder until xAI publishes official model metadata for that field.

### Tool compatibility

This package registers no Cursor/Grok CLI tool shims. Composer, Grok Build, and Grok 4.5 use pi's native tools; install `pi-extensions` separately if you want its shared tool policies.

---

## Custom Tools

This package registers OAuth-backed custom tools that use the xAI API directly. They appear alongside your other agent tools in the pi TUI and are available to any agent running with the `xai-auth` provider.

**How to use them:** Simply call the tool by name in your prompts or agent workflows (e.g. "use xai_web_search to find the latest Rust news"). The tools automatically use your authenticated xAI session.

> **Tip:** See the ⚠️ warning above about local vs published package conflicts.

### `xai_generate_text`
Generate text with full reasoning and stateful conversations.

```json
{
  "prompt": "Explain neural networks",
  "model": "grok-4.5",
  "reasoning_effort": "high"
}
```

### `xai_multi_agent`
Deep multi-agent research using Grok's multi-agent model plus native web and X search tools.

```json
{
  "query": "Latest advances in LLM quantization",
  "num_agents": 16,
  "reasoning_effort": "high"
}
```

### `xai_web_search`
Search the web using xAI's native `web_search` tool.

```json
{
  "query": "Rust vs Go performance 2026"
}
```

### `xai_x_search`
Search X (Twitter) using xAI's native `x_search` tool.

```json
{
  "query": "grok 4.5"
}
```

### `xai_code_execution`
Run Python-oriented analysis using xAI's native `code_interpreter` tool.

```json
{
  "code": "print(sum(range(100)))"
}
```

### `xai_generate_image`
Generate images with xAI's current image generation model.

```json
{
  "prompt": "A clean product diagram of an OAuth flow",
  "model": "grok-imagine-image-quality"
}
```

### `xai_analyze_image`
Analyze an image URL, data URL, or local `.png` / `.jpg` path with Grok vision.

```json
{
  "image": "/Users/me/Desktop/screenshot.png",
  "question": "What error is visible?"
}
```

### `xai_critique`
Get structured critique for code, designs, writing, or ideas.

```json
{
  "content": "function add(a,b){ return a-b }",
  "aspect": "code correctness"
}
```

### `xai_deep_research`
Research a topic with Grok reasoning plus native web and X search tools.

```json
{
  "topic": "Recent xAI Responses API tool changes",
  "depth": "high"
}
```

> **Note:** These tools use the xAI API under the hood — they count toward your SuperGrok rate limits.

---

## Quick Reference

| Action | Command |
|--------|---------|
| Install | `pi install npm:pi-xai-oauth` |
| One-command setup | `npx pi-xai-oauth` |
| Try ephemeral | `pi -e npm:pi-xai-oauth` |
| Authenticate | `pi /login xai-auth` |
| Update | `pi update npm:pi-xai-oauth` |
| Remove | `pi remove npm:pi-xai-oauth` |
| List packages | `pi list` |
| Set default model | `/model grok-4.5` (in TUI) |
| Set thinking level | `/think high` (in TUI) |

---

## Troubleshooting

### "Browser didn't open automatically"

pi runs `open <url>` on macOS / `xdg-open` on Linux to launch your default browser. If nothing happens:

- **Copy the URL** shown in the TUI and paste it into your preferred browser manually.
- The local callback server is still listening — once you authorize, the redirect will be caught even if the browser doesn't match.

### "Callback server didn't receive the redirect"

If localhost is blocked (VPN, Docker, remote SSH, WSL):

1. After authorizing in the browser, the page will show an error (can't reach localhost).
2. **Copy the full URL** from the browser's address bar.
3. **Paste it into the TUI's input field** that says "Paste redirect URL below."
4. pi parses the authorization code from the URL and completes the login.

### "Cannot find provider xai-auth"

Run `pi list` to verify the package is installed. If not:

```bash
pi install npm:pi-xai-oauth
```

Then run `pi /list-providers` — you should see `xai-auth` listed.

### `422 "Failed to deserialize ... ModelInput"` with images

This means xAI rejected a multimodal Responses `input` shape. Use the latest package version and restart pi or run `/reload`. The provider normalizes local `.png`/`.jpg` paths into `data:image/...;base64,...` URLs, adds image `detail`, moves system/developer text to top-level `instructions`, and rewrites image-bearing tool results so `function_call_output.output` stays text-only (xAI rejects arrays there).

> **Fixed in repair**: Requests from other providers (DeepSeek, OpenAI Codex, etc.) no longer get mutated by the xAI sanitation hook.

If you call `xai_generate_text` directly, `image_url` may be either:

- an `http(s)://...` URL
- a `data:image/...;base64,...` URL
- a local `.png`, `.jpg`, or `.jpeg` path, including shell-escaped paths like `/Users/me/My\\ Image.png`

### "Token expired / auth failed"

Tokens refresh automatically, but if something goes wrong:

```bash
pi /login xai-auth
```

This re-runs the full OAuth flow and replaces your stored tokens.

### "Does this need an xAI API key?"

**No.** This uses OAuth — the same authentication as the official Grok CLI and chat interface. You sign in with your xAI / Grok account credentials. No API key required.

If you have the official Grok CLI installed and authenticated (`~/.grok/auth.json`), this package detects and reuses those credentials automatically.

### "What model am I using?"

In the pi TUI, the current model is shown in the status bar. You can also check with:

```
/model
```

### `Tool "xai_generate_text" conflicts with ...` or `pi list` shows duplicate copies

You have more than one copy of this extension installed. This commonly happens when updating from npm to a local checkout, or when switching between two local worktrees. pi refuses to load duplicate tool names.

First inspect installed packages:

```bash
pi list
```

Then remove every duplicate `pi-xai-oauth` entry except the one you want to use.

For local development from this checkout:

```bash
pi remove npm:pi-xai-oauth
pi remove /path/to/old/pi-xai-oauth-copy
pi install .
```

For normal npm usage:

```bash
pi remove /path/to/local/pi-xai-oauth-copy
pi install npm:pi-xai-oauth
```

Restart pi after cleanup. `pi list` should show only one `pi-xai-oauth` entry.

---

## Updating

```bash
pi update npm:pi-xai-oauth
```

This pulls the latest version from npm and updates your installed extension.

pi 0.79.8+ enforces an OpenAI Responses API guard. `pi-xai-oauth` 1.2.4+ handles that guard for Grok/xAI streaming; **1.3.0** adds Grok 4.5 as the default model. If you installed the published npm package, update with the command above. If you are testing a local checkout instead, reinstall the checkout:

```bash
pi remove npm:pi-xai-oauth && pi install .
```

If you previously installed a local checkout with `pi install .`, `pi update npm:pi-xai-oauth` will not replace that local copy. Run `pi list` and make sure only one `pi-xai-oauth` entry is installed. Remove duplicate npm/local/worktree copies before restarting pi.

---

## Uninstalling

```bash
pi remove npm:pi-xai-oauth
```

This removes the extension from pi's package list. Your stored OAuth tokens remain in pi's credential store.

---

## Agent Scaffolding

This package ships with a modern scaffolding system designed for AI coding agents (2026 best practices).

### Bootstrap Scaffolding

```bash
npx pi-xai-oauth --scaffold
# or
npm run scaffold
```

Generates a full agent harness:
- `AGENTS.md` — Dedicated operations manual for AI agents
- `.scaffold/` with persistent state:
  - `plan.md` — Phased implementation roadmap
  - `constraints.md` — Hard rules and safety gates
  - `progress.md` — Live execution tracking
  - `context.md` — Shared context for multi-agent workflows

### Benefits
- Dramatically reduces exploratory turns and token waste
- Enables reliable long-running agentic tasks
- External state files allow agents to resume across sessions
- Built-in support for PARALLEL subagent delegation

Use this in any new project to get the same professional harness.

---

## Development

```bash
# Clone
git clone https://github.com/BlockedPath/pi-xai-oauth.git
cd pi-xai-oauth

# Install deps
npm install

# Type-check
npm run typecheck

# Run verification tests
npm test

# Install local version in pi
pi install .

# Always work on a feature branch (per AGENTS.md)
git checkout -b feature/your-task
```

### Project Structure

```
pi-xai-oauth/
├── extensions/
│   ├── xai-oauth.ts          # Thin provider/tools entrypoint
│   └── xai/                  # Domain modules: OAuth, auth, models, payloads, tools
│       ├── auth.ts           # Grok CLI credential reuse + token resolution
│       ├── constants.ts      # URLs, OAuth constants, defaults
│       ├── models.ts         # Model catalog + routing helpers
│       ├── oauth.ts          # OAuth discovery/login/refresh/callback helpers
│       ├── payload.ts        # xAI Responses payload normalization
│       ├── responses.ts      # xAI request + streaming helpers
├── bin/
│   └── setup.js              # One-command setup (npx pi-xai-oauth)
├── scripts/
│   └── verify-extension.js   # npm test
├── .scaffold/                # Persistent agent state (plan, progress, etc.)
├── AGENTS.md                 # AI agent operations manual
├── package.json
├── tsconfig.json
└── README.md
```

### Publishing

```bash
# Bump version in package.json
# Then:
npm publish

# Users update with:
# pi update npm:pi-xai-oauth
```

---

## Contributing

PRs welcome! If you find issues or want to improve the OAuth flow, feel free to open an issue or pull request on [GitHub](https://github.com/BlockedPath/pi-xai-oauth).

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=BlockedPath/pi-xai-oauth&type=Date)](https://star-history.com/#BlockedPath/pi-xai-oauth&Date)

---

*Powered by Grok 4.5 — flagship reasoning, agentic coding, and the full xAI API.*
