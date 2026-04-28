/**
 * Runtime state singleton, error classes, and utility functions.
 *
 * Holds the global mutable state shared across all modules,
 * plus small helpers for normalization, validation, locking, etc.
 * No dependencies on bridge-ipc, discovery, targeting, or capture.
 */

import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ActivationFlags, AxTarget, CaptureResult, CurrentCapture, CurrentTarget, DragParams, ExecutionTrace, ExecutionVariant, HelperAxTarget, MouseButtonName, ResolvedTarget, RuntimeState } from "./types.ts";
import { ACTION_SETTLE_MS, MISSING_TARGET_ERROR, RECOVERABLE_SCREENSHOT_ERROR_CODES } from "./constants.ts";
import { isStrictAxMode } from "./config.ts";


export const HELPER_STABLE_PATH = path.join(os.homedir(), ".pi", "agent", "helpers", "pi-computer-use", "bridge");

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SETUP_HELPER_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "setup-helper.mjs");

export const runtimeState: RuntimeState = {
	helperStdoutBuffer: "",
	pending: new Map(),
	requestSequence: 0,
	lastPermissionCheckAt: 0,
	helperInstallChecked: false,
	allowNextTypeTextAxReplacement: false,
	windowRefs: new Map(),
	windowRefByIdentity: new Map(),
	windowWriteQueues: new Map(),
	nextWindowRefIndex: 1,
};

export class HelperTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HelperTransportError";
	}
}

export class HelperCommandError extends Error {
	readonly code?: string;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HelperCommandError";
		this.code = code;
	}
}

export const BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT = [
	"Browser JavaScript Apple Events are disabled for the target browser.",
	'Ask the user to enable "Allow JavaScript from Apple Events" in the browser\'s developer menu, then retry the browser action.',
].join(" ");

export function isBrowserJavaScriptAppleEventsErrorMessage(message: string): boolean {
	return /not allowed to send javascript commands/i.test(message)
		|| /executing javascript through applescript is turned off/i.test(message)
		|| /allow javascript from apple events/i.test(message)
		|| /enable javascript from apple events/i.test(message)
		|| (/javascript/i.test(message) && /apple events/i.test(message));
}

export function appendBrowserJavaScriptAppleEventsHint(error: Error): Error {
	if (!isBrowserJavaScriptAppleEventsErrorMessage(error.message) || error.message.includes(BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT)) {
		return error;
	}
	const enhanced = new Error(`${error.message}\n\n${BROWSER_JAVASCRIPT_APPLE_EVENTS_HINT}`);
	enhanced.name = error.name;
	return enhanced;
}

export function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function isRecoverableScreenshotError(error: unknown): error is HelperCommandError {
	return error instanceof HelperCommandError && !!error.code && RECOVERABLE_SCREENSHOT_ERROR_CODES.has(error.code);
}

export function currentRuntimeMode(): ExecutionVariant {
	return isStrictAxMode() ? "stealth" : "default";
}

export function executionTrace(
	strategy: ExecutionTrace["strategy"],
	variant: ExecutionVariant,
	metadata: Omit<ExecutionTrace, "strategy" | "runtimeMode" | "variant" | "stealthCompatible"> = {},
): ExecutionTrace {
	return {
		strategy,
		runtimeMode: currentRuntimeMode(),
		variant,
		stealthCompatible: variant === "stealth",
		...metadata,
	};
}

export function strictModeBlock(message: string): never {
	throw new Error(`${message} Stealth/strict AX mode is enabled, so non-AX, foreground-focus, and cursor fallbacks are blocked.`);
}

export function settleMsForExecution(execution: ExecutionTrace): number {
	if (execution.strategy === "batch") {
		const actions = execution.actions ?? [];
		return actions.length > 0 && actions.every((action) => action.variant === "stealth") ? 120 : ACTION_SETTLE_MS;
	}
	if (execution.variant === "stealth") {
		switch (execution.strategy) {
			case "ax_focus":
			case "ax_set_value":
				return 80;
			case "ax_action":
			case "browser_open_location":
			case "ax_scroll":
				return 120;
			case "ax_press":
				return 160;
			default:
				return 120;
		}
	}
	return ACTION_SETTLE_MS;
}

