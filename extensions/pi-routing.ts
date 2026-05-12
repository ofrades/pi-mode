import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, StringEnum, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  applyRoute,
  highestThinkingLevel,
  isRouteName,
  loadConfig,
  resolveRouteState,
  restoreRoute,
  ROUTE_ORDER,
  setStatus,
  withConfig,
  type Config,
  type RouteName,
} from "../src/mode-core.ts";

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const IMAGE_ANALYSIS_SYSTEM_PROMPT = `You are an image analysis assistant for a Pi coding session.

Analyze the supplied image for the parent agent. If it contains text, transcribe the important text exactly. If it is a UI screenshot, identify controls, errors, states, and likely user intent. Be concise, concrete, and say when details are uncertain.`;

async function analyzeImageWithRoute(
  ctx: ExtensionContext,
  config: Config,
  imagePath: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const route = resolveRouteState(config, "vision");
  if (!route.provider || !route.model) {
    throw new Error(`Vision route is not configured with provider/model. ${route.description}`);
  }

  const model = ctx.modelRegistry.find(route.provider, route.model);
  if (!model) throw new Error(`Vision model not found: ${route.provider}/${route.model}`);

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const absolutePath = resolve(ctx.cwd, imagePath.replace(/^@/, ""));
  const mediaType = IMAGE_MEDIA_TYPES[extname(absolutePath).toLowerCase()];
  if (!mediaType) throw new Error("Unsupported image type. Use png, jpg, jpeg, gif, or webp.");

  const data = await readFile(absolutePath, { encoding: "base64", signal });
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
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response instanceof Error) throw new Error(`Vision model error: ${response.message}`);
  if (response.errorMessage) {
    throw new Error(`Vision model returned error: ${response.errorMessage}`);
  }

  const texts = (response.content ?? [])
    .filter((content): content is { type: "text"; text: string } => content.type === "text")
    .map((content) => content.text);

  if (texts.length === 0) {
    const types = (response.content ?? []).map((content: any) => content.type).join(", ");
    throw new Error(
      `Vision model returned no text. Content types: ${types}. stopReason=${response.stopReason}`,
    );
  }

  return texts.join("\n");
}

export default function routingExtension(pi: ExtensionAPI) {
  let config = loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    config = withConfig(ctx);
    setStatus(
      ctx,
      "route",
      config.routing?.activeRoute ? `route:${config.routing.activeRoute}` : undefined,
    );
  });

  pi.registerTool({
    name: "analyze_media",
    label: "Analyze Media",
    description:
      "Analyze an image file inline using the configured vision route and return text findings to the current model. Use this for screenshots and image files when the active model may not have vision.",
    promptSnippet:
      "Use analyze_media for image/screenshot paths instead of plain read when the active model may not have vision. It calls the configured vision route inline and returns text analysis.",
    promptGuidelines: [
      "Use analyze_media when the user asks about an image or screenshot path; it returns text analysis that non-vision models can use in the same turn.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the image file to analyze" }),
      prompt: Type.Optional(
        Type.String({ description: "Question or focus for the image analysis" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      config = withConfig(ctx);
      if (config.routing?.enabled === false) {
        throw new Error("Task routing is disabled. Use /mode routing on to enable analyze_media.");
      }

      const text = await analyzeImageWithRoute(
        ctx,
        config,
        params.path,
        params.prompt ?? "",
        signal,
      );
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "task_model",
    label: "Task Model",
    description:
      "Task-aware model router. List, switch to, or restore from hidden task profiles such as vision, handoff, search, review, oracle, and librarian. Use before tasks that need specific capabilities, especially image understanding.",
    promptSnippet:
      "Use task_model to switch inline before specialized work: vision/look-at/image for images; handoff for context transfer; search for retrieval; review for code review; oracle for hard planning; librarian for external docs/dependency research. Respect routing disabled state.",
    promptGuidelines: [
      "Use task_model with action='switch' and task='vision' before analyzing image paths or screenshots when the current model may lack vision.",
      "Use task_model with action='switch' for handoff, search, review, oracle, or librarian tasks when the configured task model better fits the work; use action='restore' after the specialized work when appropriate.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "switch", "restore", "status"] as const),
      task: Type.Optional(StringEnum(ROUTE_ORDER)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      config = withConfig(ctx);
      const routingEnabled = config.routing?.enabled !== false;

      if (params.action === "status") {
        return {
          content: [
            {
              type: "text",
              text: `Task routing is ${routingEnabled ? "enabled" : "disabled"}.${
                config.routing?.activeRoute ? ` Active route: ${config.routing.activeRoute}.` : ""
              }`,
            },
          ],
        };
      }

      if (params.action === "list") {
        const lines = ROUTE_ORDER.map((routeName) => {
          const route = resolveRouteState(config, routeName);
          const configured =
            route.provider && route.model ? `${route.provider}/${route.model}` : "unconfigured";
          const model =
            route.provider && route.model
              ? ctx.modelRegistry.find(route.provider, route.model)
              : undefined;
          const thinkingLevel =
            route.thinkingLevel ?? (model ? highestThinkingLevel(model) : undefined);
          return `- ${routeName}: ${configured}${
            thinkingLevel ? ` · thinking:${thinkingLevel}` : ""
          } · ${route.description}`;
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
        if (!ok) throw new Error("Could not restore previous/main model.");
        return { content: [{ type: "text", text: "Restored previous/main model." }] };
      }

      const task = params.task as RouteName | undefined;
      if (!task || !isRouteName(task)) {
        throw new Error(`task is required. Use one of: ${ROUTE_ORDER.join(", ")}`);
      }
      if (!routingEnabled) {
        throw new Error("Task routing is disabled. Use /mode and press r to enable it.");
      }

      const route = resolveRouteState(config, task);
      if (!route.provider || !route.model) {
        throw new Error(
          `Route "${task}" is not configured with provider/model in settings. ${route.description}`,
        );
      }

      const model = ctx.modelRegistry.find(route.provider, route.model);
      const thinkingLevel = route.thinkingLevel ?? highestThinkingLevel(model);
      const restoreHint = route.restore ? " Restore after the specialized task if appropriate." : "";
      const ok = await applyRoute(ctx, pi, config, task);
      if (!ok) throw new Error(`Failed to switch to ${task}: ${route.provider}/${route.model}`);

      return {
        content: [
          {
            type: "text",
            text: `Switched to ${task}: ${route.provider}/${route.model} · thinking:${thinkingLevel}.${restoreHint}`,
          },
        ],
      };
    },
  });
}
