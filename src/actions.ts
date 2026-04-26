/**
 * Action dispatchers — click, type, keypress, scroll, drag, move, arrange, navigate.
 *
 * Each dispatch* function takes action params and a resolved target,
 * performs the action via the Swift helper, and returns an ExecutionTrace.
 */

import path from "node:path";
import type { AxFocusResult, AxPressAtPointResult, AxTarget, ClickParams, ComputerUseDetails, CurrentCapture, DragParams, ExecutionTrace, FocusedElementResult, KeypressParams, MoveMouseParams, ResolvedTarget } from "./types.ts";
import type { ScrollParams, SetTextParams } from "./types.ts";
import { COMMAND_TIMEOUT_MS } from "./constants.ts";
import { isStrictAxMode } from "./config.ts";
import { addRefreshHint, axTargetByRef, axTargetLabelKey, emptyActivation, ensurePointIsInCapture, executionTrace, isElementRefInvalid, nativeWindowRequest } from "./runtime.ts";
import { normalizeClickCount, normalizeDragPath, normalizeError, normalizeKeyList, normalizeMouseButton, normalizeScrollDelta, normalizeText, parseAxTargets } from "./runtime.ts";
import { runtimeState, settleMsForExecution, sleep, strictModeBlock, toBoolean, toFiniteNumber, toOptionalString, trimOrUndefined } from "./runtime.ts";
import { withWindowWriteLock } from "./runtime.ts";
import { bridgeCommand } from "./bridge-ipc.ts";
import { focusControlledWindow, isBrowserApp, openBrowserLocationFromPendingAddress } from "./discovery.ts";
import { ensureTargetWindowId, resolveCurrentTarget } from "./targeting.ts";
import { captureCurrentTarget, reacquireAxTarget , buildActionResult } from "./capture.ts";

export async function dispatchClick(
	params: ClickParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const button = normalizeMouseButton(params.button);
	const clickCount = normalizeClickCount(params.clickCount);

	if (ref) {
		if (button !== "left") {
			throw new Error(`AX target refs only support left-button clicks. Use coordinates for ${button}-click.`);
		}
		const attemptRefClick = async (axTarget: AxTarget): Promise<{ clickedViaAX: boolean; focusedViaAX: boolean }> => {
			let clickedViaAX = false;
			let focusedViaAX = false;
			for (let index = 0; index < clickCount; index += 1) {
				try {
					const axResult = await bridgeCommand<AxPressAtPointResult>(
						"axPressElement",
						{ elementRef: axTarget.elementRef, pid: target.pid },
						{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
					);
					clickedViaAX = toBoolean(axResult?.pressed);
				} catch {
					clickedViaAX = false;
				}
				if (!clickedViaAX) break;
				if (index + 1 < clickCount) {
					await sleep(60, signal);
				}
			}

			if (!clickedViaAX && clickCount === 1) {
				try {
					const focusResult = await bridgeCommand<AxFocusResult>(
						"axFocusElement",
						{ elementRef: axTarget.elementRef, pid: target.pid },
						{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
					);
					focusedViaAX = toBoolean(focusResult?.focused);
				} catch {
					focusedViaAX = false;
				}
			}
			return { clickedViaAX, focusedViaAX };
		};

		const axTarget = axTargetByRef(ref);
		let { clickedViaAX, focusedViaAX } = await attemptRefClick(axTarget);
		if (!clickedViaAX && !focusedViaAX) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				({ clickedViaAX, focusedViaAX } = await attemptRefClick(reacquired));
			}
		}

		if (!clickedViaAX && !focusedViaAX) {
			throw new Error(`AX click/focus could not be completed for ${ref}.`);
		}

		return executionTrace(clickedViaAX ? "ax_press" : "ax_focus", "stealth", {
			axAttempted: true,
			axSucceeded: true,
			fallbackUsed: false,
		});
	}

	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error("click requires either ref or both x and y.");
	}
	ensurePointIsInCapture(x, y, capture);

	let clickedViaAX = false;
	let focusedViaAX = false;
	const canTryAX = button === "left" && clickCount === 1;
	if (canTryAX) {
		try {
			const axResult = await bridgeCommand<AxPressAtPointResult>(
				"axPressAtPoint",
				{
					...nativeWindowRequest(target),
					x,
					y,
					captureWidth: capture.width,
					captureHeight: capture.height,
				},
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			);
			clickedViaAX = toBoolean(axResult?.pressed);
		} catch {
			clickedViaAX = false;
		}

		if (!clickedViaAX) {
			try {
				const focusResult = await bridgeCommand<AxFocusResult>(
					"axFocusAtPoint",
					{
						...nativeWindowRequest(target),
						x,
						y,
						captureWidth: capture.width,
						captureHeight: capture.height,
					},
					{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
				);
				focusedViaAX = toBoolean(focusResult?.focused);
			} catch {
				focusedViaAX = false;
			}
		}
	}

	if (!clickedViaAX && !focusedViaAX) {
		if (isStrictAxMode()) {
			strictModeBlock(`AX click/focus could not be completed at (${Math.round(x)},${Math.round(y)}).`);
		}
		await bridgeCommand(
			"mouseClick",
			{
				...nativeWindowRequest(target),
				x,
				y,
				button,
				clickCount,
				captureWidth: capture.width,
				captureHeight: capture.height,
			},
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		);
	}

	const usedAxPath = clickedViaAX || focusedViaAX;
	return executionTrace(
		clickedViaAX ? "ax_press" : focusedViaAX ? "ax_focus" : clickCount > 1 ? "coordinate_event_double_click" : "coordinate_event_click",
		usedAxPath ? "stealth" : "default",
		{
			axAttempted: canTryAX,
			axSucceeded: usedAxPath,
			fallbackUsed: canTryAX && !usedAxPath,
			nonStealthReason: usedAxPath ? undefined : "coordinate_mouse_click_requires_pointer_event",
		},
	);
}