export function addRefreshHint(error: unknown): Error {
	const message = normalizeError(error).message;
	if (/call screenshot/i.test(message)) {
		return new Error(message);
	}
	return new Error(`${message} Call screenshot again to refresh the current window state.`);
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error("Operation aborted.");
	}
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return;
	throwIfAborted(signal);

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const onAbort = () => {
			cleanup();
			reject(new Error("Operation aborted."));
		};

		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function windowWriteLockKey(target: ResolvedTarget | CurrentTarget): string {
	return target.windowId > 0 ? `pid:${target.pid}:window:${target.windowId}` : `pid:${target.pid}:ref:${target.windowRef ?? target.windowTitle}`;
}

export async function withWindowWriteLock<T>(target: ResolvedTarget | CurrentTarget, work: () => Promise<T>): Promise<T> {
	const key = windowWriteLockKey(target);
	const previous = runtimeState.windowWriteQueues.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.catch(() => undefined).then(() => next);
	runtimeState.windowWriteQueues.set(key, queued);
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
		if (runtimeState.windowWriteQueues.get(key) === queued) {
			runtimeState.windowWriteQueues.delete(key);
		}
	}
}

export function randomStateId(): string {
	try {
		return randomUUID();
	} catch {
		return `cap_${Date.now()}_${Math.random().toString(16).slice(2)}`;
	}
}

export function trimOrUndefined(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeText(value: string | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

export function toFiniteNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

export function toOptionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function toBoolean(value: unknown): boolean {
	return value === true;
}

export function normalizeMouseButton(value: unknown): MouseButtonName {
	if (value === "right" || value === "middle" || value === "left") {
		return value;
	}
	return "left";
}

export function normalizeClickCount(value: unknown, fallback = 1): number {
	const count = Math.trunc(toFiniteNumber(value, fallback));
	return Math.max(1, Math.min(3, count));
}

export function normalizeScrollDelta(value: unknown): number {
	const delta = Math.round(toFiniteNumber(value, 0));
	return Math.max(-10_000, Math.min(10_000, delta));
}

export function normalizeKeyList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string" && key.trim().length > 0) : [];
}

export function ensurePointIsInCapture(
	x: number,
	y: number,
	capture: CurrentCapture,
	errorPrefix = "Coordinates",
): void {
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`${errorPrefix} must be finite numbers.`);
	}
	if (x < 0 || y < 0 || x >= capture.width || y >= capture.height) {
		throw new Error(
			`${errorPrefix} (${Math.round(x)},${Math.round(y)}) are outside the latest screenshot bounds (${capture.width}x${capture.height}). Call screenshot again and retry.`,
		);
	}
}

export function normalizeDragPath(path: DragParams["path"], capture: CurrentCapture): Array<{ x: number; y: number }> {
	if (!Array.isArray(path) || path.length < 2) {
		throw new Error("drag.path must contain at least two points.");
	}

	return path.map((point, index) => {
		const x = Array.isArray(point) ? toFiniteNumber(point[0], NaN) : toFiniteNumber(point?.x, NaN);
		const y = Array.isArray(point) ? toFiniteNumber(point[1], NaN) : toFiniteNumber(point?.y, NaN);
		ensurePointIsInCapture(x, y, capture, `Drag point ${index + 1}`);
		return { x, y };
	});
}

export function validateStateId(stateId?: string): CurrentCapture {
	if (!runtimeState.currentTarget || !runtimeState.currentCapture) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	const supplied = stateId;
	if (supplied && runtimeState.currentCapture.stateId !== supplied) {
		throw new Error(
			`Stale state '${supplied}'. The latest state is '${runtimeState.currentCapture.stateId}' for ${runtimeState.currentTarget.windowRef ?? "the current window"}. Call screenshot${runtimeState.currentTarget.windowRef ? `({ window: "${runtimeState.currentTarget.windowRef}" })` : ""} again and retry.`,
		);
	}
	const stateTarget = runtimeState.currentStateTarget;
	if (stateTarget && (stateTarget.pid !== runtimeState.currentTarget.pid || stateTarget.windowId !== runtimeState.currentTarget.windowId)) {
		throw new Error("The latest state belongs to a different window. Call screenshot for the target window and retry.");
	}
	return runtimeState.currentCapture;
}

