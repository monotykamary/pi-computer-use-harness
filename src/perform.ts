/**
 * Public perform* API — the harness server and CLI call these directly.
 *
 * Each perform* function resolves the target window, dispatches the
 * action, captures the resulting state, and returns a structured result
 * * with text output and detailed metadata.
 */

import type { ArrangeWindowParams, BatchActionTrace, ClickParams, ComputerAction, ComputerActionsParams, ComputerUseDetails, CurrentCapture, DragParams, ExecutionTrace, ImageMode, KeypressParams, ListAppsDetails } from "./types.ts";
import type { ListWindowsDetails, ListWindowsParams, MoveMouseParams, NavigateBrowserParams, ResolvedTarget, ScreenshotParams, ScrollParams, SetTextParams, TypeTextParams, WaitParams, WindowSelector } from "./types.ts";
import { ACTION_SETTLE_MS, BATCH_ACTION_GAP_MS, BATCH_MAX_ACTIONS, COMMAND_TIMEOUT_MS, DEFAULT_WAIT_MS, MISSING_TARGET_ERROR } from "./constants.ts";
import { getComputerUseConfig } from "./config.ts";
import { addRefreshHint, emptyActivation, executionTrace, formatAxTargetLabel, nativeWindowRequest, normalizeClickCount, normalizeError, normalizeKeyList } from "./runtime.ts";
import { normalizeMouseButton, runtimeState, settleMsForExecution, sleep, toBoolean, toFiniteNumber, trimOrUndefined, validateStateId } from "./runtime.ts";
import { withWindowWriteLock } from "./runtime.ts";
import { bridgeCommand } from "./bridge-ipc.ts";
import { appMatchesWindowQuery, assertBrowserUseAllowed, browserOpenLocationAppleScript, focusControlledWindow, formatAppLine, formatWindowLine, isBrowserApp, listApps } from "./discovery.ts";
import { listWindows, runAppleScript, storeWindowRefForAppWindow } from "./discovery.ts";
import { ensureTargetWindowId, matchesScreenshotSelection, normalizeWindowSelector, resolveCurrentTarget, resolveTargetByWindowSelector, resolveTargetForScreenshot, scoreWindow, selectWindowIfProvided } from "./targeting.ts";
import { captureCurrentTarget, buildActionResult } from "./capture.ts";
import { dispatchClick, dispatchDrag, dispatchKeypress, dispatchMoveMouse, dispatchScroll, dispatchSetText, dispatchTypeText, runCoordinateAction } from "./actions.ts";

export async function performListApps(signal?: AbortSignal): Promise<{ content: Array<{ type: string; text: string }>; details: ListAppsDetails }> {
	const apps = await listApps(signal);
	const config = getComputerUseConfig();
	const details: ListAppsDetails = {
		action: "list_apps",
		apps: apps.map((app) => ({
			app: app.appName,
			bundleId: app.bundleId,
			pid: app.pid,
			isFrontmost: app.isFrontmost === true,
			browserUseAllowed: config.browser_use || !isBrowserApp(app.appName, app.bundleId),
		})),
		config,
	};
	const lines = details.apps.map(formatAppLine);
	const text = lines.length
		? `Found ${lines.length} running app${lines.length === 1 ? "" : "s"}. Use list_windows with app, bundleId, or pid to inspect target windows.\n${lines.join("\n")}`
		: "No running apps were available to pi-computer-use.";
	return { content: [{ type: "text", text }], details };
}

