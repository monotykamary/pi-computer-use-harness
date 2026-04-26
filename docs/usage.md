# Usage

This guide describes how to use `pi-computer-use` via the CLI once the extension is installed and macOS permissions are granted.

## Core Workflow

Call `screenshot` first when you already know the target. It selects the controlled window and returns the latest semantic state.

```bash
pi-computer-use screenshot
pi-computer-use screenshot --app Safari
pi-computer-use screenshot --app TextEdit --windowTitle "Untitled"
```

When the app or window is ambiguous, discover targets first:

```bash
pi-computer-use list_apps
pi-computer-use list_windows --app Safari
pi-computer-use screenshot --window @w1
```

Actions operate on the current controlled window by default. To switch windows, call `screenshot` again with an app/window title or a `--window` ref from `list_windows`. You can also pass `--window` to action commands when you want to make the intended target explicit:

```bash
pi-computer-use click --ref @e1 --window @w1
pi-computer-use keypress --keys '["Enter"]' --window @w1
```

Results include:

- `target`: app, bundle ID, pid, window title, window ID, and optional `windowRef`.
- `capture`: screenshot dimensions, scale factor, `stateId`, and coordinate space.
- `axTargets`: semantic targets such as `@e1`.
- `execution`: strategy, variant, AX/fallback details, and strict-mode compatibility.
- Image saved to `/tmp/pi-computer-use/<stateId>.png` when semantic coverage is weak — read it with the `read` tool for visual context.

## AX Refs First

When the latest state includes AX refs, prefer them over coordinates.

```bash
pi-computer-use click --ref @e1
pi-computer-use set_text --text "hello" --ref @e2
pi-computer-use scroll --ref @e3 --scrollY 600
```

Refs are intentionally short and local to the latest semantic state. If a ref is stale, the bridge tries to reacquire a matching target by role, label, capabilities, and position.

Use coordinates only when no matching AX target is available:

```bash
pi-computer-use click -x 320 -y 180
```

Coordinates are window-relative screenshot pixels from the latest screenshot. Pass `--stateId` from the latest result when you want stale-state validation.

Use `--image always` when visual verification matters, `--image never` to suppress image output, or omit it for the default `auto` behavior.

## Command Reference

| Command | Purpose | Prefer |
| --- | --- | --- |
| `list_apps` | Discover running apps | Before targeting when app names are unknown or ambiguous |
| `list_windows` | Discover controllable windows, ids, titles, and geometry | Before targeting multi-window apps |
| `screenshot` | Select or refresh the controlled window | `--window` refs or app/window filters when switching target |
| `click` | Activate by AX ref or coordinate | `--ref` |
| `double_click` | Open/select items that require double-click | `--ref` when available |
| `move_mouse` | Trigger hover behavior | Coordinates |
| `drag` | Drag path or AX adjust target | `--ref` plus `--path` for adjustable controls |
| `scroll` | Scroll by AX ref or coordinate | `--ref` |
| `keypress` | Enter, Escape, Tab, arrows, deletion, shortcuts | Semantic keys when possible |
| `type_text` | Insert text at current cursor/selection | Use after focusing field |
| `set_text` | Replace AX text value | `--ref` with `canSetValue` |
| `wait` | Pause and refresh state | Polling/loading states |
| `arrange_window` | Move/resize a window deterministically | Presets such as `center_large`, `left_half`, `right_half` |
| `navigate_browser` | Navigate a browser window directly | Prefer over address-bar keystrokes when you know the URL |
| `computer_actions` | Batch obvious actions | Use only when intermediate inspection is unnecessary |

## Text Input

Use `set_text` when replacement semantics are correct:

```bash
pi-computer-use set_text --text "new value" --ref @e2
```

Use `click` plus `type_text` when insertion semantics matter:

```bash
pi-computer-use click --ref @e2
pi-computer-use type_text --text " inserted text"
```

Use `keypress` for non-text keys:

```bash
pi-computer-use keypress --keys '["Enter"]'
pi-computer-use keypress --keys '["Command+L"]'
pi-computer-use keypress --keys '["Tab", "Enter"]'
```

For shortcut sequences, use chord strings such as `Command+L`. Use arrays like `["Command", "L"]` only for a single chord call.

## Browser Workflows

For browser work, prefer a dedicated browser window rather than the user's active tab. The harness tries to open an isolated browser window when safe and appropriate.

Common address-field workflow:

```bash
pi-computer-use computer_actions --actions '[{"type":"keypress","keys":["Command+L"]},{"type":"type_text","text":"https://example.com"},{"type":"keypress","keys":["Enter"]}]'
```

For Safari and Chromium-family browsers, this can use an AX-first path for address replacement and navigation.

If `browser_use` is disabled, browser screenshots and actions are refused. See [configuration](./configuration.md).

## Batching

`computer_actions` accepts one to twenty actions and returns one post-action state update.

Good fit:

```bash
pi-computer-use computer_actions --actions '[{"type":"click","ref":"@e1"},{"type":"set_text","ref":"@e2","text":"hello"},{"type":"keypress","keys":["Enter"]}]'
```

Do not batch when the next action depends on seeing the intermediate result.

Each batched action includes execution metadata, including whether it used the `stealth` or `default` variant.

## Strict AX Mode

Strict AX mode requires background-safe Accessibility paths.

Allowed when AX support is available:

- AX press/focus
- AX value replacement
- AX scroll
- AX increment/decrement adjustment
- Semantic key actions such as confirm/cancel/press

Blocked:

- Raw pointer events
- Raw keyboard events
- Foreground focus fallbacks
- Cursor takeover
- Browser window bootstrap that requires non-AX automation

Enable strict AX mode with config or environment variables. See [configuration](./configuration.md).
