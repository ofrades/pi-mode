import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key, truncateToWidth } from "@earendil-works/pi-tui";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  activeCostBucket,
  appendCostEntry,
  applyMode,
  costLabel,
  defaultThinkingLevel,
  highestThinkingLevel,
  isModeName,
  loadConfig,
  MODE_ORDER,
  modeBehaviorPrompt,
  modeForModel,
  modeLine,
  notify,
  persistConfig,
  readCostLog,
  setStatus,
  summarizeCosts,
  supportedThinkingLevels,
  withConfig,
  type Config,
  type CostEntry,
  type ModeName,
} from "../src/mode-core.ts";
import {
  handleSubagentsCommand,
  loadSubagentsConfig,
  persistSubagentsConfig,
  registerSubagentTools,
  SUBAGENT_ORDER,
  SUBAGENT_METADATA,
  subagentsPrompt,
  type SubagentName,
} from "../src/subagents.ts";

async function pickThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<ModelThinkingLevel | undefined> {
  const state = config.modes?.[modeName];
  const model = state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined;
  const current = defaultThinkingLevel(ctx, config, modeName);
  const levels = [current, ...supportedThinkingLevels(model).filter((level) => level !== current)];
  const labels = levels.map((level) => (level === current ? `${level} [current]` : level));
  const selected = await ctx.ui.select(`Thinking for ${modeName}`, labels);
  return selected ? levels[labels.indexOf(selected)] : undefined;
}

async function pickAnyModel(
  ctx: ExtensionContext,
  currentModel: import("@earendil-works/pi-ai").Model<any> | undefined,
): Promise<{ provider: string; model: string } | undefined> {
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());

  const selected = await ctx.ui.custom<import("@earendil-works/pi-ai").Model<any> | null>(
    (tui, _theme, _kb, done) =>
      new ModelSelectorComponent(
        tui,
        currentModel ?? ctx.model,
        settingsManager,
        ctx.modelRegistry,
        [],
        (model) => done(model),
        () => done(null),
      ),
  );

  return selected ? { provider: selected.provider, model: selected.id } : undefined;
}

async function pickModel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<{ provider: string; model: string } | undefined> {
  const state = config.modes?.[modeName];
  const currentModel =
    (state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined) ??
    ctx.model;
  return pickAnyModel(ctx, currentModel);
}

function subagentLine(ctx: ExtensionContext, name: SubagentName): string {
  const subagents = loadSubagentsConfig();
  const state = subagents[name];
  const model = state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined;
  const modelLabel = state ? `${state.provider}/${state.model}` : "unconfigured";
  const thinking = state?.thinkingLevel ?? highestThinkingLevel(model);
  return `${name} — ${modelLabel} · thinking:${thinking} · ${SUBAGENT_METADATA[name].description}`;
}

async function pickSubagentThinkingLevel(
  ctx: ExtensionContext,
  name: SubagentName,
): Promise<ModelThinkingLevel | undefined> {
  const state = loadSubagentsConfig()[name];
  const model = state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined;
  const current = state?.thinkingLevel ?? highestThinkingLevel(model);
  const levels = [current, ...supportedThinkingLevels(model).filter((level) => level !== current)];
  const labels = levels.map((level) => (level === current ? `${level} [current]` : level));
  const selected = await ctx.ui.select(`Thinking for subagent ${name}`, labels);
  return selected ? levels[labels.indexOf(selected)] : undefined;
}

async function pickSubagentModel(
  ctx: ExtensionContext,
  name: SubagentName,
): Promise<{ provider: string; model: string } | undefined> {
  const state = loadSubagentsConfig()[name];
  const currentModel = state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : ctx.model;
  return pickAnyModel(ctx, currentModel);
}

type SelectorItem =
  | { kind: "mode"; name: ModeName }
  | { kind: "subagent"; name: SubagentName };

