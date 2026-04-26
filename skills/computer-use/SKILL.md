---
name: computer-use
description: Interact with macOS GUI windows using the `pi-computer-use` CLI — a persistent harness server handles the Swift helper and all state. Use this when the task requires operating a visible macOS app window.
---

# Computer Use

Use `pi-computer-use` when shell/file tools are not enough and you need to operate a macOS app window directly. The CLI auto-spawns a long-lived harness server on first use — every call dispatches to the same server, so window refs (`@w1`), AX targets (`@e1`), and capture state survive across calls.

## Setup

The CLI is installed to `~/.pi/agent/bin/pi-computer-use` automatically (pi adds `~/.pi/agent/bin/` to PATH). On first use in a pi session, grant macOS permissions to:

```
~/.pi/agent/helpers/pi-computer-use/bridge
```

Required permissions: **Accessibility** + **Screen Recording**.

If the CLI reports missing permissions, start pi in interactive mode and use `/computer-use` to check status, then grant via System Settings → Privacy & Security.

## Core workflow

1. **Call `screenshot` first** to pick the target window and get current UI state. If the server returns a screenshot file path, read it with the `read` tool to see the image.
2. If the latest screenshot includes AX target refs (`@e1`, `@e2`, …), prefer those for clicks and text input. Use coordinates only when no suitable AX target is available.
3. To discover/switch apps or windows, use `list_apps`, `list_windows`, then `screenshot --window @w1`.
4. Every successful action returns the **latest semantic state**. If AX targets are missing, sparse, or ambiguous, a screenshot image is saved to `/tmp/pi-computer-use/` — read it for visual context.

## Command reference

### Discovery

```bash
pi-computer-use list_apps
pi-computer-use list_windows [--app Safari] [--pid 123]
```

### Screenshot

```bash
pi-computer-use screenshot [--app Safari] [--windowTitle "Google"] [--window @w1] [--image auto|always|never]
```

The `screenshot` command captures the current controlled window and returns semantic AX targets. If a visual fallback is needed, the output includes a file path like `/tmp/pi-computer-use/<stateId>.png` — read it with the `read` tool to see the image inline.

### Actions

```bash
# Click by AX ref (preferred) or coordinates
pi-computer-use click --ref @e1
pi-computer-use click -x 320 -y 180

# Double click
pi-computer-use double_click --ref @e1
pi-computer-use double_click -x 320 -y 180

# Move mouse (coordinates from the latest screenshot)
pi-computer-use move_mouse -x 100 -y 200

# Drag along a path (space-separated x,y pairs)
pi-computer-use drag --path '10,20 100,200'

# Scroll by AX ref or coordinates
pi-computer-use scroll --ref @e3 --scrollY 600
pi-computer-use scroll -x 400 -y 300 --scrollY 600

# Keyboard input (comma-separated key names)
pi-computer-use keypress --keys Enter
pi-computer-use keypress --keys Command+L,Enter

# Text input
pi-computer-use type_text --text "hello world"
pi-computer-use set_text --text "https://example.com" --ref @e2

# Wait for UI to settle
pi-computer-use wait --ms 1000
```

### Window management

```bash
# Arrange a window for predictable screenshots
pi-computer-use arrange_window --window @w1 --preset center_large
pi-computer-use arrange_window -x 0 -y 0 --width 1200 --height 800

# Navigate a browser window directly to a URL
pi-computer-use navigate_browser --url "https://example.com" --window @w1
```

### Batched actions

```bash
pi-computer-use computer_actions --actions '[{"type":"click","ref":"@e1"},{"type":"type_text","text":"hello"},{"type":"keypress","keys":["Enter"]}]'
```

Batch 1–20 actions when no intermediate screenshot is needed. The tool returns one state update after all actions complete, plus per-action execution metadata.

### Server management

| Command | Behavior |
|---------|----------|
| `pi-computer-use --status` | Print health JSON or exit 1 if down |
| `pi-computer-use --start` | Start the harness server |
| `pi-computer-use --stop` | Graceful shutdown |
| `pi-computer-use --restart` | Stop + start fresh |
| `pi-computer-use --logs` | `tail -f` the server log |

### JSON passthrough

For programmatic use or complex actions:

```bash
pi-computer-use '{ "action": "click", "ref": "@e1" }'
pi-computer-use '{ "action": "screenshot", "window": "@w1" }'
```

## Practical rules

- Actions operate on the **current controlled window** by default, or an explicit `--window @wN` when provided.
- For browsers, prefer a **separate window** for agent work, not a new tab in the user's current window.
- `screenshot` may include compact AX targets like `@e1`; prefer refs for `click --ref @e1` and `set_text --ref @e1 --text ...` whenever a listed target matches. For `set_text`, prefer targets marked `canSetValue`.
- Coordinates are **window-relative screenshot pixels** (top-left origin) from the latest screenshot.
- `stateId` is optional. If provided and stale, the error message tells you to refresh with `screenshot`.
- `type_text` inserts text at the current cursor/selection. Use `set_text` for AX value replacement; prefer `--ref` over relying on focus.
- `scroll` can use `--ref @eN` for an AX scroll target or `--scrollY`/`--scrollX` with coordinates. `drag` can use `--ref @eN` for sliders/steppers with AX `adjust` capability, otherwise `--path` with space-separated x,y pairs like `10,20 100,200` (legacy JSON also accepted).
- For shortcut sequences, use `--keys Command+L,Enter`. In browser windows, `Command+L` focuses the address/search field via AX. Legacy JSON format (`--keys '["Enter"]'`) is also accepted.
- `computer_actions` executes 1–20 actions with one state update plus per-action metadata. Do not batch if the next action depends on seeing an intermediate result.
- `wait --ms N` pauses then returns the latest semantic state for polling/loading.
- Run `/computer-use` in pi to inspect the effective config. Config files: `~/.pi/agent/extensions/pi-computer-use.json` (global) and `.pi/computer-use.json` (per project).
- `browser_use=false` blocks control of known browser apps. `stealth_mode=true` requires background-safe AX execution.
- Screenshots that require visual fallback are saved to `/tmp/pi-computer-use/`. Use the `read` tool to view them.

## When errors happen

If an action reports stale state, target mismatch, or missing target/window, call `screenshot` again to refresh and continue.
