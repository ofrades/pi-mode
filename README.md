# pi-mode

A Pi coding agent package with two extension modules:

- **pi-mode** — rush/smart/deep model mode switching
- **pi-routing** — task-aware model routing for vision, handoff, search, review, oracle, and librarian tasks

Together they let you assign different models to different kinds of work and switch between them with a keystroke, a slash command, or task-aware tools.

## Installation

Install via the Pi CLI:

```bash
pi install git:github.com/ofrades/pi-mode
```

Or add it to your global or project settings and run `pi update --extensions`:

```json
{
  "packages": [
    "git:github.com/ofrades/pi-mode"
  ]
}
```

After installation, configure your models in the Pi settings UI or by editing `~/.pi/agent/settings.json` directly (see [Configuration](#configuration) below).

## Concepts

**Modes** are named presets (`rush`, `smart`, `deep`) each bound to a specific model and thinking level. You pick the mode for the general pace of a session.

**Routes** are task-specific model overrides (`vision`, `handoff`, `search`, `review`, `oracle`, `librarian`). When a task needs a different capability — vision, deep reasoning, doc research — the agent can switch to the right model for that task and restore the previous one when done.

## Modes

| Mode | Intent |
|------|--------|
| `rush` | Fast, cheap model for quick lookups and boilerplate |
| `smart` | Default balanced model |
| `deep` | Slow, expensive model for hard problems |

Each mode stores a `provider`, `model`, and `thinkingLevel`. Cycling with `Ctrl+Shift+M` steps through them in order.

## Routes

| Route | When to use |
|-------|-------------|
| `vision` | Images and screenshots |
| `handoff` | Context compaction and continuation prompts |
| `search` | Fast codebase retrieval and context gathering |
| `review` | Code review, security checks, regression analysis |
| `oracle` | Hard planning, architectural tradeoffs, consistency checks |
| `librarian` | External docs, unfamiliar dependencies, API research |

Routes are meant to be temporary. After the specialized task, the agent calls `task_model` with `action='restore'` to return to the previous model.

## Commands

### `/mode`

Opens the interactive mode selector.

```
/mode              # open selector UI
/mode rush         # switch directly to rush
/mode smart        # switch directly to smart
/mode deep         # switch directly to deep
/mode routing on   # enable task routing
/mode routing off  # disable task routing
```

Inside the selector:

- `↑↓` / `j` / `k` — navigate modes
- `Enter` — apply selected mode
- `t` — change thinking level for selected mode
- `c` — change model for selected mode
- `r` — toggle routing on/off
- `Esc` — cancel

### `Ctrl+Shift+M`

Cycles forward through `rush → smart → deep → rush`.

## Tools (for the agent)

### `analyze_media`

Analyzes an image inline using the `vision` route and returns text. Useful when the active model lacks vision — the agent calls this instead of a plain file read, and gets a text description it can reason over.

```
path    — path to the image file (png, jpg, jpeg, gif, webp)
prompt  — optional question or focus for the analysis
```

### `task_model`

Switches to or restores from a named route.

```
action: "list"    — show all routes and their configured models
action: "status"  — show whether routing is enabled and the active route
action: "switch"  — switch to a route (requires task)
action: "restore" — return to the previous/main model
task              — one of: vision, handoff, search, review, oracle, librarian
```

## Configuration

Config is stored in `settings.json` under the agent directory alongside the rest of the agent settings. Structure:

```json
{
  "mode": {
    "activeMode": "smart",
    "modes": {
      "rush":  { "provider": "google",    "model": "gemini-2.0-flash",   "thinkingLevel": "off" },
      "smart": { "provider": "anthropic", "model": "claude-sonnet-4-6",  "thinkingLevel": "low" },
      "deep":  { "provider": "openai",    "model": "o3",                 "thinkingLevel": "high" }
    },
    "routing": {
      "enabled": true,
      "routes": {
        "vision":    { "provider": "google",    "model": "gemini-2.0-flash" },
        "librarian": { "provider": "anthropic", "model": "claude-sonnet-4-6" },
        "oracle":    { "provider": "openai",    "model": "o3" }
      }
    }
  }
}
```

Routes without a configured `provider`/`model` are listed as `unconfigured` and will return an error if the agent tries to switch to them. Configure them via the model selector UI or by editing `settings.json` directly.

## Notes

- Routing can be disabled globally with `/mode routing off`. When disabled, `task_model switch` and `analyze_media` both return errors rather than silently using the wrong model.
- `thinkingLevel` defaults to the highest level supported by the configured model if not explicitly set.
- The `vision` route is also used by `analyze_media` directly — it bypasses the normal routing flow and calls the vision model inline, returning text rather than switching the active session model.
