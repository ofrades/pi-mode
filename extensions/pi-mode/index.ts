import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import {
  complete,
  getSupportedThinkingLevels,
  type Message,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";

type ModeName = "rush" | "smart" | "deep";
type RouteName = "vision" | "handoff" | "search" | "review" | "oracle" | "librarian";

type ModeState = {
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
};

type RouteState = ModeState & {
  description?: string;
  restore?: boolean;
};

type Config = {
  activeMode?: ModeName;
  modes?: Partial<Record<ModeName, Partial<ModeState>>>;
  routing?: {
    enabled?: boolean;
    activeRoute?: RouteName;
    previous?: ModeState;
    routes?: Partial<Record<RouteName, Partial<RouteState>>>;
  };
};

const MODE_ORDER: ModeName[] = ["rush", "smart", "deep"];
const ROUTE_ORDER: RouteName[] = ["vision", "handoff", "search", "review", "oracle", "librarian"];

const ROUTE_METADATA: Record<
  RouteName,
  { description: string; recommendedModel: string; restore: boolean }
> = {
  vision: {
    description:
      "Image, screenshot, PDF, and media understanding; use when prompts include /tmp/pi-clipboard images or image reads.",
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

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_ANALYSIS_SYSTEM_PROMPT = `You are an image/media analysis assistant for a Pi coding session.

Analyze the supplied image for the parent agent. If it contains text, transcribe the important text exactly. If it is a UI screenshot, identify controls, errors, states, and likely user intent. Be concise, concrete, and say when details are uncertain.`;

// Ordered from highest to lowest — used to pick the best available level.
const THINKING_LEVELS_DESC: ModelThinkingLevel[] = [
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

const SETTINGS_PATH = join(getAgentDir(), "settings.json");

// --- Config persistence ---

function readSettings(): Record<string, unknown> {
  try {
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

function loadConfig(): Config {
  const settings = readSettings();
  const config = settings.mode ?? settings.modelMode;
  return config && typeof config === "object" ? (config as Config) : {};
}

function saveConfig(config: Config) {
  const settings = readSettings();
  settings.mode = config;
  delete settings.modelMode;
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// --- Model / thinking helpers ---

function supportedThinkingLevels(model: unknown): ModelThinkingLevel[] {
  try {
    const levels = getSupportedThinkingLevels(
      model as Parameters<typeof getSupportedThinkingLevels>[0],
    );
    return levels.length > 0 ? levels : ["off"];
  } catch {
    return [...THINKING_LEVELS_DESC].reverse() as ModelThinkingLevel[];
  }
}

function highestThinkingLevel(model: unknown): ModelThinkingLevel {
  const supported = new Set(supportedThinkingLevels(model));
  return THINKING_LEVELS_DESC.find((l) => supported.has(l)) ?? "off";
}

function defaultThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): ModelThinkingLevel {
  const state = config.modes?.[modeName];
  if (state?.thinkingLevel) return state.thinkingLevel;
  return highestThinkingLevel(ctx.modelRegistry.find(state?.provider, state?.model));
}

function modeForModel(
  config: Config,
  model: { provider: string; id: string } | undefined,
): ModeName | undefined {
  if (!model) return undefined;
  return MODE_ORDER.find((m) => {
    const s = config.modes?.[m];
    return s?.provider === model.provider && s?.model === model.id;
  });
}

function modeLine(ctx: ExtensionContext, config: Config, modeName: ModeName): string {
  const s = config.modes?.[modeName];
  return `${modeName} — ${s?.provider}/${s?.model} · thinking:${defaultThinkingLevel(ctx, config, modeName)}`;
}

function resolveRouteState(config: Config, routeName: RouteName): RouteState {
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

// --- Defaults / init ---

function ensureModeDefaults(ctx: ExtensionContext, config: Config) {
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

function withConfig(ctx: ExtensionContext, config: Config) {
  config = loadConfig();
  ensureModeDefaults(ctx, config);
  return config;
}

// --- Mode / route application ---

async function applyMode(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  modeName: ModeName,
): Promise<boolean> {
  const state = config.modes?.[modeName];
  const model = ctx.modelRegistry.find(state?.provider, state?.model);
  if (!model) {
    ctx.ui.notify(`Model not found: ${state?.provider}/${state?.model}`, "error");
    return false;
  }
  if (!(await pi.setModel(model))) {
    ctx.ui.notify(`No API key for ${state?.provider}/${state?.model}`, "error");
    return false;
  }
  pi.setThinkingLevel(defaultThinkingLevel(ctx, config, modeName));
  config.activeMode = modeName;
  saveConfig(config);
  ctx.ui.setStatus("mode", `mode:${modeName}`);
  ctx.ui.notify(`Mode: ${modeLine(ctx, config, modeName)}`, "info");
  return true;
}

async function applyRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
  routeName: RouteName,
): Promise<boolean> {
  if (config.routing?.enabled === false) return false;
  const state = resolveRouteState(config, routeName);
  const model = ctx.modelRegistry.find(state.provider, state.model);
  if (!model) return false;
  if (ctx.model) {
    config.routing ??= {};
    config.routing.previous = { provider: ctx.model.provider, model: ctx.model.id };
  }
  if (!(await pi.setModel(model))) return false;
  pi.setThinkingLevel(state.thinkingLevel ?? "off");
  config.routing ??= {};
  config.routing.activeRoute = routeName;
  saveConfig(config);
  ctx.ui.setStatus("route", `route:${routeName}`);
  return true;
}

async function restoreRoute(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<boolean> {
  const prev = config.routing?.previous;
  if (prev?.provider && prev.model) {
    const model = ctx.modelRegistry.find(prev.provider, prev.model);
    if (model && (await pi.setModel(model))) {
      delete config.routing?.activeRoute;
      delete config.routing?.previous;
      saveConfig(config);
      ctx.ui.setStatus("route", "");
      return true;
    }
  }
  const ok = await applyMode(
    ctx,
    pi,
    config,
    config.activeMode ?? modeForModel(config, ctx.model) ?? "smart",
  );
  if (ok) ctx.ui.setStatus("route", "");
  return ok;
}

// --- Vision ---

async function analyzeImageWithRoute(
  ctx: ExtensionContext,
  config: Config,
  imagePath: string,
  prompt: string,
): Promise<string> {
  const route = resolveRouteState(config, "vision");
  if (!route.provider || !route.model)
    throw new Error(`Vision route is not configured with provider/model. ${route.description}`);

  const model = ctx.modelRegistry.find(route.provider, route.model);
  if (!model) throw new Error(`Vision model not found: ${route.provider}/${route.model}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey)
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);

  const absolutePath = resolve(ctx.cwd, imagePath.replace(/^@/, ""));
  const mediaType = IMAGE_MEDIA_TYPES[extname(absolutePath).toLowerCase()];
  if (!mediaType) throw new Error("Unsupported image type. Use png, jpg, jpeg, gif, or webp.");

  const data = await readFile(absolutePath, { encoding: "base64" });
  const message: Message = {
    role: "user",
    content: [
      { type: "text", text: prompt || "Analyze this image and summarize the important details." },
      { type: "image", data, mimeType: mediaType },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: IMAGE_ANALYSIS_SYSTEM_PROMPT, messages: [message] },
    { apiKey: auth.apiKey, headers: auth.headers },
  );

  if (response instanceof Error) throw new Error(`Vision model error: ${response.message}`);
  if (response.errorMessage)
    throw new Error(`Vision model returned error: ${response.errorMessage}`);

  const texts = (response.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text);

  if (texts.length === 0) {
    const types = (response.content ?? []).map((c: any) => c.type).join(", ");
    throw new Error(
      `Vision model returned no text. Content types: ${types}. stopReason=${response.stopReason}`,
    );
  }

  return texts.join("\n");
}

// --- UI ---

async function pickThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<ModelThinkingLevel | undefined> {
  const state = config.modes?.[modeName];
  const model = ctx.modelRegistry.find(state?.provider, state?.model);
  const current = defaultThinkingLevel(ctx, config, modeName);
  const levels = [current, ...supportedThinkingLevels(model).filter((l) => l !== current)];
  const labels = levels.map((l) => (l === current ? `${l} [current]` : l));
  const selected = await ctx.ui.select(`Thinking for ${modeName}`, labels);
  return selected ? levels[labels.indexOf(selected)] : undefined;
}

async function pickModel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<{ provider: string; model: string } | undefined> {
  const state = config.modes?.[modeName];
  const currentModel = ctx.modelRegistry.find(state?.provider, state?.model) ?? ctx.model;
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());

  const selected = await ctx.ui.custom<import("@earendil-works/pi-ai").Model<any> | null>(
    (tui, _theme, _kb, done) =>
      new ModelSelectorComponent(
        tui,
        currentModel,
        settingsManager,
        ctx.modelRegistry,
        [],
        (m) => done(m),
        () => done(null),
      ),
  );

  return selected ? { provider: selected.provider, model: selected.id } : undefined;
}

async function showModeSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<void> {
  let selectedIndex = Math.max(
    0,
    MODE_ORDER.indexOf(config.activeMode ?? modeForModel(config, ctx.model) ?? "smart"),
  );

  while (true) {
    const result = await ctx.ui.custom<{
      action: "confirm" | "thinking" | "model" | "routing" | "cancel";
      modeName: ModeName;
    }>((tui, theme, _kb, done) => ({
      render(_width: number) {
        const routing = config.routing?.enabled ? "on" : "off";
        const lines: string[] = [theme.fg("accent", theme.bold(`Mode · routing:${routing}`))];
        for (const [i, name] of MODE_ORDER.entries()) {
          const line = `${i === selectedIndex ? "→ " : "  "}${modeLine(ctx, config, name)}${name === config.activeMode ? " [active]" : ""}`;
          lines.push(i === selectedIndex ? theme.fg("accent", line) : line);
        }
        lines.push(
          theme.fg(
            "dim",
            "↑↓/j/k choose • Enter apply • t thinking • c model • r routing • Esc cancel",
          ),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const modeName = MODE_ORDER[selectedIndex];
        if (data === "\r" || data === "\n") done({ action: "confirm", modeName });
        else if (data === "t" || data === "T") done({ action: "thinking", modeName });
        else if (data === "c" || data === "C") done({ action: "model", modeName });
        else if (data === "r" || data === "R") done({ action: "routing", modeName });
        else if (data === "\u001b[A" || data === "k") {
          selectedIndex = (selectedIndex - 1 + MODE_ORDER.length) % MODE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b[B" || data === "j") {
          selectedIndex = (selectedIndex + 1) % MODE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b" || data.startsWith("\u001b"))
          done({ action: "cancel", modeName });
      },
    }));

    if (result.action === "cancel") return;
    selectedIndex = MODE_ORDER.indexOf(result.modeName);

    if (result.action === "routing") {
      config.routing ??= {};
      config.routing.enabled = !(config.routing.enabled ?? true);
      saveConfig(config);
      ctx.ui.notify(`Task routing ${config.routing.enabled ? "enabled" : "disabled"}`, "info");
    } else if (result.action === "thinking") {
      const level = await pickThinkingLevel(ctx, config, result.modeName);
      if (level) {
        config.modes ??= {};
        config.modes[result.modeName] = { ...config.modes[result.modeName], thinkingLevel: level };
        saveConfig(config);
      }
    } else if (result.action === "model") {
      const model = await pickModel(ctx, config, result.modeName);
      if (model) {
        config.modes ??= {};
        config.modes[result.modeName] = {
          ...config.modes[result.modeName],
          provider: model.provider,
          model: model.model,
        };
        saveConfig(config);
      }
    } else {
      await applyMode(ctx, pi, config, result.modeName);
      return;
    }
  }
}

// --- Extension entry point ---

export default function modeExtension(pi: ExtensionAPI) {
  let config = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    config = withConfig(ctx, config);
    saveConfig(config);
    ctx.ui.setStatus(
      "mode",
      `mode:${config.activeMode ?? modeForModel(config, ctx.model) ?? "custom"}`,
    );
  });

  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle model mode forward",
    handler: async (ctx) => {
      config = withConfig(ctx, config);
      const current = config.activeMode ?? modeForModel(config, ctx.model) ?? "smart";
      await applyMode(
        ctx,
        pi,
        config,
        MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length],
      );
    },
  });

  pi.registerTool({
    name: "analyze_media",
    label: "Analyze Media",
    description:
      "Analyze an image/media file inline using the configured vision route and return text findings to the current model. Use this for /tmp/pi-clipboard image paths, screenshots, and image files when the active model may not have vision.",
    promptSnippet:
      "Use analyze_media for image/screenshot/media paths (especially /tmp/pi-clipboard*.png) instead of plain read when the active model may not support vision. It calls the configured vision route inline and returns text analysis.",
    promptGuidelines: [
      "Use analyze_media when the user asks about an image, screenshot, or /tmp/pi-clipboard image path; it returns text analysis that non-vision models can use in the same turn.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image/media file to analyze" }),
      prompt: Type.Optional(
        Type.String({ description: "Question or focus for the image analysis" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = withConfig(ctx, config);
      if (config.routing?.enabled === false)
        return {
          content: [
            {
              type: "text",
              text: "Task routing is disabled. Use /mode routing on to enable analyze_media.",
            },
          ],
          isError: true,
        };
      try {
        const text = await analyzeImageWithRoute(ctx, config, params.path, params.prompt ?? "");
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "task_model",
    label: "Task Model",
    description:
      "Task-aware model router. List, switch to, or restore from hidden task profiles such as vision, handoff, search, review, oracle, and librarian. Use before tasks that need specific capabilities, especially images or /tmp/pi-clipboard image paths.",
    promptSnippet:
      "Use task_model to switch inline before specialized work: vision/look-at/image for images or /tmp/pi-clipboard paths; handoff for context transfer; search for retrieval; review for code review; oracle for hard planning; librarian for external docs/dependency research. Respect routing disabled state.",
    promptGuidelines: [
      "Use task_model with action='switch' and task='vision' before analyzing image paths, screenshots, media, or prompts containing /tmp/pi-clipboard image files when the current model may lack vision.",
      "Use task_model with action='switch' for handoff, search, review, oracle, or librarian tasks when the configured task model better fits the work; use action='restore' after the specialized work when appropriate.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("switch"),
        Type.Literal("restore"),
        Type.Literal("status"),
      ]),
      task: Type.Optional(
        Type.Union(
          ROUTE_ORDER.map((name) => Type.Literal(name)) as [
            ReturnType<typeof Type.Literal>,
            ...ReturnType<typeof Type.Literal>[],
          ],
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = withConfig(ctx, config);
      const routingEnabled = config.routing?.enabled !== false;

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text: `Task routing is ${routingEnabled ? "enabled" : "disabled"}.${config.routing?.activeRoute ? ` Active route: ${config.routing.activeRoute}.` : ""}`,
            },
          ],
        };
      }

      if (params.action === "list") {
        const lines = ROUTE_ORDER.map((r) => {
          const s = resolveRouteState(config, r);
          const configured = s.provider && s.model ? `${s.provider}/${s.model}` : "unconfigured";
          return `- ${r}: ${configured}${s.thinkingLevel ? ` · thinking:${s.thinkingLevel}` : ""} · ${s.description}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `Task routing: ${routingEnabled ? "enabled" : "disabled"}\n${lines.join("\n")}`,
            },
          ],
        };
      }

      if (params.action === "restore") {
        const ok = await restoreRoute(ctx, pi, config);
        return {
          content: [
            {
              type: "text",
              text: ok ? "Restored previous/main model." : "Could not restore previous/main model.",
            },
          ],
          isError: !ok,
        };
      }

      const task = params.task as RouteName | undefined;
      if (!task || !ROUTE_ORDER.includes(task))
        return {
          content: [
            { type: "text", text: `task is required. Use one of: ${ROUTE_ORDER.join(", ")}` },
          ],
          isError: true,
        };
      if (!routingEnabled)
        return {
          content: [
            { type: "text", text: "Task routing is disabled. Use /mode and press r to enable it." },
          ],
          isError: true,
        };

      const route = resolveRouteState(config, task);
      if (!route.provider || !route.model)
        return {
          content: [
            {
              type: "text",
              text: `Route "${task}" is not configured with provider/model in settings. ${route.description}`,
            },
          ],
          isError: true,
        };

      const ok = await applyRoute(ctx, pi, config, task);
      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Switched to ${task}: ${route.provider}/${route.model} · thinking:${route.thinkingLevel}. Restore after the specialized task if appropriate.`
              : `Failed to switch to ${task}: ${route.provider}/${route.model}`,
          },
        ],
        isError: !ok,
      };
    },
  });

  pi.registerCommand("mode", {
    description: "Select or configure rush/smart/deep mode",
    getArgumentCompletions: (prefix) => {
      const first = prefix.trimStart().split(/\s+/)[0] ?? "";
      return [...MODE_ORDER, "routing"]
        .filter((n) => n.startsWith(first))
        .map((n) => ({ value: n, label: n }));
    },
    handler: async (args, ctx) => {
      config = withConfig(ctx, config);
      const [firstArg, secondArg] = args.trim().split(/\s+/);

      if (firstArg === "routing") {
        config.routing ??= {};
        if (secondArg === "on") config.routing.enabled = true;
        else if (secondArg === "off") config.routing.enabled = false;
        else config.routing.enabled = !(config.routing.enabled ?? true);
        saveConfig(config);
        ctx.ui.notify(`Task routing ${config.routing.enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (firstArg) {
        if (!MODE_ORDER.includes(firstArg as ModeName)) {
          ctx.ui.notify(
            `Unknown mode "${firstArg}". Use: ${MODE_ORDER.join(", ")} or routing [on|off].`,
            "error",
          );
          return;
        }
        await applyMode(ctx, pi, config, firstArg as ModeName);
        return;
      }

      await showModeSelector(ctx, pi, config);
    },
  });
}
