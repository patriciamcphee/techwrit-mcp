#!/usr/bin/env node
// TechWrit AI MCP server — exposes the 17 documentation modes as MCP tools so any
// MCP client (Claude Desktop, Cursor, Claude Code, …) can call them as native tools.
// Each tool maps to one mode of the v1 analyze API (POST /api/v1/analyze).
//
// Config (precedence: env → config.local.json next to this file →
//         ~/.config/techwrit/config.json → default):
//   TWAI_API_BASE   analyze URL (default: https://techwrit-api.azurewebsites.net/api/v1/analyze)
//                   The default points at the Function App directly, which avoids the
//                   ~60s SWA-proxy timeout on techwrit.ai/api. Point at
//                   http://localhost:7072/api/v1/analyze to hit a local func.
//   TWAI_API_KEY    twai_… key (Settings → API Keys; needs Pro/Team). Omit only when
//                   hitting a local func with the dev bypass.
// A git-ignored config.local.json may set { "apiBase": "...", "apiKey": "twai_..." }.
// When the server runs through npx, the file next to it lives in the npx cache, so
// ~/.config/techwrit/config.json (or $XDG_CONFIG_HOME/techwrit/config.json) is the
// durable place for the same settings.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_BASE = "https://techwrit-api.azurewebsites.net/api/v1/analyze";
const here = dirname(fileURLToPath(import.meta.url));
const userConfigDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

function readConfigFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function loadConfig() {
  const local = readConfigFile(join(here, "config.local.json"));
  const user = readConfigFile(join(userConfigDir, "techwrit", "config.json"));
  return {
    apiBase: process.env.TWAI_API_BASE || local.apiBase || user.apiBase || DEFAULT_BASE,
    apiKey: process.env.TWAI_API_KEY || local.apiKey || user.apiKey || "",
  };
}

// One entry per TechWrit AI mode. `suggestions: true` means the mode also accepts
// format:"suggestions" to return structured, machine-applicable findings.
const MODES = [
  { mode: "review", suggestions: true, summary: "Review technical documentation against the account's saved style rules, terminology, and glossary. Returns severity-ranked findings (Critical, Important, Minor)." },
  { mode: "rewrite", summary: "Rewrite documentation to comply with the account's style rules, terminology, and glossary. Returns the corrected document." },
  { mode: "style-check", suggestions: true, summary: "Audit the document against every active style rule and return a structured pass/fail per rule plus a style score." },
  { mode: "generate", summary: "Generate technical documentation from a prompt or description." },
  { mode: "simplify", summary: "Simplify documentation for readability while preserving technical accuracy." },
  { mode: "keywords", summary: "Generate search/SEO keywords and metadata for the document." },
  { mode: "code-to-docs", summary: "Generate API and developer reference documentation from source code. Put the source code in `input`." },
  { mode: "user-guide", summary: "Generate end-user concepts and how-to documentation from product code." },
  { mode: "explain", summary: "Explain code or documentation in plain language." },
  { mode: "summarize", summary: "Summarize technical documentation." },
  { mode: "expand", summary: "Expand abbreviated notes or an outline into full technical documentation." },
  { mode: "translate", summary: "Translate technical documentation into another language. State the target language in `input` (e.g. \"Translate to Spanish: …\")." },
  { mode: "outline", summary: "Generate a documentation outline/structure for a topic." },
  { mode: "ux-review", suggestions: true, summary: "Review UI copy / microcopy (button labels, errors, tooltips, empty states) for clarity, tone, consistency, and accessibility." },
  { mode: "ux-rewrite", summary: "Rewrite UI copy / microcopy to be concise and actionable." },
  { mode: "ux-generate", summary: "Generate UI copy / microcopy from a description or scenario." },
  { mode: "glossary-gen", summary: "Generate a glossary section (terms and definitions) from the document." },
];

const toolName = (mode) => `techwrit_${mode.replace(/-/g, "_")}`;

function inputSchemaFor(entry) {
  const properties = {
    input: {
      type: "string",
      description:
        "The text to process — the document, source code, or prompt for this mode.",
    },
    docType: {
      type: "string",
      description:
        'Optional document-type context, e.g. "API reference", "User guide", "Release notes".',
    },
    audience: {
      type: "string",
      enum: ["consumer", "engineers", "developers", "devops"],
      description: "Optional target audience; tailors vocabulary and detail level.",
    },
    framework: {
      type: "string",
      description: "Optional output framework/structure hint for the mode.",
    },
  };
  if (entry.suggestions) {
    properties.format = {
      type: "string",
      enum: ["suggestions"],
      description:
        'Set to "suggestions" to receive a structured JSON array of findings (each with severity, original, replacement, reason) instead of prose.',
    };
  }
  return { type: "object", properties, required: ["input"] };
}

