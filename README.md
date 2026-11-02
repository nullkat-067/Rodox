# RODOX v2.0.0

> **Think beyond commands.**

RODOX is an Intelligent Terminal AI made by **NullKat Development**. Red-and-black cyber-terminal
interface, temporary conversation memory, Markdown + syntax-highlighted responses, a system prompt
that **you** write yourself, support for Gemini or any OpenAI-compatible provider, and a `/build`
mode that generates a whole project's files into a fresh folder (it never runs anything).

## Requirements

- Node.js **20 or newer** (`node -v`)
- An API key for whichever provider you use (free tiers exist — usage limits apply)
- A terminal with colour support (Termux, Linux, macOS, Windows Terminal)

## Install

```bash
npm install
node rodox.js
```

### Termux (Android)

```bash
pkg update && pkg install nodejs git
cd rodox
npm install
node rodox.js
```

All dependencies are pure JavaScript, so no native build tools are needed.

## Choose a provider

On first run RODOX asks which provider to use:

1. **Gemini** (default, recommended) — the official Google SDK. Get a free key at
   <https://aistudio.google.com/apikey>.
2. **Custom provider** — any API you already have **legitimate** access to that implements the
   OpenAI-compatible `/chat/completions` endpoint (for example Groq, Together AI, OpenRouter,
   DeepSeek, Mistral, or a self-hosted server). You supply the provider's own official base URL,
   a model name, and your own API key. RODOX does not ship or recommend any specific endpoint —
   only use a base URL and key you were given directly by that provider.

Switch providers any time with `/provider switch`. Your key is validated with a real request
before anything is saved, and is then written to `.env` (file mode 600) so you are never asked
again. `.env` is in `.gitignore`; the key is never printed in full or written to logs.

## Write your system prompt

RODOX ships **no persona**. Open `config/system.prompt.txt` and write the instructions for your
provider below the comment block (`<!-- ... -->` is ignored). The text is sent as the system
instruction for chat, and is also appended as style notes when using `/build`.

Until the file has content, RODOX refuses to send chat requests and tells you why.
After editing, use `/prompt reload` or restart RODOX.

## Configuration (.env)

| Key | Meaning |
|---|---|
| `RODOX_PROVIDER` | `gemini` (default) or any name for a custom provider |
| `RODOX_PROVIDER_LABEL` | Display name shown in RODOX (custom providers only) |
| `RODOX_API_KEY` | Your API key |
| `RODOX_MODEL` | Model name; change via `/model <name>` |
| `RODOX_BASE_URL` | Base URL of a custom OpenAI-compatible provider |
| `RODOX_TIMEOUT_MS` | Optional request timeout (default 60000) |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Legacy names from v1.0.0, still read if the `RODOX_*` ones above are absent |

## Commands

| Command | What it does |
|---|---|
| `/help` | List commands |
| `/about` | About RODOX / NullKat Development |
| `/provider` | Show current provider · `/provider switch` to change it |
| `/model` | Show current model · `/model list` · `/model <name>` (validated, saved to `.env`) |
| `/build <description>` | Generate a new project into `projects/<name>/` — writes files only, never runs anything |
| `/personality` | Summary of the loaded system prompt |
| `/prompt` | Show the system prompt · `/prompt reload` re-reads the file |
| `/stats` | Uptime, requests, retries, tokens, memory usage |
| `/reset` | Wipe session memory and reload the prompt |
| `/clear` | Clear the screen (memory kept) |
| `/version` | RODOX, provider and Node versions |
| `/exit` | End the session |

Input tips: end a line with `\` to continue on the next line; pasted multi-line text is sent as one
message; **Ctrl+C** cancels a running request.

## `/build` — generating a project

`/build <what you want>` asks the model for a short plan plus a complete set of files, then writes
them into a new folder under `projects/` (never overwriting an existing one — RODOX adds `-2`, `-3`,
etc. if the name is taken). Paths are checked so nothing can be written outside that folder.
**RODOX never executes anything it generates** — review the code yourself before running it.

This is a single-shot generator, not a multi-step autonomous agent: one request in, one set of
files out. For anything non-trivial, iterate by running `/build` again with a refined description,
or edit the generated files yourself.

## Memory

Conversation memory lives in RAM only and is never written to disk. When it grows past 24 messages or
about 60k characters, older messages are summarised by your provider and the summary is kept as
context. RODOX never executes generated code.

## Troubleshooting

| Problem | Fix |
|---|---|
| `SDK missing — run npm install` | Run `npm install` inside the project folder |
| `API key is invalid` | Create/check a key for your provider; `/provider switch` to re-enter it |
| `Rate limit reached` / `Daily quota exhausted` | Free-tier limits apply. Wait, or try another model with `/model` |
| `Model ... is not available` | `/model list`, then `/model <name>` — the error message also shows the provider's own reason |
| `Cannot reach <provider>` | Check internet / VPN / proxy; RODOX retries a limited number of times. On a VPS with broken IPv6, RODOX already forces IPv4 for its own requests |
| `System prompt required` | Fill `config/system.prompt.txt`, then `/prompt reload` |
| Garbled box characters | Use a UTF-8 font/terminal (Termux: default works; Windows: Windows Terminal) |
| Colours missing | Set `FORCE_COLOR=1`, or use a terminal with 256-colour/truecolor support |

## Structure

```
rodox/
├── rodox.js
├── lib/
│   ├── providers.js   (Gemini + OpenAI-compatible provider adapters)
│   └── builder.js     (/build project generator: parsing, path safety)
├── package.json
├── .env               (created on first run, git-ignored)
├── .env.example
├── .gitignore
├── README.md
├── config/
│   └── system.prompt.txt
└── projects/          (output of /build, git-ignored)
```

NULLKAT DEVELOPMENT.