function selectorItems(): SelectorItem[] {
  return [
    ...MODE_ORDER.map((name) => ({ kind: "mode" as const, name })),
    ...SUBAGENT_ORDER.map((name) => ({ kind: "subagent" as const, name })),
  ];
}

async function showModeSelector(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  config: Config,
): Promise<void> {
  const items = selectorItems();
  let selectedIndex = Math.max(
    0,
    MODE_ORDER.indexOf(config.activeMode ?? modeForModel(config, ctx.model) ?? "smart"),
  );

  while (true) {
    const result = await ctx.ui.custom<{
      action: "confirm" | "thinking" | "model" | "cancel";
      item: SelectorItem;
    }>((tui, theme, _kb, done) => ({
      render(width: number) {
        const lines: string[] = [theme.fg("accent", theme.bold("Modus")), "Modes"];
        for (const [index, item] of items.entries()) {
          if (index === MODE_ORDER.length) lines.push("", "Subagents");
          const label = item.kind === "mode"
            ? `${modeLine(ctx, config, item.name)}${item.name === config.activeMode ? " [active]" : ""}`
            : subagentLine(ctx, item.name);
          const line = `${index === selectedIndex ? "→ " : "  "}${label}`;
          const styled = index === selectedIndex ? theme.fg("accent", line) : line;
          lines.push(truncateToWidth(styled, width, ""));
        }
        const hint = theme.fg(
          "dim",
          "↑↓/j/k choose • Enter apply mode / choose subagent model • t thinking • c model • Esc cancel",
        );
        lines.push(truncateToWidth(hint, width, ""));
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const item = items[selectedIndex];
        if (data === "\r" || data === "\n") done({ action: "confirm", item });
        else if (data === "t" || data === "T") done({ action: "thinking", item });
        else if (data === "c" || data === "C") done({ action: "model", item });
        else if (data === "\u001b[A" || data === "k") {
          selectedIndex = (selectedIndex - 1 + items.length) % items.length;
          tui.requestRender();
        } else if (data === "\u001b[B" || data === "j") {
          selectedIndex = (selectedIndex + 1) % items.length;
          tui.requestRender();
        } else if (data === "\u001b" || data.startsWith("\u001b")) {
          done({ action: "cancel", item });
        }
      },
    }));

    if (!result || result.action === "cancel") return;
    selectedIndex = items.findIndex((item) => item.kind === result.item.kind && item.name === result.item.name);

    if (result.item.kind === "mode") {
      if (result.action === "thinking") {
        const level = await pickThinkingLevel(ctx, config, result.item.name);
        if (level) {
          config.modes ??= {};
          config.modes[result.item.name] = { ...config.modes[result.item.name], thinkingLevel: level };
          persistConfig(ctx, config);
        }
      } else if (result.action === "model") {
        const model = await pickModel(ctx, config, result.item.name);
        if (model) {
          config.modes ??= {};
          config.modes[result.item.name] = {
            ...config.modes[result.item.name],
            provider: model.provider,
            model: model.model,
          };
          persistConfig(ctx, config);
        }
      } else {
        await applyMode(ctx, pi, config, result.item.name);
        return;
      }
      continue;
    }

    const subagents = loadSubagentsConfig();
    if (result.action === "thinking") {
      const existing = subagents[result.item.name];
      if (!existing) {
        notify(ctx, `Choose a model for subagent "${result.item.name}" before setting thinking.`, "warning");
        continue;
      }
      const level = await pickSubagentThinkingLevel(ctx, result.item.name);
      if (level) {
        subagents[result.item.name] = { ...existing, thinkingLevel: level };
        persistSubagentsConfig(ctx, subagents);
      }
    } else {
      const model = await pickSubagentModel(ctx, result.item.name);
      if (model) {
        subagents[result.item.name] = {
          ...subagents[result.item.name],
          provider: model.provider,
          model: model.model,
        };
        persistSubagentsConfig(ctx, subagents);
      }
    }
  }
}

