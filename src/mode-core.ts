import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ModeName = "rush" | "smart" | "deep";

export type ModeState = {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
};

export type CostEntry = {
  timestamp: number;
  mode: ModeName | string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens?: number;
  cost: number;
};

export type Config = {
  activeMode?: ModeName;
  modes?: Partial<Record<ModeName, Partial<ModeState>>>;
};

export const MODE_ORDER: ModeName[] = ["rush", "smart", "deep"];

export function isModeName(value: string): value is ModeName {
  return (MODE_ORDER as readonly string[]).includes(value);
}

const THINKING_LEVELS_DESC: ModelThinkingLevel[] = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
export const COST_LOG_PATH = join(getAgentDir(), "cost-log.jsonl");

let settingsReadError: string | undefined;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSettings(): Record<string, unknown> {
  try {
    settingsReadError = undefined;
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  } catch (error) {
    settingsReadError = formatError(error);
    return {};
  }
}

function saveConfig(config: Config) {
  const settings = readSettings();
  if (settingsReadError) {
    throw new Error(`Refusing to overwrite unreadable settings.json: ${settingsReadError}`);
  }

  settings.modus = config;
  delete settings.mode;
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

export function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

export function setStatus(ctx: ExtensionContext, key: string, value: string | undefined): void {
  if (ctx.hasUI) ctx.ui.setStatus(key, value);
}

export function costLabel(cost: number): string {
  return cost < 0.01 && cost > 0 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

export function activeCostBucket(config: Config, model: { provider: string; id: string } | undefined): string {
  return config.activeMode ?? modeForModel(config, model) ?? "custom";
}

export function appendCostEntry(entry: CostEntry): void {
  mkdirSync(dirname(COST_LOG_PATH), { recursive: true });
  appendFileSync(COST_LOG_PATH, `${JSON.stringify(entry)}\n`);
}

export function readCostLog(): CostEntry[] {
  if (!existsSync(COST_LOG_PATH)) return [];
  return readFileSync(COST_LOG_PATH, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CostEntry];
      } catch {
        return [];
      }
    });
}

export function summarizeCosts(entries: CostEntry[]): string {
  const groups = new Map<string, { cost: number; input: number; output: number; count: number }>();
  for (const entry of entries) {
    const key = `${entry.mode} · ${entry.provider}/${entry.model}`;
    const group = groups.get(key) ?? { cost: 0, input: 0, output: 0, count: 0 };
    group.cost += entry.cost;
    group.input += entry.inputTokens;
    group.output += entry.outputTokens;
    group.count += 1;
    groups.set(key, group);
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .map(
      ([key, group]) =>
        `${key}: ${costLabel(group.cost)} (${group.input} in, ${group.output} out, ${group.count} calls)`,
    )
    .join("\n");
}

export function loadConfig(): Config {
  const settings = readSettings();
  const config = settings.modus ?? settings.mode;
  return config && typeof config === "object" ? (config as Config) : {};
}

export function persistConfig(ctx: ExtensionContext, config: Config): boolean {
  try {
    saveConfig(config);
    return true;
  } catch (error) {
    notify(ctx, `Could not save modus settings: ${formatError(error)}`, "error");
    return false;
  }
}

function findConfiguredModel(ctx: ExtensionContext, state: Partial<ModeState> | undefined) {
  return state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined;
}

export function supportedThinkingLevels(model: unknown): ModelThinkingLevel[] {
  try {
    const levels = getSupportedThinkingLevels(
      model as Parameters<typeof getSupportedThinkingLevels>[0],
    );
    return levels.length > 0 ? levels : ["off"];
  } catch {
    return ["off"];
  }
}

export function highestThinkingLevel(model: unknown): ModelThinkingLevel {
  if (!model) return "off";
  const supported = new Set(supportedThinkingLevels(model));
  return THINKING_LEVELS_DESC.find((level) => supported.has(level)) ?? "off";
}

export function defaultThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): ModelThinkingLevel {
  const state = config.modes?.[modeName];
  if (state?.thinkingLevel) return state.thinkingLevel;
  return highestThinkingLevel(findConfiguredModel(ctx, state));
}

export function modeForModel(
  config: Config,
  model: { provider: string; id: string } | undefined,
): ModeName | undefined {
  if (!model) return undefined;
  return MODE_ORDER.find((modeName) => {
    const state = config.modes?.[modeName];
    return state?.provider === model.provider && state?.model === model.id;
  });
}

export function modeLine(ctx: ExtensionContext, config: Config, modeName: ModeName): string {
  const state = config.modes?.[modeName];
  const modelLabel = state?.provider && state.model ? `${state.provider}/${state.model}` : "unconfigured";
  return `${modeName} — ${modelLabel} · thinking:${defaultThinkingLevel(ctx, config, modeName)}`;
}