const TOOLS = MODES.map((entry) => ({
  name: toolName(entry.mode),
  description: entry.summary,
  inputSchema: inputSchemaFor(entry),
}));

const TOOL_TO_MODE = new Map(MODES.map((e) => [toolName(e.mode), e.mode]));

// Prompts surface as slash commands in MCP clients (Claude Desktop, Cursor,
// Claude Code). One per mode, named the same as its tool. Invoking a prompt seeds
// a message that tells the client to run that mode's tool on the given input.
const PROMPTS = MODES.map((entry) => ({
  name: toolName(entry.mode),
  description: entry.summary,
  arguments: [
    {
      name: "input",
      description:
        "The text to process — the document, source code, or prompt for this mode.",
      required: true,
    },
  ],
}));

async function callAnalyze(mode, args) {
  const { apiBase, apiKey } = loadConfig();
  const input = typeof args?.input === "string" ? args.input : "";
  if (!input.trim()) {
    throw new Error("`input` is required and must be non-empty.");
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) {
    // The API accepts either header; send both so this works against the direct
    // Function App URL and the techwrit.ai/api SWA base (which reserves Authorization).
    headers["X-Authorization"] = `Bearer ${apiKey}`;
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const body = {
    mode,
    input,
    docType: args?.docType || "",
    audience: args?.audience || "",
    framework: args?.framework || "",
  };
  if (args?.format) body.format = args.format;

  let res;
  try {
    res = await fetch(apiBase, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`Could not reach ${apiBase} — ${e.message}`);
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Non-JSON response (HTTP ${res.status}). Is TWAI_API_BASE correct? First bytes: ${text.slice(0, 120)}`
    );
  }

  if (!res.ok || data.error) {
    const code = data.error?.code ? ` [${data.error.code}]` : "";
    let msg = `API error (HTTP ${res.status})${code}: ${data.error?.message || text}`;
    if (data.error?.code === "UNAUTHORIZED")
      msg += "\n→ Set TWAI_API_KEY (a twai_… key from Settings → API Keys), or point TWAI_API_BASE at a local func with the dev bypass.";
    if (data.error?.code === "API_KEY_REQUIRED")
      msg += "\n→ The v1 API requires a Pro or Team subscription.";
    throw new Error(msg);
  }

  // Suggestions mode returns a structured array; everything else returns markdown.
  let payload =
    data.suggestions !== undefined
      ? JSON.stringify(data.suggestions, null, 2)
      : data.content || "";
  if (data.parseError)
    payload += "\n\n⚠ suggestions parse failed; raw content returned above.";
  const q = data.quota;
  if (q && q.limit != null)
    payload += `\n\n[${data.mode}] ${data.usage?.outputTokens ?? "?"} output tokens · ${q.remaining}/${q.limit} requests left this month`;
  return payload;
}

const server = new Server(
  { name: "techwrit-mcp", version: "0.1.0" },
  { capabilities: { tools: {}, prompts: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const mode = TOOL_TO_MODE.get(request.params.name);
  if (!mode) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }
  try {
    const text = await callAnalyze(mode, request.params.arguments || {});
    return { content: [{ type: "text", text }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e.message }] };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.name;
  const mode = TOOL_TO_MODE.get(name);
  if (!mode) throw new Error(`Unknown prompt: ${name}`);
  const summary = MODES.find((e) => toolName(e.mode) === name)?.summary || "";
  const input = (request.params.arguments?.input || "").trim();
  const text = input
    ? `Use the \`${name}\` tool to run TechWrit AI's "${mode}" mode on the following input. ${summary}\n\n---\n${input}`
    : `Use the \`${name}\` tool to run TechWrit AI's "${mode}" mode. Ask me for the input to process if I haven't provided it yet. ${summary}`;
  return {
    description: summary,
    messages: [{ role: "user", content: { type: "text", text } }],
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout — it's the JSON-RPC channel. Log to stderr.
  console.error(`techwrit-mcp ready · ${TOOLS.length} tools · ${PROMPTS.length} prompts · base ${loadConfig().apiBase}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