export async function performListWindows(params: ListWindowsParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text: string }>; details: ListWindowsDetails }> {
	const rawParams = params ?? {};
	const query: ListWindowsParams = {
		app: trimOrUndefined(rawParams.app),
		bundleId: trimOrUndefined(rawParams.bundleId),
		pid: Number.isFinite(rawParams.pid) ? Math.trunc(rawParams.pid!) : undefined,
	};
	const apps = (await listApps(signal)).filter((app) => appMatchesWindowQuery(app, query));
	if (apps.length === 0) {
		throw new Error(
			`No running app matched list_windows query${query.app ? ` app='${query.app}'` : ""}${query.bundleId ? ` bundleId='${query.bundleId}'` : ""}${query.pid ? ` pid=${query.pid}` : ""}. Call list_apps to inspect running apps.`,
		);
	}

	const config = getComputerUseConfig();
	const windows: ListWindowsDetails["windows"] = [];
	for (const app of apps) {
		const appWindows = await listWindows(app.pid, signal);
		for (const window of appWindows) {
			const storedRef = storeWindowRefForAppWindow(app, window);
			windows.push({
				app: app.appName,
				bundleId: app.bundleId,
				pid: app.pid,
				windowTitle: window.title || "(untitled)",
				windowId: window.windowId,
				windowRef: storedRef.ref,
				nativeWindowRef: window.windowRef,
				framePoints: window.framePoints,
				scaleFactor: window.scaleFactor,
				isMinimized: window.isMinimized,
				isOnscreen: window.isOnscreen,
				isMain: window.isMain,
				isFocused: window.isFocused,
				browserUseAllowed: config.browser_use || !isBrowserApp(app.appName, app.bundleId),
				score: scoreWindow(window),
			});
		}
	}
	windows.sort((a, b) => b.score - a.score || a.app.localeCompare(b.app) || a.windowTitle.localeCompare(b.windowTitle));

	const details: ListWindowsDetails = { action: "list_windows", query, windows, config };
	const lines = windows.map(formatWindowLine);
	const text = lines.length
		? `Found ${lines.length} controllable window${lines.length === 1 ? "" : "s"}. Use the @w refs with: pi-computer-use screenshot --window @wN\n${lines.join("\n")}`
		: `No controllable windows matched the query. Try opening a window, or call list_apps to confirm the app is running.`;
	return { content: [{ type: "text", text }], details };
}

export function normalizeImageMode(value: unknown): ImageMode {
	return value === "always" || value === "never" ? value : "auto";
}

