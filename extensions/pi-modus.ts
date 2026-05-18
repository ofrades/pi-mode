import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  activeCostBucket,
  appendCostEntry,
  applyMode,
  costLabel,
  defaultThinkingLevel,
  isModeName,
  loadConfig,
  MODE_ORDER,
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

async function pickModel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<{ provider: string; model: string } | undefined> {
  const state = config.modes?.[modeName];
  const currentModel =
    (state?.provider && state.model ? ctx.modelRegistry.find(state.provider, state.model) : undefined) ??
    ctx.model;
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());

  const selected = await ctx.ui.custom<import("@earendil-works/pi-ai").Model<any> | null>(
    (tui, _theme, _kb, done) =>
      new ModelSelectorComponent(
        tui,
        currentModel,
        settingsManager,
        ctx.modelRegistry,
        [],
        (model) => done(model),
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
      action: "confirm" | "thinking" | "model" | "cancel";
      modeName: ModeName;
    }>((tui, theme, _kb, done) => ({
      render(_width: number) {
        const lines: string[] = [theme.fg("accent", theme.bold("Mode"))];
        for (const [index, name] of MODE_ORDER.entries()) {
          const line = `${index === selectedIndex ? "→ " : "  "}${modeLine(ctx, config, name)}${
            name === config.activeMode ? " [active]" : ""
          }`;
          lines.push(index === selectedIndex ? theme.fg("accent", line) : line);
        }
        lines.push(
          theme.fg(
            "dim",
            "↑↓/j/k choose • Enter apply • t thinking • c model • Esc cancel",
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
        else if (data === "\u001b[A" || data === "k") {
          selectedIndex = (selectedIndex - 1 + MODE_ORDER.length) % MODE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b[B" || data === "j") {
          selectedIndex = (selectedIndex + 1) % MODE_ORDER.length;
          tui.requestRender();
        } else if (data === "\u001b" || data.startsWith("\u001b")) {
          done({ action: "cancel", modeName });
        }
      },
    }));

    if (!result || result.action === "cancel") return;
    selectedIndex = MODE_ORDER.indexOf(result.modeName);

    if (result.action === "thinking") {
      const level = await pickThinkingLevel(ctx, config, result.modeName);
      if (level) {
        config.modes ??= {};
        config.modes[result.modeName] = { ...config.modes[result.modeName], thinkingLevel: level };
        persistConfig(ctx, config);
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
        persistConfig(ctx, config);
      }
    } else {
      await applyMode(ctx, pi, config, result.modeName);
      return;
    }
  }
}

export default function modeExtension(pi: ExtensionAPI) {
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

      return [...MODE_ORDER, "cost"]
        .filter((name) => name.startsWith(first))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      config = withConfig(ctx);
      const [firstArg] = args.trim().split(/\s+/);

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
