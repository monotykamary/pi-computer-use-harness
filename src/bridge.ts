/**
 * pi-computer-use bridge — re-export barrel.
 *
 * Re-exports the public API from logical sub-modules for backward
 * compatibility with consumers that import from "../src/bridge.ts".
 */

export type { ActivationFlags, ArrangeWindowParams, AxFocusResult, AxPressAtPointResult, AxTarget, BatchActionTrace, CaptureResult, ClickParams, ComputerAction, ComputerActionsParams, ComputerUseDetails, CurrentCapture } from "./types.ts";
export type { CurrentTarget, DragParams, ExecutionTrace, ExecutionVariant, FocusWindowResult, FocusedElementResult, FramePoints, FrontmostResult, HelperApp, HelperAxTarget, HelperWindow, ImageMode } from "./types.ts";
export type { KeypressParams, ListAppsDetails, ListWindowsDetails, ListWindowsParams, MouseButtonName, MoveMouseParams, NavigateBrowserParams, PendingBrowserAddress, PendingRequest, ResolvedTarget, RuntimeState, ScreenshotParams } from "./types.ts";
export type { ScreenshotPayload, ScrollParams, SetTextParams, StateTargetSnapshot, TypeTextParams, WaitParams, WindowRefRecord, WindowSelector, WindowTargetParams } from "./types.ts";

export { ACTION_SETTLE_MS, BATCH_ACTION_GAP_MS, BATCH_MAX_ACTIONS, BROWSER_APP_NAMES, BROWSER_BUNDLE_IDS, BROWSER_WINDOW_OPEN_TIMEOUT_MS, CHROME_FAMILY_APP_NAMES, CHROME_FAMILY_BUNDLE_IDS } from "./constants.ts";
export { COMMAND_TIMEOUT_MS, CURRENT_TARGET_GONE_ERROR, DEFAULT_WAIT_MS, HELPER_SETUP_TIMEOUT_MS, MISSING_TARGET_ERROR, NON_MACOS_ERROR, RECOVERABLE_SCREENSHOT_ERROR_CODES, SCREENSHOT_TIMEOUT_MS } from "./constants.ts";

export { HELPER_STABLE_PATH, HelperCommandError, HelperTransportError, PACKAGE_ROOT, SETUP_HELPER_SCRIPT, addRefreshHint, axDiagnosticsFromResult, axTargetByRef } from "./runtime.ts";
export { axTargetLabelKey, currentRuntimeMode, currentTargetOrThrow, emptyActivation, ensurePointIsInCapture, executionTrace, formatAxTargetLabel, isElementRefInvalid } from "./runtime.ts";
export { isRecoverableScreenshotError, nativeWindowRequest, normalizeClickCount, normalizeDragPath, normalizeError, normalizeKeyList, normalizeMouseButton, normalizeScrollDelta } from "./runtime.ts";
export { normalizeText, parseAxTargets, randomStateId, rejectAllPending, runtimeState, settleMsForExecution, sleep, strictModeBlock } from "./runtime.ts";
export { throwIfAborted, toBoolean, toFiniteNumber, toOptionalString, trimOrUndefined, validateStateId, windowWriteLockKey, withWindowWriteLock } from "./runtime.ts";

export { bridgeCommand, checkPermissions, ensureBridgeProcess, ensureBridgeReady, ensureHelperInstalled, ensureReady, getRuntimeStateSnapshot, handleHelperStdoutChunk } from "./bridge-ipc.ts";
export { isExecutable, runProcess, startBridgeProcess, stopBridge } from "./bridge-ipc.ts";

export { appMatchesWindowQuery, assertBrowserUseAllowed, browserOpenLocationAppleScript, escapeAppleScriptString, focusControlledWindow, formatAppLine, formatWindowLine, getFrontmost } from "./discovery.ts";
export { isBrowserApp, listApps, listWindows, openBrowserLocationFromPendingAddress, parseApps, parseFramePoints, parseWindows, runAppleScript } from "./discovery.ts";
export { storeWindowRef, storeWindowRefForAppWindow, storeWindowRefForTarget, windowRecordIdentity } from "./discovery.ts";

export { chooseAppByQuery, choosePreferredWindow, chooseRankedWindowOrUndefined, chooseWindowByTitle, ensureTargetWindowId, matchesScreenshotSelection, normalizeWindowSelector, resolveCurrentTarget } from "./targeting.ts";
export { resolveFrontmostTarget, resolveTargetByWindowSelector, resolveTargetForScreenshot, scoreWindow, selectWindowIfProvided, setCurrentTarget, summarizeWindowCandidate, summarizeWindowCandidates } from "./targeting.ts";
export { toResolvedTarget } from "./targeting.ts";

export { buildActionResult, captureCurrentTarget, captureForTarget, ensureCaptureImage, helperScreenshot, imageFallbackReason, reacquireAxTarget, recoverCaptureFromHelperFailure } from "./capture.ts";
export { windowsByCaptureRecoveryPriority } from "./capture.ts";

export type { ScrollAttemptResult } from "./actions.ts";
export { dispatchClick, dispatchDrag, dispatchKeypress, dispatchMoveMouse, dispatchScroll, dispatchSetText, dispatchTypeText, dragAdjustment } from "./actions.ts";
export { focusAxElement, focusBrowserAddressField, focusedTextElementRef, isCommandL, runCoordinateAction, scrollStepCount, semanticActionsForKeys, setAxValue } from "./actions.ts";
export { tryAxAdjustElement, tryAxScrollAtPoint, tryAxScrollElement, tryFocusedAxKeyAction, tryWindowAxKeyAction, windowButtonForSemanticKey } from "./actions.ts";

export { actionMayChangeState, actionWindowMatchesTarget, dispatchComputerAction, frameForArrangePreset, normalizeImageMode, performArrangeWindow, performClick, performComputerActions } from "./perform.ts";
export { performDoubleClick, performDrag, performKeypress, performListApps, performListWindows, performMoveMouse, performNavigateBrowser, performScreenshot } from "./perform.ts";
export { performScroll, performSetText, performTypeText, performWait } from "./perform.ts";

