import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  applyMode,
  defaultThinkingLevel,
  isModeName,
  loadConfig,
  MODE_ORDER,
  modeForModel,
  modeLine,
  notify,
  persistConfig,
  setStatus,
  supportedThinkingLevels,
  withConfig,
  type Config,
  type ModeName,
} from "../src/mode-core.ts";

async function pickThinkingLevel(
  ctx: ExtensionContext,
  config: Config,
  modeName: ModeName,
): Promise<ModelThinkingLevel | undefined> {
  const state = config.modes?.[modeName];
  const model = ctx.modelRegistry.find(state?.provider, state?.model);
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
      action: "confirm" | "thinking" | "model" | "routing" | "cancel";
      modeName: ModeName;
    }>((tui, theme, _kb, done) => ({
      render(_width: number) {
        const routing = config.routing?.enabled ? "on" : "off";
        const lines: string[] = [theme.fg("accent", theme.bold(`Mode · routing:${routing}`))];
        for (const [index, name] of MODE_ORDER.entries()) {
          const line = `${index === selectedIndex ? "→ " : "  "}${modeLine(ctx, config, name)}${
            name === config.activeMode ? " [active]" : ""
          }`;
          lines.push(index === selectedIndex ? theme.fg("accent", line) : line);
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
        } else if (data === "\u001b" || data.startsWith("\u001b")) {
          done({ action: "cancel", modeName });
        }
      },
    }));

    if (!result || result.action === "cancel") return;
    selectedIndex = MODE_ORDER.indexOf(result.modeName);

    if (result.action === "routing") {
      config.routing ??= {};
      config.routing.enabled = !(config.routing.enabled ?? true);
      persistConfig(ctx, config);
      notify(ctx, `Task routing ${config.routing.enabled ? "enabled" : "disabled"}`, "info");
    } else if (result.action === "thinking") {
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

  pi.on("session_start", async (_event, ctx) => {
    config = withConfig(ctx);
    persistConfig(ctx, config);
    setStatus(
      ctx,
      "mode",
      `mode:${config.activeMode ?? modeForModel(config, ctx.model) ?? "custom"}`,
    );
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
    },
  });

  pi.registerCommand("mode", {
    description: "Select or configure rush/smart/deep mode",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      const [first = "", second = ""] = trimmed.split(/\s+/);
      if (first === "routing" && /\s/.test(trimmed)) {
        return ["on", "off"]
          .filter((value) => value.startsWith(second))
          .map((value) => ({ value: `routing ${value}`, label: value }));
      }

      return [...MODE_ORDER, "routing"]
        .filter((name) => name.startsWith(first))
        .map((name) => ({ value: name, label: name }));
    },
    handler: async (args, ctx) => {
      config = withConfig(ctx);
      const [firstArg, secondArg] = args.trim().split(/\s+/);

      if (firstArg === "routing") {
        config.routing ??= {};
        if (secondArg === "on") config.routing.enabled = true;
        else if (secondArg === "off") config.routing.enabled = false;
        else config.routing.enabled = !(config.routing.enabled ?? true);
        persistConfig(ctx, config);
        notify(ctx, `Task routing ${config.routing.enabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      if (firstArg) {
        if (!isModeName(firstArg)) {
          notify(
            ctx,
            `Unknown mode "${firstArg}". Use: ${MODE_ORDER.join(", ")} or routing [on|off].`,
            "error",
          );
          return;
        }
        await applyMode(ctx, pi, config, firstArg);
        return;
      }

      await showModeSelector(ctx, pi, config);
    },
  });
}
