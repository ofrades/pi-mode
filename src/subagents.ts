import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  createBashTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
} from "@earendil-works/pi-coding-agent";
import { type ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendCostEntry, highestThinkingLevel, notify, SETTINGS_PATH } from "./mode-core.ts";

export type SubagentName = "search" | "vision" | "review" | "oracle" | "librarian";

export const SUBAGENT_ORDER: SubagentName[] = ["search", "vision", "review", "oracle", "librarian"];

export type SubagentConfig = {
  provider: string;
  model: string;
  thinkingLevel?: ModelThinkingLevel;
};

export type SubagentsConfig = Partial<Record<SubagentName, SubagentConfig>>;

type ModusSettings = {
  subagents?: SubagentsConfig;
};

export const SUBAGENT_METADATA: Record<
  SubagentName,
  { description: string; recommendedModel: string; systemPrompt: string; tools: string[] }
> = {
  search: {
    description: "Fast, accurate codebase retrieval.",
    recommendedModel: "fast/cheap model",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt: `You are a fast, parallel code search agent.

## Task
Find files and line ranges relevant to the user's query (provided in the first message).

## Execution Strategy
- Search through the codebase with the tools that are available to you.
- Your goal is to return a list of relevant filenames with ranges. Your goal is NOT to explore the complete codebase to construct an essay of an answer.
- **Maximize parallelism**: On EVERY turn, make **8+ parallel tool calls** with diverse, scoped search strategies using the tools available to you.
- **Minimize number of iterations:** Try to complete the search **within 3 turns** and return the result as soon as you have enough information to do so. Do not continue to search if you have found enough results.
- **Prioritize source code**: Always prefer source code files (.ts, .js, .py, .go, .rs, .java, etc.) over documentation (.md, .txt, README).
- **Be exhaustive when completeness is implied**: When the query asks for "all", "every", "each", or implies a complete list (e.g., call sites, usages, implementations), find ALL occurrences, not just the first match. Search breadth-first across the codebase.
- **Scope filename globs aggressively**: Prefer directory-scoped patterns such as \`core/**/*watchdog*\` over root-wide patterns like \`**/*watchdog*\`, which still require traversing most of the workspace.
- **Avoid repeated repo-wide filename scans**: Do not spend parallel calls on multiple broad root-level \`glob\` searches; prefer \`grep\` first or narrow to likely directories.

## Output format
- **Ultra concise**: Write a very brief and concise summary (maximum 1-2 lines) of your search findings and then output the relevant files as markdown links.
- Format each file as a markdown link with a file:// URI: [relativePath#L{start}-L{end}](file://{absolutePath}#L{start}-L{end})
- **Line ranges**: Include line ranges (#L{start}-L{end}) when you can identify specific relevant sections, especially for large files. For small files or when the entire file is relevant, the range can be omitted.
- **Use generous ranges**: When including ranges, extend them to capture complete logical units (full functions, classes, or blocks). Add 5-10 lines of buffer above and below the match to ensure context is included.

### Example (assuming workspace root is /Users/alice/project):
User: Find how JWT authentication works in the codebase.
Response: JWT tokens are created in the auth middleware, validated via the token service, and user sessions are stored in Redis.

Relevant files:
- [src/middleware/auth.ts#L45-L82](file:///Users/alice/project/src/middleware/auth.ts#L45-L82)
- [src/services/token-service.ts#L12-L58](file:///Users/alice/project/src/services/token-service.ts#L12-L58)
- [src/cache/redis-session.ts#L23-L41](file:///Users/alice/project/src/cache/redis-session.ts#L23-L41)
- [src/types/auth.d.ts#L1-L15](file:///Users/alice/project/src/types/auth.d.ts#L1-L15)`,
  },
  vision: {
    description: "Analysis of images and videos.",
    recommendedModel: "vision-capable model",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt:
      "You are the vision subagent. Describe images, screenshots, and visual content precisely and completely. Include all text, UI elements, layout, colors, and any information visible. Be thorough — the main agent will rely entirely on your description.",
  },
  review: {
    description: "Bug identification & code review assistance.",
    recommendedModel: "strong coding model",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt: `You are an expert senior engineer with deep knowledge of software engineering best practices, security, performance, and maintainability.

Your task is to perform a code review of the provided diff description. The diff description might be a git or bash command that generates the diff or a description of the diff which can then be used to generate the git or bash command to generate the full diff.

After reading the diff, do the following:
1. Write a high-level summary of the changes in the diff.
2. Go file-by-file and review each changed hunk.
3. Comment on what changed in that hunk (including the line range) and how it relates to other
   changed hunks and code, reading any other relevant files. Also call out bugs, hackiness,
   unnecessary code, or too much shared mutable state.
4. Evaluate abstraction fit in both directions: flag unnecessary indirection (over-abstraction)
   and missing abstractions (duplication or branching complexity). For each finding, cite concrete
   locations and recommend exactly one action—simplify/inline or introduce/extract a shared
   concept—only when it improves current code (avoid speculative refactors).

Strongly prefer to restrict your use of git commands to these when getting the diff or determining which files were added/changed/removed:
<referenceCommands>
  <command>
    <description>committed changes on my branch since diverging from the upstream default branch</description>
    <bash>git diff --merge-base origin/HEAD HEAD</bash>
  </command>
  <command>
    <description>all current checkout changes since diverging from upstream (commits + staged + unstaged tracked)</description>
    <bash>git diff --merge-base origin/HEAD</bash>
  </command>
  <command>
    <description>changes since diverging from upstream up to and including staged changes</description>
    <bash>git diff --cached --merge-base origin/HEAD</bash>
  </command>
  <command>
    <description>current checkout tracked changes since divergence, plus a list of newly added untracked files</description>
    <bash>git diff --merge-base origin/HEAD</bash>
    <bash>git ls-files --others --exclude-standard</bash>
  </command>
  <command>
    <description>changes on branch foo since divergence from upstream</description>
    <bash>git diff --merge-base origin/HEAD foo</bash>
  </command>
  <command>
    <description>only filenames changed by this branch since divergence</description>
    <bash>git diff --name-only --merge-base origin/HEAD HEAD</bash>
  </command>
  <command>
    <description>scope diff to a specific path since diverging from upstream</description>
    <bash>git diff --merge-base origin/HEAD <ref-or-empty> -- &lt;pathspec&gt;</bash>
</command>
</referenceCommands>

Avoid commands in this format, unless explicitly asked for:
<avoidCommands>
  <avoidCommand>git diff <base-ref> <head-ref></avoidCommand>
  <avoidCommand>git diff <base-ref>..<head-ref></avoidCommand>
  <avoidCommand>git diff HEAD...origin/HEAD</avoidCommand>
</avoidCommands>

<guidelines>
- Persistence: Low. Do not retry failed tool calls more than 2 times. If a tool call fails twice, move on.
- Remember to look at untracked added files.
- Prefer the most direct path to completing the review. Batch related file reads into as few turns as possible.
- Do not edit or modify files or run any commands that edit or modify files or git state.
- Do not re-read files you have already read.
- Upstream default branch ref: use origin/HEAD. Do not assume main, origin/main, or origin/master.
- If a diff is unexpectedly large, double check you are using the right refs in git invocations.
- If the diff has more than 100 changed files or is more than 10,000 lines long, abort the review and emit a single critical issue stating the diff is too large.
</guidelines>`,
  },
  oracle: {
    description: "Complex reasoning & planning on code.",
    recommendedModel: "frontier reasoning model",
    tools: ["read", "grep", "find", "ls"],
    systemPrompt: `You are the Oracle - an expert AI advisor with advanced reasoning capabilities.

Your role is to provide high-quality technical guidance, code reviews, architectural advice, and strategic planning for software engineering tasks.

You are a subagent inside an AI coding system, called when the main agent needs a smarter, more capable model. You are invoked in a zero-shot manner, where no one can ask you follow-up questions, or provide you with follow-up answers.

Key responsibilities:
- Analyze code and architecture patterns
- Provide specific, actionable technical recommendations
- Plan implementations and refactoring strategies
- Answer deep technical questions with clear reasoning
- Suggest best practices and improvements
- Identify potential issues and propose solutions

Operating principles (simplicity-first):
- Default to the simplest viable solution that meets the stated requirements and constraints.
- Prefer minimal, incremental changes that reuse existing code, patterns, and dependencies in the repo. Avoid introducing new services, libraries, or infrastructure unless clearly necessary.
- Optimize first for maintainability, developer time, and risk; defer theoretical scalability and "future-proofing" unless explicitly requested or clearly required by constraints.
- Apply YAGNI and KISS; avoid premature optimization.
- Provide one primary recommendation. Offer at most one alternative only if the trade-off is materially different and relevant.
- Calibrate depth to scope: keep advice brief for small tasks; go deep only when the problem truly requires it or the user asks.
- Include a rough effort/scope signal (e.g., S <1h, M 1-3h, L 1-2d, XL >2d) when proposing changes.
- Stop when the solution is "good enough." Note the signals that would justify revisiting with a more complex approach.

Tool usage:
- Use attached files and provided context first. Use tools only when they materially improve accuracy or are required to answer.
- Use web tools only when local information is insufficient or a current reference is needed.
- When calling local file tools, construct paths from the exact working directory or workspace root above.
- Never invent placeholder roots like /workspace, /repo, or /project.
- If you only know a repo-relative path, join it to the workspace root above before calling local file tools.
- If the working directory or workspace root is unknown, use file-search tools first instead of guessing absolute paths.

Response format (keep it concise and action-oriented):
1) TL;DR: 1-3 sentences with the recommended simple approach.
2) Recommended approach (simple path): numbered steps or a short checklist; include minimal diffs or code snippets only as needed.
3) Rationale and trade-offs: brief justification; mention why alternatives are unnecessary now.
4) Risks and guardrails: key caveats and how to mitigate them.
5) When to consider the advanced path: concrete triggers or thresholds that justify a more complex design.
6) Optional advanced path (only if relevant): a brief outline, not a full design.

Guidelines:
- Use your reasoning to provide thoughtful, well-structured, and pragmatic advice.
- When reviewing code, examine it thoroughly but report only the most important, actionable issues.
- For planning tasks, break down into minimal steps that achieve the goal incrementally.
- Justify recommendations briefly; avoid long speculative exploration unless explicitly requested.
- Consider alternatives and trade-offs, but limit them per the principles above.
- Be thorough but concise—focus on the highest-leverage insights.

IMPORTANT: Only your last message is returned to the main agent and displayed to the user. Your last message should be comprehensive yet focused, with a clear, simple recommendation that helps the user act immediately.`,
  },
  librarian: {
    description: "Large-scale retrieval & research on external code.",
    recommendedModel: "docs/research model",
    tools: ["read", "grep", "find", "ls", "bash"],
    systemPrompt:
      "You are the librarian subagent. Research external documentation, APIs, libraries, and public source code. Do not edit files. Bash is for read-only commands only. Cite URLs and source names when available. Return actionable findings.",
  },
};



