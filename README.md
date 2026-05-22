# pi-modus

[Amp](https://ampcode.com/models) style mode switching and explicit named subagents for [Pi](https://github.com/earendil-works/pi).

## Installation

```bash
pi install git:github.com/ofrades/pi-modus
```

## Concepts

**Modes** are named behavioral profiles (`rush`, `smart`, `deep`) each bound to a specific model and thinking level. The prompt injected for each mode matches Amp's exact system prompts — they are behavioral contracts, not just model presets.

| Mode | Intent |
|------|--------|
| `rush` | Speed first: small focused changes, minimal explanation, ultra-concise, verify narrowly |
| `smart` | Unconstrained state-of-the-art: end-to-end agency, simple-first, parallel by default |
| `deep` | Pragmatic senior engineer: build broad context, smallest correct change, YAGNI/KISS |

**Subagents** are named, explicitly requested assistants with their own model and thinking level. They are available as tools but are **never proactively recommended** by the mode prompt. The intended pattern is user-directed delegation:

> "Ask the oracle to inspect these files first, then implement the smallest patch."

Available subagents:

| Subagent | Purpose |
|----------|---------|
| `search` | Fast parallel codebase retrieval (8+ parallel calls, 3-turn limit) |
| `vision` | Image and screenshot analysis |
| `review` | Code review with git diff focus, abstraction-fit evaluation |
| `oracle` | Planning, tradeoffs, 6-part structured response (TL;DR → risks → effort signal) |
| `librarian` | External docs, dependencies, API research |

Subagent system prompts are copied verbatim from Amp's binary.

## Commands

### `/modus`

Opens the interactive modus selector for both modes and subagents.

```
/modus              # open selector UI
/modus rush         # switch directly to rush
/modus smart        # switch directly to smart
/modus deep         # switch directly to deep
/modus cost         # show session and 7-day cost summary
/modus subagents    # list configured subagents
/modus subagents set oracle openai/gpt-5.5:high
/modus subagents unset oracle
```

Inside the selector:

- `↑↓` / `j` / `k` — navigate modes and subagents
- `Enter` — apply selected mode, or choose a model for selected subagent
- `t` — change thinking level for selected mode/subagent
- `c` — change model for selected mode/subagent
- `Esc` — cancel

### `Ctrl+Shift+M`

Cycles forward through `rush → smart → deep → rush`.

## Amp models

```
Modes:
- Rush: gpt-5.5, no reasoning
- Smart: claude-opus-4.7
- Deep: gpt-5.5, medium reasoning

Subagents:
 - Review: gemini 3.1-pro
 - Search: gemini 3-flash
 - Oracle: gpt-5.4, medium reasoning
 - Librarian: claude-sonnet-4.6

Tool:
 - Vision: gemini-3-flash
```

# Configuration

Config is stored in `settings.json` under the agent directory:

These are cost-effective opencode-go models. Swap to the Amp equivalents if you prefer.

```jsonc
{
  "modus": {
    "activeMode": "smart",
    "modes": {
      "rush":  { "provider": "opencode-go", "model": "deepseek-v4-flash", "thinkingLevel": "off" },
      "smart": { "provider": "opencode-go", "model": "kimi-k2.6", "thinkingLevel": "medium" },
      "deep":  { "provider": "opencode-go", "model": "deepseek-v4-pro", "thinkingLevel": "medium" }
    },
    "subagents": {
      "review":    { "provider": "opencode-go", "model": "deepseek-v4-pro" },
      "search":    { "provider": "opencode-go", "model": "deepseek-v4-flash", "thinkingLevel": "off" },
      "oracle":    { "provider": "opencode-go", "model": "kimi-k2.5", "thinkingLevel": "medium" },
      "librarian": { "provider": "opencode-go", "model": "kimi-k2.5" },
      "vision":    { "provider": "opencode-go", "model": "kimi-k2.5" } 
    }
  }
}

```

## Notes

- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
- Subagent costs are tracked separately in the cost log and appear in `/modus cost`.
- Subagents run read-only. They cannot edit files.