export function axDiagnosticsFromResult(result: unknown, target: ResolvedTarget): CaptureResult["axDiagnostics"] {
	const reason = toOptionalString((result as any)?.reason);
	if (!reason) return undefined;
	if (reason === "window_not_found") {
		const windowHint = target.windowRef ? ` Use list_windows and choose an existing content window such as ${target.windowRef}, then call: pi-computer-use screenshot --window ${target.windowRef}.` : " Use list_windows and choose an existing content window.";
		return { reason, message: `Accessibility could not resolve the target browser window. Duplicate/empty browser windows can cause this.${windowHint}` };
	}
	return { reason, message: `Accessibility target listing returned '${reason}'.` };
}

export function parseAxTargets(result: unknown): AxTarget[] {
	const items = Array.isArray(result) ? result : (result as any)?.targets;
	if (!Array.isArray(items)) return [];

	return items
		.map((raw, index) => {
			const target = raw as HelperAxTarget;
			const elementRef = toOptionalString(target?.elementRef);
			if (!elementRef) return undefined;
			const actions = Array.isArray(target?.actions) ? target.actions.filter((value): value is string => typeof value === "string") : [];
			return {
				ref: `@e${index + 1}`,
				elementRef,
				role: toOptionalString(target?.role) ?? "",
				subrole: toOptionalString(target?.subrole) ?? "",
				title: toOptionalString(target?.title) ?? "",
				description: toOptionalString(target?.description) ?? "",
				value: toOptionalString(target?.value) ?? "",
				actions,
				isTextInput: toBoolean(target?.isTextInput),
				canSetValue: toBoolean(target?.canSetValue),
				canFocus: toBoolean(target?.canFocus),
				canPress: toBoolean(target?.canPress),
				canScroll: toBoolean(target?.canScroll),
				canIncrement: toBoolean(target?.canIncrement),
				canDecrement: toBoolean(target?.canDecrement),
				x: toFiniteNumber(target?.x, 0),
				y: toFiniteNumber(target?.y, 0),
				score: Number.isFinite(target?.score) ? Number(target.score) : undefined,
			} as AxTarget;
		})
		.filter((item): item is AxTarget => Boolean(item));
}

export function formatAxTargetLabel(target: AxTarget): string {
	const label = target.title || target.description || target.value || "(unlabeled)";
	const capabilities = [
		target.canSetValue ? "setValue" : undefined,
		target.canPress ? "press" : undefined,
		target.canFocus ? "focus" : undefined,
		target.canScroll ? "scroll" : undefined,
		target.canIncrement || target.canDecrement ? "adjust" : undefined,
	].filter((item): item is string => Boolean(item));
	return `${target.ref} ${target.role}${target.subrole ? `/${target.subrole}` : ""} ${JSON.stringify(label)}${capabilities.length ? ` [${capabilities.join(",")}]` : ""}`;
}

export function axTargetByRef(ref: string): AxTarget {
	const axTarget = runtimeState.currentAxTargets?.find((candidate) => candidate.ref === ref);
	if (!axTarget) {
		const windowHint = runtimeState.currentTarget?.windowRef ? `({ window: "${runtimeState.currentTarget.windowRef}" })` : "";
		throw new Error(`AX target '${ref}' is stale or not available for the latest state. Call screenshot${windowHint} again and choose a current @e ref.`);
	}
	return axTarget;
}

export function axTargetLabelKey(target: AxTarget): string {
	return normalizeText(target.title || target.description || target.value);
}

export function isElementRefInvalid(error: unknown): boolean {
	return (error instanceof HelperCommandError && error.code === "element_ref_invalid") || /element reference is no longer valid|element_ref_invalid/i.test(normalizeError(error).message);
}

export function currentTargetOrThrow(): CurrentTarget {
	if (!runtimeState.currentTarget) {
		throw new Error(MISSING_TARGET_ERROR);
	}
	return runtimeState.currentTarget;
}

export function emptyActivation(): ActivationFlags {
	return { activated: false, unminimized: false, raised: false };
}

export function rejectAllPending(error: Error): void {
	for (const [id, pending] of runtimeState.pending) {
		clearTimeout(pending.timer);
		if (pending.abortListener) {
			pending.abortListener();
		}
		runtimeState.pending.delete(id);
		pending.reject(error);
	}
}

export function nativeWindowRequest(target: Pick<CurrentTarget, "pid" | "windowId" | "nativeWindowRef">): { pid: number; windowId: number; windowRef?: string } {
	return { pid: target.pid, windowId: target.windowId, windowRef: target.nativeWindowRef };
}