function readSettings(): Record<string, unknown> {
  try {
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

function readModusSettings(): ModusSettings {
  const settings = readSettings();
  return settings.modus && typeof settings.modus === "object" ? (settings.modus as ModusSettings) : {};
}

export function loadSubagentsConfig(): SubagentsConfig {
  const settings = readSettings();
  const modusSubagents = readModusSettings().subagents;
  if (modusSubagents) return modusSubagents;

  const legacy = settings.iuvate;
  if (legacy && typeof legacy === "object") {
    const routes = (legacy as { routes?: unknown }).routes;
    if (routes && typeof routes === "object") return routes as SubagentsConfig;
  }

  return {};
}

export function persistSubagentsConfig(ctx: ExtensionContext, subagents: SubagentsConfig): void {
  try {
    const settings = readSettings();
    const modus = settings.modus && typeof settings.modus === "object" ? settings.modus as Record<string, unknown> : {};
    modus.subagents = subagents;
    settings.modus = modus;
    writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (err) {
    notify(ctx, `Could not save subagent settings: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

function modelSpecForSubagent(ctx: ExtensionContext, config: SubagentConfig): string {
  const base = `${config.provider}/${config.model}`;
  if (config.thinkingLevel) return `${base}:${config.thinkingLevel}`;
  const model = ctx.modelRegistry.find(config.provider, config.model);
  return model ? `${base}:${highestThinkingLevel(model)}` : base;
}

function toolNamesForSubagent(name: SubagentName): string[] {
  return SUBAGENT_METADATA[name].tools;
}

function toolsForSubagent(name: SubagentName, cwd: string) {
  const all = {
    read: createReadTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
    bash: createBashTool(cwd),
  };
  return toolNamesForSubagent(name).map((toolName) => all[toolName as keyof typeof all]);
}

function extractLastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j] as { type?: unknown; text?: unknown };
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text.trim();
    }
  }
  return "";
}

function assistantTextFromMessage(message: unknown): string {
  const msg = message as { role?: unknown; content?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  return (msg.content as any[])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function assistantThinkingFromMessage(message: unknown): string {
  const msg = message as { role?: unknown; content?: unknown };
  if (msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
  return (msg.content as any[])
    .filter((part) => part?.type === "thinking" && typeof part.thinking === "string")
    .map((part) => part.thinking)
    .join("")
    .trim();
}

function formatSubagentContent(text: string, thinking: string): string {
  if (!text && !thinking) return "";
  const parts: string[] = [];
  if (thinking) {
    // Show a snippet of thinking content — models can produce long CoT
    const snippet = thinking.length > 300 ? `${thinking.slice(0, 300)}…` : thinking;
    parts.push(`💭 ${snippet}`);
  }
  if (text) parts.push(text);
  return parts.join("\n\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName) ? { command: "pi", args } : { command: process.execPath, args };
}

type ImageInput = { type: "image"; data: string; mimeType: string };

type UsageStats = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type SubprocessResult = {
  text: string;
  stderr: string;
  nonJsonStdout: string;
  exitCode: number;
  usage: UsageStats;
  stopReason?: string;
  errorMessage?: string;
};

async function runVisionSubagent(
  ctx: ExtensionContext,
  name: SubagentName,
  prompt: string,
  config: SubagentConfig,
  images: ImageInput[],
  signal?: AbortSignal,
  onUpdate?: (formatted: string) => void,
): Promise<string> {
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) throw new Error(`Model not found: ${config.provider}/${config.model}`);

  const thinkingLevel = config.thinkingLevel ?? highestThinkingLevel(model);
  const agent = new Agent({
    initialState: {
      model,
      thinkingLevel,
      systemPrompt: SUBAGENT_METADATA[name].systemPrompt,
      tools: toolsForSubagent(name, ctx.cwd),
      messages: [],
    },
    convertToLlm,
    toolExecution: "parallel",
  });

  let latestText = "";
  let latestThinking = "";
  let lastUpdateAt = 0;
  const modelLabel = `${config.provider}/${config.model}`;
  const emit = (status: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    if (ctx.hasUI) ctx.ui.setStatus(`modus-${name}`, `[${name}] ${modelLabel} · ${status}`);
    const body = formatSubagentContent(latestText, latestThinking);
    onUpdate?.(body ? `[${name} · ${status}]\n\n${body}` : `[${name} · ${status}]`);
  };

  const unsub = agent.subscribe((event) => {
    if (event.type === "turn_start") emit("thinking", true);
    else if (event.type === "message_update") {
      const text = extractLastAssistantText([event.message]);
      if (text) latestText = text;
      const thinking = assistantThinkingFromMessage(event.message);
      if (thinking) latestThinking = thinking;
      emit("responding");
    } else if (event.type === "tool_execution_start") emit(event.toolName, true);
    else if (event.type === "tool_execution_end") emit(`${event.toolName} done`, true);
  });

  const onAbort = () => agent.abort();
  if (signal) {
    if (signal.aborted) agent.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    notify(ctx, `[${name}] → ${modelLabel} (thinking:${thinkingLevel})`, "info");
    emit("starting", true);
    await agent.prompt(prompt, images);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unsub();
    if (ctx.hasUI) ctx.ui.setStatus(`modus-${name}`, undefined);
    notify(ctx, `[${name}] ← done`, "info");
  }

  return extractLastAssistantText(agent.state.messages) || "(no output)";
}

async function runSubprocessSubagent(
  ctx: ExtensionContext,
  name: SubagentName,
  prompt: string,
  config: SubagentConfig,
  signal?: AbortSignal,
  onUpdate?: (formatted: string) => void,
): Promise<SubprocessResult> {
  const modelSpec = modelSpecForSubagent(ctx, config);
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-modus-subagent-"));
  const promptPath = join(tmpDir, `${name}.md`);
  writeFileSync(promptPath, SUBAGENT_METADATA[name].systemPrompt, { encoding: "utf8", mode: 0o600 });

  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    modelSpec,
    "--tools",
    toolNamesForSubagent(name).join(","),
    "--append-system-prompt",
    promptPath,
    `Task: ${prompt}`,
  ];

  let latestText = "";
  let latestThinking = "";
  let stderr = "";
  let nonJsonStdout = "";
  const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  let wasAborted = false;
  let lastUpdateAt = 0;

  const emit = (status: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastUpdateAt < 250) return;
    lastUpdateAt = now;
    const body = formatSubagentContent(latestText, latestThinking);
    onUpdate?.(body ? `[${name} · ${status}]\n\n${body}` : `[${name} · ${status}]`);
  };

  notify(ctx, `[${name}] → ${config.provider}/${config.model}`, "info");
  emit("starting", true);

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, { cwd: ctx.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          const next = `${nonJsonStdout}${line}\n`;
          nonJsonStdout = next.length > 64 * 1024 ? `${next.slice(-64 * 1024)}\n[truncated]\n` : next;
          return;
        }
        if (event.type === "turn_start") {
          usage.turns += 1;
          emit("thinking");
        } else if (event.type === "message_update" || event.type === "message_end") {
          const text = assistantTextFromMessage(event.message);
          if (text) latestText = text;
          const thinking = assistantThinkingFromMessage(event.message);
          if (thinking) latestThinking = thinking;
          if (event.message?.stopReason) stopReason = event.message.stopReason;
          if (event.message?.errorMessage) errorMessage = event.message.errorMessage;
          if (event.type === "message_end") {
            const u = event.message?.usage;
            if (u && typeof u === "object") {
              usage.input += u.input ?? 0;
              usage.output += u.output ?? 0;
              usage.cacheRead += u.cacheRead ?? 0;
              usage.cacheWrite += u.cacheWrite ?? 0;
              usage.contextTokens = u.totalTokens ?? usage.contextTokens;
              usage.cost += typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
            }
          }
          emit("responding");
        } else if (event.type === "tool_execution_start") {
          // Skip per-tool start events to reduce flicker
        } else if (event.type === "tool_execution_end") {
          emit(`${String(event.toolName ?? "tool")} done`, true);
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      let settled = false;
      const settle = (code: number) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", killProc);
        resolve(code);
      };
      const killProc = () => {
        if (settled) return;
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        settle(code ?? 0);
      });
      proc.on("error", (err) => {
        stderr += err instanceof Error ? err.message : String(err);
        settle(1);
      });

      if (signal?.aborted) killProc();
      else signal?.addEventListener("abort", killProc, { once: true });
    });

    notify(ctx, `[${name}] ← done`, "info");
    if (wasAborted) throw new Error("Subagent aborted");

    if (usage.cost > 0) {
      appendCostEntry({
        timestamp: Date.now(),
        mode: name,
        provider: config.provider,
        model: config.model,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cost: usage.cost,
      });
    }

    return { text: latestText || "(no output)", stderr, nonJsonStdout, exitCode, usage, stopReason, errorMessage };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseModelSpec(modelSpec: string): SubagentConfig | undefined {
  const slash = modelSpec.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = modelSpec.slice(0, slash);
  const rest = modelSpec.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  if (colon <= 0) return { provider, model: rest };
  return {
    provider,
    model: rest.slice(0, colon),
    thinkingLevel: rest.slice(colon + 1) as ModelThinkingLevel,
  };
}

export function subagentsPrompt(subagents = loadSubagentsConfig()): string {
  const configured = SUBAGENT_ORDER.filter((name) => subagents[name]);
  if (configured.length === 0) return "";
  const lines = configured.map((name) => `- \`${name}\`: ${SUBAGENT_METADATA[name].description}`);
  return [
    "## Named subagents",
    "The following named subagents are available as tools:",
    ...lines,
    "Use a subagent when the user explicitly asks you to use that named subagent (for example, ‘ask oracle ...’). Do not proactively delegate to subagents unless the user requested it.",
  ].join("\n");
}

export function registerSubagentTools(pi: ExtensionAPI): void {
  for (const name of SUBAGENT_ORDER) {
    pi.registerTool({
      name,
      label: name[0].toUpperCase() + name.slice(1),
      description: `${SUBAGENT_METADATA[name].description} Use when the user explicitly asks for the ${name} subagent.`,
      promptSnippet: `The ${name} subagent is available when explicitly requested by the user.`,
      promptGuidelines: [`Do not call ${name} unless the user explicitly asked to use ${name}.`],
      parameters: Type.Object({
        prompt: Type.String({ description: `The task for the ${name} subagent.` }),
        image_path: Type.Optional(Type.String({ description: "Image file path. Only used by the vision subagent." })),
      }),
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const subagents = loadSubagentsConfig();
        const config = subagents[name];
        if (!config) throw new Error(`Subagent "${name}" is not configured. Use /modus subagents set ${name} <provider/model[:thinking]>.`);

        if (name === "vision") {
          const images: ImageInput[] = [];
          if (params.image_path) {
            const imagePath = params.image_path.startsWith("/") ? params.image_path : join(ctx.cwd, params.image_path);
            if (!existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
            const ext = imagePath.split(".").pop()?.toLowerCase() ?? "";
            const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" } as Record<string, string>)[ext];
            if (!mimeType) throw new Error(`Unsupported image type: .${ext}`);
            images.push({ type: "image", data: (await readFile(imagePath)).toString("base64"), mimeType });
          }
          const text = await runVisionSubagent(ctx, name, params.prompt, config, images, signal, (formatted) =>
            onUpdate?.({
              content: [{ type: "text", text: formatted }],
              details: { subagent: name },
            }),
          );
          return { content: [{ type: "text" as const, text: `[${name} via ${config.provider}/${config.model}]\n\n${text}` }], details: { subagent: name, model: `${config.provider}/${config.model}` } };
        }

        const result = await runSubprocessSubagent(ctx, name, params.prompt, config, signal, (formatted) =>
          onUpdate?.({
            content: [{ type: "text", text: formatted }],
            details: { subagent: name },
          }),
        );

        const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Subagent ${name} ${result.stopReason || "failed"}: ${result.errorMessage || result.stderr || result.text || "(no output)"}` }],
            details: { subagent: name, model: `${config.provider}/${config.model}`, ...result },
          };
        }

        return {
          content: [{ type: "text" as const, text: `[${name} via ${config.provider}/${config.model}]\n\n${result.text}` }],
          details: { subagent: name, model: `${config.provider}/${config.model}`, usage: result.usage },
        };
      },
    });
  }
}

export function handleSubagentsCommand(args: string, ctx: ExtensionContext): boolean {
  const [topic, action, name, modelSpec] = args.trim().split(/\s+/);
  if (topic !== "subagents" && topic !== "subagent") return false;

  const subagents = loadSubagentsConfig();
  if (!action || action === "list") {
    const lines = SUBAGENT_ORDER.map((subagentName) => {
      const config = subagents[subagentName];
      const configured = config
        ? `${config.provider}/${config.model}${config.thinkingLevel ? `:${config.thinkingLevel}` : ""}`
        : `unconfigured (recommended: ${SUBAGENT_METADATA[subagentName].recommendedModel})`;
      return `  ${subagentName}: ${configured} — ${SUBAGENT_METADATA[subagentName].description}`;
    });
    notify(ctx, `Modus subagents\n${lines.join("\n")}`, "info");
    return true;
  }

  if (action === "set") {
    if (!name || !SUBAGENT_ORDER.includes(name as SubagentName)) {
      notify(ctx, `Unknown subagent "${name}". Options: ${SUBAGENT_ORDER.join(", ")}`, "error");
      return true;
    }
    if (!modelSpec) {
      notify(ctx, "Usage: /modus subagents set <name> <provider/model[:thinking]>", "error");
      return true;
    }
    const parsed = parseModelSpec(modelSpec);
    if (!parsed) {
      notify(ctx, "Usage: /modus subagents set <name> <provider/model[:thinking]>", "error");
      return true;
    }
    subagents[name as SubagentName] = parsed;
    persistSubagentsConfig(ctx, subagents);
    notify(ctx, `Subagent "${name}" → ${modelSpec}`, "info");
    return true;
  }

  if (action === "unset") {
    if (!name || !SUBAGENT_ORDER.includes(name as SubagentName)) {
      notify(ctx, `Unknown subagent "${name}". Options: ${SUBAGENT_ORDER.join(", ")}`, "error");
      return true;
    }
    delete subagents[name as SubagentName];
    persistSubagentsConfig(ctx, subagents);
    notify(ctx, `Subagent "${name}" unconfigured.`, "info");
    return true;
  }

  notify(ctx, "Usage: /modus subagents [list] | /modus subagents set <name> <provider/model[:thinking]> | /modus subagents unset <name>", "error");
  return true;
}
