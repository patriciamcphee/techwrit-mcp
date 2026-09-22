# TechWrit AI MCP Server

Exposes all 17 TechWrit AI documentation modes as MCP tools and prompts, so Claude Code, GitHub Copilot, Codex, Gemini CLI, and other MCP clients can call them.

## Requirements

- Node.js 18 or later
- A TechWrit AI Pro or Team plan and a `twai_` API key from Settings > API Keys

## Set up

Set your key in your shell profile:

```bash
export TWAI_API_KEY="twai_..."
```

The easiest way to connect every agent is the pixl CLI, which installs the TechWrit AI skills and adds this server to each agent's config:

```bash
pixl install techwrit
```

To add the server to a single MCP client by hand, use this command:

```bash
npx -y @pixlngrid/techwrit-mcp
```

## Configuration

| Setting | Environment variable | Config file key | Default |
| :------ | :------------------- | :-------------- | :------ |
| API key | `TWAI_API_KEY` | `apiKey` | none |
| API endpoint | `TWAI_API_BASE` | `apiBase` | `https://techwrit-api.azurewebsites.net/api/v1/analyze` |

Environment variables take precedence. If you prefer a file, put the settings in `~/.config/techwrit/config.json`.