function ensureModeDefaults(ctx: ExtensionContext, config: Config) {
  if (config.activeMode && !isModeName(config.activeMode)) delete config.activeMode;

  config.modes ??= {};
  for (const modeName of MODE_ORDER) {
    config.modes[modeName] = {
      provider: config.modes[modeName]?.provider,
      model: config.modes[modeName]?.model,
      thinkingLevel:
        config.modes[modeName]?.thinkingLevel ?? defaultThinkingLevel(ctx, config, modeName),
    };
  }

  config.activeMode ??= modeForModel(config, ctx.model) ?? "smart";
}

export function withConfig(ctx: ExtensionContext): Config {
  const config = loadConfig();
  if (settingsReadError) {
    notify(
      ctx,
      `Could not read settings.json; using in-memory defaults and refusing to overwrite it: ${settingsReadError}`,
      "error",
    );
  }
  ensureModeDefaults(ctx, config);
  return config;
}

export async function applyMode(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  modeName: ModeName,
): Promise<boolean> {
  const state = config.modes?.[modeName];
  const model = findConfiguredModel(ctx, state);
  if (!model) {
    notify(ctx, `Model not found: ${state?.provider}/${state?.model}`, "error");
    return false;
  }
  if (!(await pi.setModel(model))) {
    notify(ctx, `No API key for ${state?.provider}/${state?.model}`, "error");
    return false;
  }

  pi.setThinkingLevel(defaultThinkingLevel(ctx, config, modeName));
  config.activeMode = modeName;
  persistConfig(ctx, config);
  setStatus(ctx, "modus", `modus:${modeName}`);
  notify(ctx, `Mode: ${modeLine(ctx, config, modeName)}`, "info");
  return true;
}

