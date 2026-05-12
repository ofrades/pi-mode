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

export type TurnEntry = {
  turnId: string;
  timestamp: number;
  provider: string;
  model: string;
  thinkingLevel: ModelThinkingLevel;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  autoRouted: boolean;
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

  settings.mode = config;
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

function jsonlDate(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function turnLogPath(cwd: string, timestamp = Date.now()): string {
  return join(cwd, ".pi-agent", `session-${jsonlDate(timestamp)}.jsonl`);
}

export function appendTurnEntry(cwd: string, entry: TurnEntry): void {
  const path = turnLogPath(cwd, entry.timestamp);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function readTurnLog(cwd: string, timestamp = Date.now()): TurnEntry[] {
  const path = turnLogPath(cwd, timestamp);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\n+/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TurnEntry];
      } catch {
        return [];
      }
    });
}

export function formatTurnLog(entries: TurnEntry[]): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      return `${time} ${entry.provider}/${entry.model} thinking:${entry.thinkingLevel} ${costLabel(entry.cost)} (${entry.promptTokens}→${entry.completionTokens}, ${entry.durationMs}ms)`;
    })
    .join("\n");
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
  const config = settings.mode;
  return config && typeof config === "object" ? (config as Config) : {};
}

export function persistConfig(ctx: ExtensionContext, config: Config): boolean {
  try {
    saveConfig(config);
    return true;
  } catch (error) {
    notify(ctx, `Could not save mode settings: ${formatError(error)}`, "error");
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
  setStatus(ctx, "mode", `mode:${modeName}`);
  notify(ctx, `Mode: ${modeLine(ctx, config, modeName)}`, "info");
  return true;
}