export default function modeExtension(pi: ExtensionAPI) {
  registerSubagentTools(pi);

  let config = loadConfig();
  let sessionCost = 0;
  let sessionStart = Date.now();
  const sessionEntries: CostEntry[] = [];

  function currentSessionEntries(): CostEntry[] {
    return readCostLog().filter((entry) => entry.timestamp >= sessionStart);
  }

  function updateModeStatus(ctx: ExtensionContext) {
    sessionCost = currentSessionEntries().reduce((sum, entry) => sum + entry.cost, 0);
    setStatus(
      ctx,
      "modus",
      `modus:${config.activeMode ?? modeForModel(config, ctx.model) ?? "custom"} · ${costLabel(sessionCost)}`,
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    config = withConfig(ctx);
    persistConfig(ctx, config);
    sessionStart = Date.now();
    sessionCost = 0;
    sessionEntries.length = 0;
    updateModeStatus(ctx);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const currentConfig = loadConfig();
    const activeMode = currentConfig.activeMode && isModeName(currentConfig.activeMode) ? currentConfig.activeMode : "smart";
    const behavior = modeBehaviorPrompt(activeMode);
    const subagents = subagentsPrompt();
    const extra = [behavior, subagents].filter(Boolean).join("\n\n");
    if (!extra) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${extra}` };
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message as any;
    if (message.role !== "assistant" || !message.usage) return;
    const currentConfig = loadConfig();
    const entry: CostEntry = {
      timestamp: message.timestamp ?? Date.now(),
      mode: activeCostBucket(currentConfig, ctx.model),
      provider: message.provider ?? ctx.model?.provider ?? "unknown",
      model: message.model ?? ctx.model?.id ?? "unknown",
      inputTokens: message.usage.input ?? 0,
      outputTokens: message.usage.output ?? 0,
      cost: message.usage.cost?.total ?? 0,
    };
    sessionCost += entry.cost;
    sessionEntries.push(entry);
    appendCostEntry(entry);

    updateModeStatus(ctx);
  });

  pi.registerShortcut(Key.ctrlShift("m"), {
    description: "Cycle model mode forward",
    handler: async (ctx) => {
      config = withConfig(ctx);
      const current = config.activeMode ?? modeForModel(config, ctx.model) ?? "smart";
      await applyMode(
        ctx,
        pi,
        config,
        MODE_ORDER[(MODE_ORDER.indexOf(current) + 1) % MODE_ORDER.length],
      );
      updateModeStatus(ctx);
    },
  });

  pi.registerCommand("modus", {
    description: "Select or configure rush/smart/deep modus",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const [first = ""] = trimmed.split(/\s+/);

      return [...MODE_ORDER, "cost", "subagents"]
        .filter((name) => name.startsWith(first))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      config = withConfig(ctx);
      const [firstArg] = args.trim().split(/\s+/);

      if (handleSubagentsCommand(args, ctx)) return;

      if (firstArg === "cost") {
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const allEntries = readCostLog();
        const session = allEntries.filter((entry) => entry.timestamp >= sessionStart);
        const rolling = allEntries.filter((entry) => entry.timestamp >= sevenDaysAgo);
        notify(
          ctx,
          `Modus cost\nSession: ${costLabel(session.reduce((sum, entry) => sum + entry.cost, 0))}\n${summarizeCosts(session) || "No session cost yet."}\n\n7-day: ${costLabel(rolling.reduce((sum, entry) => sum + entry.cost, 0))}\n${summarizeCosts(rolling) || "No cost in the last 7 days."}`,
          "info",
        );
        return;
      }

      if (firstArg) {
        if (!isModeName(firstArg)) {
          notify(
            ctx,
            `Unknown modus "${firstArg}". Use: ${MODE_ORDER.join(", ")} or cost.`,
            "error",
          );
          return;
        }
        await applyMode(ctx, pi, config, firstArg);
        updateModeStatus(ctx);
        return;
      }

      await showModeSelector(ctx, pi, config);
    },
  });
}