export async function performScreenshot(params: ScreenshotParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	const selection = {
		app: trimOrUndefined(params.app),
		windowTitle: trimOrUndefined(params.windowTitle),
		window: normalizeWindowSelector(params.window),
	};

	const requestedTarget = selection.window
		? await resolveTargetByWindowSelector(params.window!, signal)
		: await resolveTargetForScreenshot(selection, signal);
	const captureResult = await captureCurrentTarget(signal);
	if (!matchesScreenshotSelection(captureResult.target, selection)) {
		throw new Error(
			`Screenshot target drifted from the requested selection. Requested ${requestedTarget.appName} — ${requestedTarget.windowTitle}, captured ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Call screenshot again or specify a more exact window title.`,
		);
	}
	const summary = `Captured ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
	return await buildActionResult("screenshot", summary, captureResult, executionTrace("screenshot", "stealth", { fallbackUsed: false }), signal, normalizeImageMode(params.image));
}

export async function performClick(params: ClickParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const button = normalizeMouseButton(params.button);
	const clickCount = normalizeClickCount(params.clickCount);

	return await runCoordinateAction(
		"click",
		capture,
		signal,
		async (target) => await dispatchClick({ ...params, clickCount }, capture, target, signal),
		(target) => {
			if (ref) {
				const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
				return `Clicked ${axTarget ? formatAxTargetLabel(axTarget) : ref} in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
			}
			return `${clickCount > 1 ? "Double-clicked" : button === "left" ? "Clicked" : `${button}-clicked`} at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
		},
	);
}

export async function performTypeText(params: TypeTextParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const text = typeof params.text === "string" ? params.text : "";
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatchTypeText(text, readyTarget, signal);

			stateMayHaveChanged = true;
			await sleep(settleMsForExecution(execution), signal);
			const captureResult = await captureCurrentTarget(signal, activation);
			const summary = `Inserted text in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
			return await buildActionResult("type_text", summary, captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

export async function performSetText(params: SetTextParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const text = typeof params.text === "string" ? params.text : "";
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatchSetText({ ...params, text }, readyTarget, signal);

			stateMayHaveChanged = true;
			await sleep(settleMsForExecution(execution), signal);
			const captureResult = await captureCurrentTarget(signal, activation);
			const summary = `Set text value in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
			return await buildActionResult("set_text", summary, captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

export async function performKeypress(params: KeypressParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const keys = normalizeKeyList(params.keys);
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatchKeypress({ keys }, readyTarget, signal);

			stateMayHaveChanged = true;
			await sleep(settleMsForExecution(execution), signal);
			const captureResult = await captureCurrentTarget(signal, activation);
			const summary = `Pressed ${keys.length} key${keys.length === 1 ? "" : "s"} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
			return await buildActionResult("keypress", summary, captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

export async function performScroll(params: ScrollParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	return await runCoordinateAction(
		"scroll",
		capture,
		signal,
		async (target) => await dispatchScroll(params, capture, target, signal),
		(target) =>
			ref
				? `Scrolled ${ref} in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`
				: `Scrolled at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

export async function performMoveMouse(params: MoveMouseParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	return await runCoordinateAction(
		"move_mouse",
		capture,
		signal,
		async (target) => await dispatchMoveMouse(params, capture, target, signal),
		(target) =>
			`Moved mouse to (${Math.round(params.x)},${Math.round(params.y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

export async function performDrag(params: DragParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	return await runCoordinateAction(
		"drag",
		capture,
		signal,
		async (target) => await dispatchDrag(params, capture, target, signal),
		(target) => `Dragged in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`,
	);
}

export async function performDoubleClick(params: ClickParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	return await runCoordinateAction(
		"double_click",
		capture,
		signal,
		async (target) => await dispatchClick({ ...params, clickCount: 2 }, capture, target, signal),
		(target) => {
			if (ref) {
				const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
				return `Double-clicked ${axTarget ? formatAxTargetLabel(axTarget) : ref} in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
			}
			return `Double-clicked at (${Math.round(x)},${Math.round(y)}) in ${target.appName} — ${target.windowTitle}. Returned the latest semantic window state.`;
		},
	);
}

export async function dispatchComputerAction(
	action: ComputerAction,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	switch (action.type) {
		case "click":
			return await dispatchClick(action, capture, target, signal);
		case "double_click":
			return await dispatchClick({ ...action, clickCount: 2 }, capture, target, signal);
		case "move_mouse":
			return await dispatchMoveMouse(action, capture, target, signal);
		case "drag":
			return await dispatchDrag(action, capture, target, signal);
		case "scroll":
			return await dispatchScroll(action, capture, target, signal);
		case "keypress":
			return await dispatchKeypress(action, target, signal);
		case "type_text":
			return await dispatchTypeText(action.text, target, signal);
		case "set_text":
			return await dispatchSetText(action, target, signal);
		case "wait": {
			const msRaw = action.ms ?? DEFAULT_WAIT_MS;
			if (!Number.isFinite(msRaw) || msRaw < 0) {
				throw new Error("wait.ms must be a non-negative number.");
			}
			await sleep(Math.min(60_000, Math.round(msRaw)), signal);
			return executionTrace("wait", "stealth", { fallbackUsed: false });
		}
		default:
			throw new Error(`Unsupported computer action '${(action as any)?.type ?? "unknown"}'.`);
	}
}

export function actionMayChangeState(action: ComputerAction | undefined): boolean {
	return action?.type !== "wait";
}

export function actionWindowMatchesTarget(selector: WindowSelector | undefined, target: ResolvedTarget): boolean {
	const normalized = normalizeWindowSelector(selector);
	if (!normalized) return true;
	if (target.windowRef === normalized) return true;
	const numeric = Number(normalized);
	return Number.isInteger(numeric) && numeric > 0 && target.windowId === numeric;
}

export function frameForArrangePreset(params: ArrangeWindowParams, target: ResolvedTarget): { x: number; y: number; width: number; height: number } {
	if (params.preset === "left_half") return { x: 0, y: 25, width: 720, height: 875 };
	if (params.preset === "right_half") return { x: 720, y: 25, width: 720, height: 875 };
	if (params.preset === "top_half") return { x: 80, y: 25, width: 1200, height: 440 };
	if (params.preset === "bottom_half") return { x: 80, y: 465, width: 1200, height: 435 };
	if (params.preset === "center_large") return { x: 80, y: 80, width: 1200, height: 800 };
	return {
		x: toFiniteNumber(params.x, target.framePoints.x),
		y: toFiniteNumber(params.y, target.framePoints.y),
		width: toFiniteNumber(params.width, target.framePoints.w),
		height: toFiniteNumber(params.height, target.framePoints.h),
	};
}

export async function performArrangeWindow(params: ArrangeWindowParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	const frame = frameForArrangePreset(params, target);
	if (![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width < 100 || frame.height < 80) {
		throw new Error("arrange_window requires finite x, y, width, and height values, or a supported preset.");
	}
	return await withWindowWriteLock(target, async () => {
		const result = await bridgeCommand<any>(
			"setWindowFrame",
			{ ...nativeWindowRequest(target), x: frame.x, y: frame.y, width: frame.width, height: frame.height },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		);
		if (!toBoolean(result?.ok)) {
			throw new Error(`Unable to arrange window${result?.reason ? `: ${result.reason}` : "."}`);
		}
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal);
		return await buildActionResult(
			"arrange_window",
			`Arranged ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`,
			captureResult,
			executionTrace("window_frame", "stealth", { fallbackUsed: false }),
			signal,
		);
	});
}

export async function performNavigateBrowser(params: NavigateBrowserParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const target = await ensureTargetWindowId(await resolveCurrentTarget(signal), signal);
	assertBrowserUseAllowed(target);
	if (!isBrowserApp(target.appName, target.bundleId)) {
		throw new Error(`navigate_browser requires a browser window, but the target is '${target.appName}'.`);
	}
	const url = trimOrUndefined(params.url);
	if (!url) {
		throw new Error("navigate_browser.url must be a non-empty URL or browser-search string.");
	}
	const script = browserOpenLocationAppleScript(target, url);
	if (!script) {
		throw new Error(`navigate_browser does not yet support direct URL navigation for '${target.appName}'. Use keypress Command+L, type_text, Enter instead.`);
	}
	return await withWindowWriteLock(target, async () => {
		await focusControlledWindow(target, signal);
		await runAppleScript(script, signal);
		await sleep(ACTION_SETTLE_MS, signal);
		const captureResult = await captureCurrentTarget(signal);
		return await buildActionResult(
			"navigate_browser",
			`Navigated ${captureResult.target.windowRef ? `${captureResult.target.windowRef} ` : ""}${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`,
			captureResult,
			executionTrace("browser_open_location", "stealth", { axAttempted: false, axSucceeded: false, fallbackUsed: false }),
			signal,
		);
	});
}

export async function performComputerActions(params: ComputerActionsParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	const capture = validateStateId(params.stateId);
	const actions = Array.isArray(params.actions) ? params.actions : [];
	if (actions.length === 0) {
		throw new Error("computer_actions.actions must contain at least one action.");
	}
	if (actions.length > BATCH_MAX_ACTIONS) {
		throw new Error(`computer_actions supports at most ${BATCH_MAX_ACTIONS} actions per call.`);
	}

	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		let axAttempted = false;
		let axSucceeded = false;
		let fallbackUsed = false;
		let stealthCompatible = true;
		const nonStealthReasons = new Set<string>();
		const actionTraces: BatchActionTrace[] = [];

		for (let index = 0; index < actions.length; index += 1) {
			const action = actions[index];
			if (!action || typeof (action as any).type !== "string") {
				throw new Error(`computer_actions action ${index + 1} is missing a valid type.`);
			}
			if (!actionWindowMatchesTarget((action as any).window, readyTarget)) {
				throw new Error(
					`computer_actions action ${index + 1} targets a different window. Use one computer_actions call per window, or set the top-level window field to the intended target.`,
				);
			}
			const actionStateId = (action as any)?.stateId;
			if (actionStateId && actionStateId !== capture.stateId) {
				throw new Error(`computer_actions action ${index + 1} uses stale state '${actionStateId}'. Refresh with screenshot and retry.`);
			}
			let trace: ExecutionTrace;
			const startedAt = Date.now();
			try {
				trace = await dispatchComputerAction(action, capture, readyTarget, signal);
			} catch (error) {
				const actionType = (action as any)?.type ?? "unknown";
				throw new Error(`computer_actions action ${index + 1} (${actionType}) failed: ${normalizeError(error).message}`);
			}
			actionTraces.push({
				index: index + 1,
				type: action.type,
				strategy: trace.strategy,
				durationMs: Math.max(0, Date.now() - startedAt),
				axAttempted: trace.axAttempted,
				axSucceeded: trace.axSucceeded,
				fallbackUsed: trace.fallbackUsed,
				runtimeMode: trace.runtimeMode,
				variant: trace.variant,
				stealthCompatible: trace.stealthCompatible,
				nonStealthReason: trace.nonStealthReason,
			});
			if (actionMayChangeState(action)) {
				stateMayHaveChanged = true;
			}
			axAttempted ||= trace.axAttempted === true;
			axSucceeded ||= trace.axSucceeded === true;
			fallbackUsed ||= trace.fallbackUsed === true;
			stealthCompatible &&= trace.stealthCompatible === true;
			if (trace.nonStealthReason) {
				nonStealthReasons.add(trace.nonStealthReason);
			}
			if (index + 1 < actions.length && action?.type !== "wait") {
				await sleep(BATCH_ACTION_GAP_MS, signal);
			}
		}

		const execution = executionTrace("batch", stealthCompatible ? "stealth" : "default", {
			actionCount: actions.length,
			completedActionCount: actionTraces.length,
			actions: actionTraces,
			axAttempted,
			axSucceeded,
			fallbackUsed,
			nonStealthReason: nonStealthReasons.size > 0 ? [...nonStealthReasons].join(",") : undefined,
		});
		await sleep(settleMsForExecution(execution), signal);
		const captureResult = await captureCurrentTarget(signal, activation);
		const summary = `Executed ${actions.length} computer action${actions.length === 1 ? "" : "s"} in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
		return await buildActionResult("computer_actions", summary, captureResult, execution, signal);
	} catch (error) {
		if (stateMayHaveChanged) {
			await sleep(ACTION_SETTLE_MS, signal).catch(() => undefined);
			await captureCurrentTarget(signal, activation).catch(() => undefined);
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}

export async function performWait(params: WaitParams, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	runtimeState.currentImageMode = normalizeImageMode(params.image);
	await selectWindowIfProvided(params.window, signal);
	if (!runtimeState.currentTarget) {
		throw new Error(MISSING_TARGET_ERROR);
	}

	const msRaw = params.ms ?? DEFAULT_WAIT_MS;
	if (!Number.isFinite(msRaw) || msRaw < 0) {
		throw new Error("wait.ms must be a non-negative number.");
	}

	const ms = Math.min(60_000, Math.round(msRaw));
	await sleep(ms, signal);
	const captureResult = await captureCurrentTarget(signal);
	const summary = `Waited ${ms}ms in ${captureResult.target.appName} — ${captureResult.target.windowTitle}. Returned the latest semantic window state.`;
	return await buildActionResult("wait", summary, captureResult, executionTrace("wait", "stealth", { fallbackUsed: false }), signal);
}

