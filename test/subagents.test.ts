import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addMessageUsage,
  appendBounded,
  createProgress,
  formatSubagentContent,
  textDeltaFromEvent,
  toolArgsPreview,
  type UsageStats,
} from "../src/subagents.ts";

describe("subagent progress helpers", () => {
  it("extracts streaming text deltas", () => {
    assert.equal(
      textDeltaFromEvent({ assistantMessageEvent: { type: "text_delta", delta: "hello" } }),
      "hello",
    );
    assert.equal(textDeltaFromEvent({ assistantMessageEvent: { type: "thinking_delta", delta: "hidden" } }), "");
  });

  it("formats useful tool argument previews", () => {
    assert.equal(toolArgsPreview({ command: "rg subagents src" }), "rg subagents src");
    assert.equal(toolArgsPreview({ query: "how does omp stream subagents" }), "how does omp stream subagents");
    assert.match(toolArgsPreview({ unknown: "value", count: 2 }), /^\{"unknown":"value"/);
  });

  it("keeps captured subprocess output bounded while preserving the tail", () => {
    const tail = "important tail";
    const bounded = appendBounded("", `${"x".repeat(70_000)}${tail}`);
    assert.ok(bounded.length <= 64 * 1024);
    assert.ok(bounded.startsWith("[truncated]\n"));
    assert.ok(bounded.endsWith(tail));
  });

  it("accumulates assistant usage into progress and ignores non-assistant messages", () => {
    const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    const progress = createProgress();

    addMessageUsage(usage, progress, { role: "user", usage: { input: 100, output: 100, cost: { total: 1 } } });
    assert.equal(usage.input, 0);
    assert.equal(progress.tokens, 0);

    addMessageUsage(usage, progress, {
      role: "assistant",
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 100,
        cost: { total: 0.001 },
      },
    });

    assert.deepEqual(
      {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        contextTokens: usage.contextTokens,
        cost: usage.cost,
        progressTokens: progress.tokens,
        progressCost: progress.cost,
      },
      {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        contextTokens: 100,
        cost: 0.001,
        progressTokens: 70,
        progressCost: 0.001,
      },
    );
  });

  it("renders progress with tools, token/cost totals, thinking, and output fallback", () => {
    const progress = createProgress();
    progress.status = "find done";
    progress.toolCount = 1;
    progress.recentTools.unshift({ tool: "find", args: "src/**/*", isError: false });
    progress.tokens = 70;
    progress.cost = 0.001;
    progress.recentOutput = ["latest line"];

    const withText = formatSubagentContent("final text", "thinking text", progress);
    assert.match(withText, /find done/);
    assert.match(withText, /ran find src\/\*\*/);
    assert.match(withText, /1 tools/);
    assert.match(withText, /70 tokens/);
    assert.match(withText, /\$0\.0010/);
    assert.match(withText, /thinking text/);
    assert.match(withText, /final text/);

    const fallback = formatSubagentContent("", "", progress);
    assert.match(fallback, /latest line/);
  });
});
