/**
 * Shared constants for pi-computer-use.
 *
 * Action names, error messages, timeouts, browser identification sets.
 */

const TOOL_NAMES = new Set([
	"list_apps",
	"list_windows",
	"screenshot",
	"click",
	"double_click",
	"move_mouse",
	"drag",
	"scroll",
	"keypress",
	"type_text",
	"set_text",
	"wait",
	"arrange_window",
	"navigate_browser",
	"computer_actions",
]);

export const MISSING_TARGET_ERROR = "No current controlled window. Call screenshot first to choose a target window.";
export const CURRENT_TARGET_GONE_ERROR =
	"The current controlled window is no longer available. Call screenshot to choose a new target window.";
export const NON_MACOS_ERROR = "pi-computer-use currently supports macOS 12+ only.";

export const COMMAND_TIMEOUT_MS = 15_000;
export const SCREENSHOT_TIMEOUT_MS = 25_000;
export const HELPER_SETUP_TIMEOUT_MS = 60_000;
export const ACTION_SETTLE_MS = 280;
export const BATCH_ACTION_GAP_MS = 80;
export const BATCH_MAX_ACTIONS = 20;
export const DEFAULT_WAIT_MS = 1_000;

export const RECOVERABLE_SCREENSHOT_ERROR_CODES = new Set(["screenshot_timeout", "window_not_found"]);
export const BROWSER_BUNDLE_IDS = new Set([
	"com.apple.Safari",
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
	"org.mozilla.firefox",
]);
export const BROWSER_APP_NAMES = new Set([
	"safari",
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
	"firefox",
]);
export const CHROME_FAMILY_BUNDLE_IDS = new Set([
	"com.google.Chrome",
	"org.chromium.Chromium",
	"company.thebrowser.Browser",
	"com.brave.Browser",
	"com.microsoft.edgemac",
	"com.vivaldi.Vivaldi",
	"net.imput.helium",
]);
export const CHROME_FAMILY_APP_NAMES = new Set([
	"google chrome",
	"chrome",
	"chromium",
	"arc",
	"brave browser",
	"brave",
	"microsoft edge",
	"edge",
	"vivaldi",
	"helium",
]);

export const BROWSER_WINDOW_OPEN_TIMEOUT_MS = 10_000;
