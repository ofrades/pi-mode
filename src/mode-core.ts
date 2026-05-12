import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";

export type ModeName = "rush" | "smart" | "deep";
export type RouteName = "vision" | "handoff" | "search" | "review" | "oracle" | "librarian";

export type ModeState = {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
};

export type RouteState = ModeState & {
  description?: string;
  restore?: boolean;
};

export type Config = {
  activeMode?: ModeName;
  modes?: Partial<Record<ModeName, Partial<ModeState>>>;
  routing?: {
    enabled?: boolean;
    activeRoute?: RouteName;
    previous?: ModeState;
    routes?: Partial<Record<RouteName, Partial<RouteState>>>;
  };
};

export const MODE_ORDER: ModeName[] = ["rush", "smart", "deep"];
export const ROUTE_ORDER: RouteName[] = ["vision", "handoff", "search", "review", "oracle", "librarian"];

export function isModeName(value: string): value is ModeName {
  return (MODE_ORDER as readonly string[]).includes(value);
}

export function isRouteName(value: string): value is RouteName {
  return (ROUTE_ORDER as readonly string[]).includes(value);
}

const ROUTE_METADATA: Record<
  RouteName,
  { description: string; recommendedModel: string; restore: boolean }
> = {
  vision: {
    description: "Image and screenshot understanding; use when prompts include image paths or image reads.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  handoff: {
    description: "Compact context transfer and continuation prompts.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  search: {
    description: "Fast retrieval-oriented codebase search and context gathering.",
    recommendedModel: "Gemini 3 Flash",
    restore: true,
  },
  review: {
    description: "Code review, bug finding, regression/security/maintainability checks.",
    recommendedModel: "Gemini 3.1 Pro",
    restore: true,
  },
  oracle: {
    description: "Complex reasoning, planning, consistency checks, and architectural tradeoffs.",
    recommendedModel: "GPT-5.4",
    restore: true,
  },
  librarian: {
    description: "External docs, dependencies, APIs, and unfamiliar library research.",
    recommendedModel: "Claude Sonnet 4.6",
    restore: true,
  },
};

const THINKING_LEVELS_DESC: ModelThinkingLevel[] = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

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
  delete settings.modelMode;
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

export function loadConfig(): Config {
  const settings = readSettings();
  const config = settings.mode ?? settings.modelMode;
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
  return highestThinkingLevel(ctx.modelRegistry.find(state?.provider, state?.model));
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

export function resolveRouteState(config: Config, routeName: RouteName): RouteState {
  const meta = ROUTE_METADATA[routeName];
  const route = config.routing?.routes?.[routeName];
  return {
    provider: route?.provider,
    model: route?.model,
    thinkingLevel: route?.thinkingLevel,
    description:
      route?.description ?? `${meta.description} Recommended model: ${meta.recommendedModel}.`,
    restore: route?.restore ?? meta.restore,
  };
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
  config.routing ??= {};
  if (config.routing.activeRoute && !isRouteName(config.routing.activeRoute)) {
    delete config.routing.activeRoute;
  }

  config.routing.enabled ??= false;
  config.routing.routes ??= {};
  for (const routeName of ROUTE_ORDER) {
    const existing = config.routing.routes[routeName] ?? {};
    const resolved = resolveRouteState(config, routeName);
    config.routing.routes[routeName] = {
      ...existing,
      description: resolved.description,
      restore: resolved.restore,
    };
  }
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
  const model = ctx.modelRegistry.find(state?.provider, state?.model);
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
  delete config.routing?.activeRoute;
  delete config.routing?.previous;
  persistConfig(ctx, config);
  setStatus(ctx, "mode", `mode:${modeName}`);
  setStatus(ctx, "route", undefined);
  notify(ctx, `Mode: ${modeLine(ctx, config, modeName)}`, "info");
  return true;
}

export async function applyRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  routeName: RouteName,
): Promise<boolean> {
  if (config.routing?.enabled === false) return false;
  const state = resolveRouteState(config, routeName);
  const model = ctx.modelRegistry.find(state.provider, state.model);
  if (!model) return false;

  config.routing ??= {};
  if (ctx.model && !config.routing.previous) {
    config.routing.previous = {
      provider: ctx.model.provider,
      model: ctx.model.id,
      thinkingLevel: pi.getThinkingLevel(),
    };
  }

  if (!(await pi.setModel(model))) return false;
  pi.setThinkingLevel(state.thinkingLevel ?? highestThinkingLevel(model));
  config.routing.activeRoute = routeName;
  persistConfig(ctx, config);
  setStatus(ctx, "route", `route:${routeName}`);
  return true;
}

export async function restoreRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<boolean> {
  const prev = config.routing?.previous;
  if (prev?.provider && prev.model) {
    const model = ctx.modelRegistry.find(prev.provider, prev.model);
    if (model && (await pi.setModel(model))) {
      pi.setThinkingLevel(prev.thinkingLevel ?? highestThinkingLevel(model));
      delete config.routing?.activeRoute;
      delete config.routing?.previous;
      persistConfig(ctx, config);
      setStatus(ctx, "route", undefined);
      return true;
    }
  }

  const ok = await applyMode(
    ctx,
    pi,
    config,
    config.activeMode ?? modeForModel(config, ctx.model) ?? "smart",
  );
  if (ok) setStatus(ctx, "route", undefined);
  return ok;
}
