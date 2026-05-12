# pi-mode

[Amp](https://ampcode.com/models) style Rush/smart/deep model mode switching for [Pi](https://github.com/earendil-works/pi).

## Installation

```bash
pi install git:github.com/ofrades/pi-mode
```

## Concepts

**Modes** are named presets (`rush`, `smart`, `deep`) each bound to a specific model and thinking level. You pick the mode for the general pace of a session.

| Mode | Intent |
|------|--------|
| `rush` | Faster and cheaper, for small, well-defined tasks |
| `smart` | Unconstrained state-of-the-art model use |
| `deep` | Deep reasoning with extended thinking |

Each mode stores a `provider`, `model`, and `thinkingLevel`. Cycling with `Ctrl+Shift+M` steps through them in order.

## Commands

### `/mode`

Opens the interactive mode selector.

```
/mode              # open selector UI
/mode rush         # switch directly to rush
/mode smart        # switch directly to smart
/mode deep         # switch directly to deep
/mode cost         # show session and 7-day cost summary
/mode log [N]      # show last N turn logs (default 10)
```

Inside the selector:

- `↑↓` / `j` / `k` — navigate modes
- `Enter` — apply selected mode
- `t` — change thinking level for selected mode
- `c` — change model for selected mode
- `Esc` — cancel

### `Ctrl+Shift+M`

Cycles forward through `rush → smart → deep → rush`.

## Configuration

Config is stored in `settings.json` under the agent directory:

```json
{
  "mode": {
    "activeMode": "smart",
    "modes": {
      "rush":  { "provider": "anthropic",    "model": "claude-haiku-4.5",   "thinkingLevel": "medium" },
      "smart": { "provider": "anthropic", "model": "claude-opus-4.7",  "thinkingLevel": "high" },
      "deep":  { "provider": "openai",    "model": "gpt-5.5",                 "thinkingLevel": "medium" }
    }
  }
}
```

## Notes

- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