export async function dispatchTypeText(text: string, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	if (runtimeState.allowNextTypeTextAxReplacement) {
		runtimeState.allowNextTypeTextAxReplacement = false;
		const focusedElementRef = await focusedTextElementRef(target, signal);
		if (focusedElementRef) {
			await setAxValue(focusedElementRef, text, signal);
			if (isBrowserApp(target.appName, target.bundleId)) {
				runtimeState.pendingBrowserAddress = { text, pid: target.pid, windowId: target.windowId };
			}
			return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
		}
	}
	if (isStrictAxMode()) {
		strictModeBlock("Raw text insertion is not AX-only. Use set_text for AX value replacement.");
	}
	await focusControlledWindow(target, signal);
	await bridgeCommand(
		"typeText",
		{ text, pid: target.pid },
		{ signal, timeoutMs: Math.min(90_000, Math.max(COMMAND_TIMEOUT_MS, text.length * 25 + 4_000)) },
	);
	return executionTrace("raw_key_text", "default", {
		axAttempted: false,
		axSucceeded: false,
		fallbackUsed: false,
		nonStealthReason: "raw_text_insertion_requires_keyboard_focus",
	});
}

export async function focusedTextElementRef(target: ResolvedTarget, signal?: AbortSignal): Promise<string | undefined> {
	const focused: FocusedElementResult = await bridgeCommand<FocusedElementResult>(
		"focusedElement",
		nativeWindowRequest(target),
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => ({ exists: false } as FocusedElementResult));

	if (!focused.exists || !focused.isTextInput || !focused.canSetValue || !focused.elementRef) {
		return undefined;
	}
	return focused.elementRef;
}