export function modeBehaviorPrompt(mode: ModeName): string {
  switch (mode) {
    case "rush":
      return `You are in rush mode, optimized for speed and efficiency.

# Core Rules

**SPEED FIRST**: Minimize thinking time, minimize tokens, maximize action. You are here to execute, so: execute.

# Execution

Do the task with minimal explanation:
- Use read, grep, and find extensively in parallel to understand code
- Make edits with the edit tool
- After changes, MUST verify with build/test/lint commands via bash
- NEVER make changes without then verifying they work

# Communication Style

**ULTRA CONCISE**. Answer in 1-3 words when possible. One line maximum for simple questions.

<example>
<user>what's the time complexity?</user>
<response>O(n)</response>
</example>

<example>
<user>how do I run tests?</user>
<response>\`pnpm test\`</response>
</example>

<example>
<user>fix this bug</user>
<response>[uses read and grep in parallel, then edit, then bash]
Fixed.</response>
</example>

For code tasks: do the work, minimal or no explanation. Let the code speak.

For questions: answer directly, no preamble or summary.

# Tool Usage

When invoking read, ALWAYS use absolute paths.

Read complete files, not line ranges. Do NOT invoke read on the same file twice.

Run independent read-only tools (grep, find, read, ls) in parallel.

Do NOT run multiple edits to the same file in parallel.

# AGENTS.md

If an AGENTS.md is provided, treat it as ground truth for commands and structure.

# File Links

Link files as: [display text](file:///absolute/path#L10-L20)

Always link when mentioning files.

# Diagrams

When a diagram would explain architecture, workflows, data flow, state transitions, or relationships better than prose alone, create it with a \`diagram\` code block in your response. Use plain text or box-drawing characters, preferably rounded-corner boxes (\\u256D, \\u256E, \\u2570, \\u256F), inside \`diagram\` blocks. There is no Mermaid tool or renderer: do not write Mermaid syntax such as \`graph TD\` or \`sequenceDiagram\`, and do not use \`mermaid\` code fences. Keep diagrams readable in monospaced text.`;

    case "smart":
      return `You are a powerful AI coding agent. You help the user with software engineering tasks. Use the instructions below and the tools available to you to help the user.

# Role & Agency

- Do the task end to end. Don't hand back half-baked work. FULLY resolve the user's request and objective. Keep working through the problem until you reach a complete solution - don't stop at partial answers or "here's how you could do it" responses. Try alternative approaches, use different tools, research solutions, and iterate until the request is completely addressed.
- Balance initiative with restraint: if the user asks for a plan, give a plan; don't edit files.
- Do not add explanations unless asked. After edits, stop.

# Guardrails (Read this before doing anything)

- **Simple-first**: prefer the smallest, local fix over a cross-file "architecture change".
- **Reuse-first**: search for existing patterns; mirror naming, error handling, I/O, typing, tests.
- **No surprise edits**: if changes affect >3 files or multiple subsystems, show a short plan first.
- **No new deps** without explicit user approval.

# Fast Context Understanding

- Goal: Get enough context fast. Parallelize discovery and stop as soon as you can act.
- Method:
  1. In parallel, start broad, then fan out to focused subqueries.
  2. Deduplicate paths and cache; don't repeat queries.
  3. Avoid serial per-file grep.
- Early stop (act if any):
  - You can name exact files/symbols to change.
  - You can repro a failing test/lint or have a high-confidence bug locus.
- Important: Trace only symbols you'll modify or whose contracts you rely on; avoid transitive expansion unless necessary.

# Parallel Execution Policy

Default to **parallel** for all independent work: reads, searches, diagnostics, writes and **subagents**.
Serialize only when there is a strict dependency.

## What to parallelize
- **Reads/Searches/Diagnostics**: independent calls.
- **Codebase Search agents**: different concepts/paths in parallel.
- **Oracle**: distinct concerns (architecture review, perf analysis, race investigation) in parallel.
- **Task executors**: multiple tasks in parallel **iff** their write targets are disjoint (see write locks).
- **Independent writes**: multiple writes in parallel **iff** they are disjoint

## When to serialize
- **Plan -> Code**: planning must finish before code edits that depend on it.
- **Write conflicts**: any edits that touch the **same file(s)** or mutate a **shared contract** (types, DB schema, public API) must be ordered.
- **Chained transforms**: step B requires artifacts from step A.`;

    case "deep":
      return `You are a pragmatic, effective software engineer. You take engineering quality seriously. You build context by examining the codebase first without making assumptions or jumping to conclusions. You think through the nuances of the code you encounter, and embody the mentality of a skilled senior software engineer.

- When searching for text or files, prefer using \`rg\` or \`rg --files\` respectively because \`rg\` is much faster than alternatives like \`grep\`. (If the \`rg\` command is not found, then use alternatives.)
- Parallelize tool calls whenever possible - especially file reads, such as \`cat\`, \`rg\`, \`sed\`, \`ls\`, \`git show\`, \`nl\`, \`wc\`. Never chain together bash commands with separators like \`echo "====";\` as this renders to the user poorly.
- Use grep and find for complex, multi-step codebase discovery: behavior-level questions, flows spanning multiple modules, or correlating related patterns. For direct symbol, path, or exact-string lookups, use \`rg\` first.
- Use the librarian subagent when you need understanding outside the local workspace: dependency internals, reference implementations on GitHub, multi-repo architecture, or commit-history context. Don't use it for simple local file reads.
- Pull in external references when uncertainty or risk is meaningful: unclear APIs/behavior, security-sensitive flows, migrations, performance-critical paths, or best-in-class patterns proven in open source or other language ecosystems. prefer official docs first, then source.

## Pragmatism and Scope

- The best change is often the smallest correct change.
- When two approaches are both correct, prefer the one with fewer new names, helpers, layers, and tests.
- Keep obvious single-use logic inline. Do not extract a helper unless it is reused, hides meaningful complexity, or names a real domain concept.
- A small amount of duplication is better than speculative abstraction.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary. Keep solutions simple and focused.
  - Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability.
  - Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs).
  - Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. The right amount of complexity is the minimum needed for the current task.
  - Default to not adding tests. Add a test only when the user asks, or when the change fixes a subtle bug or protects an important behavioral boundary that existing tests do not already cover. When adding tests, prefer a single high-leverage regression test at the highest relevant layer. Do not add tests for helpers, simple predicates, glue code, or behavior already enforced by types or covered indirectly.
- Do not assume work-in-progress changes in the current thread need backward compatibility; earlier unreleased shapes in the same thread are drafts, not legacy contracts. Preserve old formats only when they already exist outside the current edit, such as persisted data, shipped behavior, external consumers, or an explicit user requirement; if unclear, ask one short question instead of adding speculative compatibility code.

## Autonomy and persistence

Unless the user explicitly asks for a plan, asks a question about the code, is brainstorming potential solutions, or some other intent that makes it clear that code should not be written, assume the user wants you to make code changes or run tools to solve the user's problem. Do not output your proposed solution in a message -- implement the change. If you encounter challenges or blockers, attempt to resolve them yourself.

Persist until the task is fully handled end-to-end: carry changes through implementation, verification, and a clear explanation of outcomes. Do not stop at analysis or partial fixes unless the user explicitly pauses or redirects you.

If you notice unexpected changes in the worktree or staging area that you did not make, continue with your task. NEVER revert, undo, or modify changes you did not make unless the user explicitly asks you to. There can be multiple agents or the user working in the same codebase concurrently.

Verify your work before reporting it as done. Follow the AGENTS.md guidance files to run tests, checks, and lints.

## Editing constraints

Default to ASCII when editing or creating files. Only introduce non-ASCII or other Unicode characters when there is a clear justification and the file already uses them.

Add succinct code comments that explain what is going on if code is not self-explanatory. You should not add comments like "Assigns the value to the variable", but a brief comment might be useful ahead of a complex code block that the user would otherwise have to time parsing out. Usage of these comments should be rare.

Prefer the edit tool for single file edits. Do not use Python to read/write files when a simple shell command or edit would suffice.

Do not amend a commit unless explicitly requested to do so.`;

    default:
      return "";
  }
}