export async function setAxValue(elementRef: string, text: string, signal?: AbortSignal): Promise<void> {
	await bridgeCommand(
		"setValue",
		{
			elementRef,
			value: text,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
}

export async function focusAxElement(elementRef: string, target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const result = await bridgeCommand<AxFocusResult>(
		"axFocusElement",
		{ elementRef, pid: target.pid },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	return toBoolean(result?.focused);
}

export async function dispatchSetText(params: SetTextParams, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	if (ref) {
		let axTarget = axTargetByRef(ref);
		if (axTarget.canSetValue !== false) {
			try {
				await setAxValue(axTarget.elementRef, params.text, signal);
				return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
			} catch (error) {
				if (isElementRefInvalid(error)) {
					const reacquired = await reacquireAxTarget(axTarget, target, signal);
					if (reacquired && reacquired.canSetValue !== false) {
						axTarget = reacquired;
						await setAxValue(axTarget.elementRef, params.text, signal);
						return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
					}
				}
				if (isStrictAxMode()) {
					throw normalizeError(error);
				}
			}
		}

		if (isStrictAxMode()) {
			strictModeBlock(`AX target '${ref}' does not expose a directly settable AX value.`);
		}

		let focusedViaRef = await focusAxElement(axTarget.elementRef, target, signal);
		if (!focusedViaRef) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				axTarget = reacquired;
				focusedViaRef = await focusAxElement(axTarget.elementRef, target, signal);
			}
		}
		if (focusedViaRef) {
			const focusedElementRef = await focusedTextElementRef(target, signal);
			if (focusedElementRef) {
				await setAxValue(focusedElementRef, params.text, signal);
				return executionTrace("ax_set_value", "stealth", {
					axAttempted: true,
					axSucceeded: true,
					fallbackUsed: false,
				});
			}
		}
	}

	const focusedElementRef = await focusedTextElementRef(target, signal);
	if (focusedElementRef) {
		await setAxValue(focusedElementRef, params.text, signal);
		return executionTrace("ax_set_value", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	if (isStrictAxMode()) {
		strictModeBlock("set_text in stealth mode requires a text AX ref from the latest screenshot or an already-focused text control.");
	}

	await focusControlledWindow(target, signal);
	const focusedAfterWindowFocus = await focusedTextElementRef(target, signal);
	if (!focusedAfterWindowFocus) {
		throw new Error("AX value replacement requires a text AX ref or focused text control. Use set_text with ref from the latest screenshot when available.");
	}
	await setAxValue(focusedAfterWindowFocus, params.text, signal);
	return executionTrace("ax_set_value", "default", {
		axAttempted: true,
		axSucceeded: true,
		fallbackUsed: true,
		nonStealthReason: "set_text_without_ref_requires_window_focus_fallback",
	});
}

export function isCommandL(keys: string[]): boolean {
	return keys.length === 1 && /^(cmd|command|meta)\+l$/i.test(keys[0].replace(/\s+/g, ""));
}

export async function focusBrowserAddressField(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	if (!isCommandL(keys) || !isBrowserApp(target.appName, target.bundleId)) return false;

	const focusedTextInput = await bridgeCommand<{ focused?: boolean; elementRef?: string }>(
		"axFocusTextInput",
		nativeWindowRequest(target),
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	if (toBoolean(focusedTextInput?.focused)) {
		runtimeState.allowNextTypeTextAxReplacement = true;
		return true;
	}

	const refreshed = parseAxTargets(
		await bridgeCommand(
			"axListTargets",
			{ ...nativeWindowRequest(target), limit: 50 },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => []),
	);
	if (!refreshed.length) return false;
	runtimeState.currentAxTargets = refreshed;
	const field = refreshed
		.filter((candidate) => candidate.canFocus && candidate.isTextInput && (candidate.role === "AXTextField" || candidate.role === "AXSearchField"))
		.sort((a, b) => a.y - b.y || a.x - b.x)[0];
	if (!field) return false;
	const focused = await focusAxElement(field.elementRef, target, signal);
	if (focused) runtimeState.allowNextTypeTextAxReplacement = true;
	return focused;
}

export function semanticActionsForKeys(keys: string[]): string[] {
	if (keys.length !== 1) return [];
	const key = keys[0].trim().toLowerCase();
	if (["enter", "return"].includes(key)) return ["confirm", "press"];
	if (["escape", "esc"].includes(key)) return ["cancel"];
	if (["space", "spacebar", " "].includes(key)) return ["press"];
	return [];
}

export function windowButtonForSemanticKey(keys: string[], targets: AxTarget[]): AxTarget | undefined {
	if (keys.length !== 1) return undefined;
	const key = keys[0].trim().toLowerCase();
	const buttons = targets.filter((target) => target.canPress && target.role === "AXButton");
	if (["escape", "esc"].includes(key)) {
		return buttons.find((target) => ["cancel", "don't save", "dont save"].includes(axTargetLabelKey(target)));
	}
	if (["enter", "return"].includes(key)) {
		return (
			buttons.find((target) => normalizeText(target.subrole).includes("default")) ??
			buttons.find((target) => ["ok", "done", "save", "add", "continue", "open", "choose"].includes(axTargetLabelKey(target)))
		);
	}
	return undefined;
}

export async function tryWindowAxKeyAction(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const refreshed = parseAxTargets(
		await bridgeCommand(
			"axListTargets",
			{ ...nativeWindowRequest(target), limit: 50 },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => []),
	);
	if (!refreshed.length) return false;
	runtimeState.currentAxTargets = refreshed;
	const button = windowButtonForSemanticKey(keys, refreshed);
	if (!button) return false;
	const result = await bridgeCommand<{ performed?: boolean }>(
		"axPerformActionElement",
		{ elementRef: button.elementRef, pid: target.pid, action: "press" },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch(() => undefined);
	return toBoolean(result?.performed);
}

export async function tryFocusedAxKeyAction(keys: string[], target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	const actions = semanticActionsForKeys(keys);
	if (!actions.length) return false;
	const focused = await focusedTextElementRef(target, signal);
	if (!focused) {
		const rawFocused = await bridgeCommand<FocusedElementResult>(
			"focusedElement",
			nativeWindowRequest(target),
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (!rawFocused?.exists || !rawFocused.elementRef) return await tryWindowAxKeyAction(keys, target, signal);
		for (const action of actions) {
			const result = await bridgeCommand<{ performed?: boolean }>(
				"axPerformActionElement",
				{ elementRef: rawFocused.elementRef, pid: target.pid, action },
				{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
			).catch(() => undefined);
			if (toBoolean(result?.performed)) return true;
		}
		return await tryWindowAxKeyAction(keys, target, signal);
	}
	for (const action of actions) {
		const result = await bridgeCommand<{ performed?: boolean }>(
			"axPerformActionElement",
			{ elementRef: focused, pid: target.pid, action },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (toBoolean(result?.performed)) return true;
	}
	return await tryWindowAxKeyAction(keys, target, signal);
}

export async function dispatchKeypress(params: KeypressParams, target: ResolvedTarget, signal?: AbortSignal): Promise<ExecutionTrace> {
	const keys = normalizeKeyList(params.keys);
	if (keys.length === 0) {
		throw new Error("keypress.keys must contain at least one key.");
	}

	const openedPendingBrowserLocation = await openBrowserLocationFromPendingAddress(keys, target, signal);
	if (openedPendingBrowserLocation) {
		return executionTrace("browser_open_location", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const focusedAddressViaAX = await focusBrowserAddressField(keys, target, signal);
	if (focusedAddressViaAX) {
		return executionTrace("ax_focus", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const performedViaAX = await tryFocusedAxKeyAction(keys, target, signal);
	if (performedViaAX) {
		return executionTrace("ax_action", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	if (isStrictAxMode()) {
		strictModeBlock("Keypress is not AX-only and no semantic AX equivalent was available.");
	}
	await focusControlledWindow(target, signal);
	await bridgeCommand("keyPress", { keys, pid: target.pid }, { signal, timeoutMs: COMMAND_TIMEOUT_MS });
	return executionTrace("raw_keypress", "default", {
		axAttempted: semanticActionsForKeys(keys).length > 0,
		axSucceeded: false,
		fallbackUsed: semanticActionsForKeys(keys).length > 0,
		nonStealthReason: "keypress_requires_keyboard_focus",
	});
}

export function scrollStepCount(delta: number): number {
	return Math.max(1, Math.min(8, Math.ceil(Math.abs(delta) / 500)));
}

export interface ScrollAttemptResult {
	scrolled: boolean;
	reason?: string;
}

export async function tryAxScrollElement(elementRef: string, target: ResolvedTarget, scrollX: number, scrollY: number, signal?: AbortSignal): Promise<ScrollAttemptResult> {
	const result = await bridgeCommand<{ scrolled?: boolean; reason?: string }>(
		"axScrollElement",
		{ elementRef, pid: target.pid, scrollX, scrollY, steps: Math.max(scrollStepCount(scrollX), scrollStepCount(scrollY)) },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((error) => ({ scrolled: false, reason: normalizeError(error).message }));
	return { scrolled: toBoolean(result?.scrolled), reason: toOptionalString(result?.reason) };
}

export async function tryAxScrollAtPoint(
	target: ResolvedTarget,
	capture: CurrentCapture,
	x: number,
	y: number,
	scrollX: number,
	scrollY: number,
	signal?: AbortSignal,
): Promise<ScrollAttemptResult> {
	const result = await bridgeCommand<{ scrolled?: boolean; reason?: string }>(
		"axScrollAtPoint",
		{
			...nativeWindowRequest(target),
			x,
			y,
			scrollX,
			scrollY,
			steps: Math.max(scrollStepCount(scrollX), scrollStepCount(scrollY)),
			captureWidth: capture.width,
			captureHeight: capture.height,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((error) => ({ scrolled: false, reason: normalizeError(error).message }));
	return { scrolled: toBoolean(result?.scrolled), reason: toOptionalString(result?.reason) };
}

export async function dispatchScroll(
	params: ScrollParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const ref = trimOrUndefined(params.ref);
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	const scrollX = normalizeScrollDelta(params.scrollX);
	const scrollY = normalizeScrollDelta(params.scrollY);
	if (scrollX === 0 && scrollY === 0) {
		throw new Error("scroll requires a non-zero scrollX or scrollY.");
	}

	let scrollAttempt: ScrollAttemptResult = { scrolled: false };
	if (ref) {
		const axTarget = axTargetByRef(ref);
		scrollAttempt = await tryAxScrollElement(axTarget.elementRef, target, scrollX, scrollY, signal);
		if (!scrollAttempt.scrolled) {
			const reacquired = await reacquireAxTarget(axTarget, target, signal);
			if (reacquired) {
				scrollAttempt = await tryAxScrollElement(reacquired.elementRef, target, scrollX, scrollY, signal);
			}
		}
	} else if (Number.isFinite(x) && Number.isFinite(y)) {
		ensurePointIsInCapture(x, y, capture);
		scrollAttempt = await tryAxScrollAtPoint(target, capture, x, y, scrollX, scrollY, signal);
	} else {
		throw new Error("scroll requires either ref or both x and y. If the target came from an old state, call screenshot again and retry with a current @e scroll ref or coordinates.");
	}

	if (scrollAttempt.scrolled) {
		return executionTrace("ax_scroll", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}

	const reasonText = scrollAttempt.reason ? ` Reason: ${scrollAttempt.reason}.` : "";
	if (isStrictAxMode()) {
		strictModeBlock(ref ? `AX scroll could not be completed for ${ref}.${reasonText}` : `AX scroll could not be completed at (${Math.round(x)},${Math.round(y)}).${reasonText}`);
	}
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`Coordinate scroll fallback requires x and y.${reasonText} Provide coordinates from the latest screenshot or use a current AX scroll target.`);
	}
	ensurePointIsInCapture(x, y, capture);
	await bridgeCommand(
		"scrollWheel",
		{
			...nativeWindowRequest(target),
			x,
			y,
			scrollX,
			scrollY,
			captureWidth: capture.width,
			captureHeight: capture.height,
		},
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace("coordinate_event_scroll", "default", {
		axAttempted: true,
		axSucceeded: false,
		fallbackUsed: true,
		nonStealthReason: "coordinate_scroll_requires_pointer_event",
	});
}

export async function dispatchMoveMouse(
	params: MoveMouseParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	if (isStrictAxMode()) {
		strictModeBlock("Mouse movement is not AX-only.");
	}
	const x = toFiniteNumber(params.x, NaN);
	const y = toFiniteNumber(params.y, NaN);
	ensurePointIsInCapture(x, y, capture);
	await bridgeCommand(
		"mouseMove",
		{ ...nativeWindowRequest(target), x, y, captureWidth: capture.width, captureHeight: capture.height },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace("coordinate_event_move", "default", {
		axAttempted: false,
		axSucceeded: false,
		fallbackUsed: false,
		nonStealthReason: "mouse_move_requires_cursor_control",
	});
}

export function dragAdjustment(path: Array<{ x: number; y: number }> | undefined): { action: "increment" | "decrement"; steps: number } | undefined {
	if (!path || path.length < 2) return undefined;
	const first = path[0];
	const last = path[path.length - 1];
	const dx = last.x - first.x;
	const dy = last.y - first.y;
	const primary = Math.abs(dx) >= Math.abs(dy) ? dx : -dy;
	if (Math.abs(primary) < 4) return undefined;
	return { action: primary > 0 ? "increment" : "decrement", steps: Math.max(1, Math.min(20, Math.round(Math.abs(primary) / 20))) };
}

export async function tryAxAdjustElement(axTarget: AxTarget, adjustment: { action: "increment" | "decrement"; steps: number }, target: ResolvedTarget, signal?: AbortSignal): Promise<boolean> {
	if (adjustment.action === "increment" && !axTarget.canIncrement) return false;
	if (adjustment.action === "decrement" && !axTarget.canDecrement) return false;
	let performed = false;
	for (let index = 0; index < adjustment.steps; index += 1) {
		const result = await bridgeCommand<{ performed?: boolean }>(
			"axPerformActionElement",
			{ elementRef: axTarget.elementRef, pid: target.pid, action: adjustment.action },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => undefined);
		if (!toBoolean(result?.performed)) break;
		performed = true;
	}
	return performed;
}

export async function dispatchDrag(
	params: DragParams,
	capture: CurrentCapture,
	target: ResolvedTarget,
	signal?: AbortSignal,
): Promise<ExecutionTrace> {
	const path = params.path ? normalizeDragPath(params.path, capture) : undefined;
	const ref = trimOrUndefined(params.ref);
	let adjustedViaAX = false;
	if (ref && path) {
		const axTarget = axTargetByRef(ref);
		const adjustment = dragAdjustment(path);
		if (adjustment) {
			adjustedViaAX = await tryAxAdjustElement(axTarget, adjustment, target, signal);
			if (!adjustedViaAX) {
				const reacquired = await reacquireAxTarget(axTarget, target, signal);
				if (reacquired) adjustedViaAX = await tryAxAdjustElement(reacquired, adjustment, target, signal);
			}
		}
	}
	if (adjustedViaAX) {
		return executionTrace("ax_action", "stealth", { axAttempted: true, axSucceeded: true, fallbackUsed: false });
	}
	if (isStrictAxMode()) {
		strictModeBlock(ref ? `AX adjustment could not be completed for ${ref}.` : "Drag is not AX-only.");
	}
	if (!path) {
		throw new Error("drag requires path points for pointer fallback or a ref plus path for AX adjustment.");
	}
	await bridgeCommand(
		"mouseDrag",
		{ ...nativeWindowRequest(target), path, captureWidth: capture.width, captureHeight: capture.height },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	);
	return executionTrace("coordinate_event_drag", "default", {
		axAttempted: Boolean(ref),
		axSucceeded: false,
		fallbackUsed: Boolean(ref),
		nonStealthReason: "drag_requires_pointer_event",
	});
}

export async function runCoordinateAction(
	action: string,
	capture: CurrentCapture,
	signal: AbortSignal | undefined,
	dispatch: (target: ResolvedTarget) => Promise<ExecutionTrace>,
	summaryFactory: (target: ResolvedTarget) => string,
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	const currentTarget = await resolveCurrentTarget(signal);
	let activation = emptyActivation();
	let stateMayHaveChanged = false;

	try {
		const readyTarget = await ensureTargetWindowId(currentTarget, signal);
		return await withWindowWriteLock(readyTarget, async () => {
			const execution = await dispatch(readyTarget);
			stateMayHaveChanged = true;

			await sleep(settleMsForExecution(execution), signal);
			const captureResult = await captureCurrentTarget(signal, activation);
			return await buildActionResult(action, summaryFactory(captureResult.target), captureResult, execution, signal);
		});
	} catch (error) {
		if (stateMayHaveChanged) {
			throw addRefreshHint(error);
		}
		throw normalizeError(error);
	}
}