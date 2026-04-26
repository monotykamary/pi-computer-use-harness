/**
 * Screenshot capture, AX target parsing, image fallback logic.
 *
 * Captures the current window state via the native helper,
 * parses AX accessibility targets, and decides when to attach
 * a PNG image for visual fallback.
 */

import type { ActivationFlags, AxTarget, ComputerUseDetails, CurrentCapture, ExecutionTrace, HelperApp, HelperWindow, ImageMode, ResolvedTarget, ScreenshotPayload , CaptureResult } from "./types.ts";
import { getComputerUseConfig } from "./config.ts";
import { COMMAND_TIMEOUT_MS, CURRENT_TARGET_GONE_ERROR, SCREENSHOT_TIMEOUT_MS } from "./constants.ts";
import { HelperCommandError, axDiagnosticsFromResult, axTargetLabelKey, emptyActivation, isRecoverableScreenshotError, nativeWindowRequest, normalizeError, normalizeText , formatAxTargetLabel } from "./runtime.ts";
import { parseAxTargets, randomStateId, runtimeState, toFiniteNumber, toOptionalString } from "./runtime.ts";
import { bridgeCommand } from "./bridge-ipc.ts";
import { isBrowserApp, listWindows } from "./discovery.ts";
import { ensureTargetWindowId, resolveCurrentTarget, scoreWindow, setCurrentTarget, toResolvedTarget } from "./targeting.ts";

export async function reacquireAxTarget(stale: AxTarget, target: ResolvedTarget, signal?: AbortSignal): Promise<AxTarget | undefined> {
	const refreshed = parseAxTargets(
		await bridgeCommand(
			"axListTargets",
			{ ...nativeWindowRequest(target), limit: 50 },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch(() => []),
	);
	if (!refreshed.length) return undefined;
	runtimeState.currentAxTargets = refreshed;

	const staleLabel = axTargetLabelKey(stale);
	const candidates = refreshed.filter((candidate) => {
		if (candidate.role !== stale.role) return false;
		if (staleLabel && axTargetLabelKey(candidate) !== staleLabel) return false;
		if (stale.canSetValue && !candidate.canSetValue) return false;
		if (stale.canPress && !candidate.canPress) return false;
		if (stale.canScroll && !candidate.canScroll) return false;
		if (stale.canIncrement && !candidate.canIncrement) return false;
		if (stale.canDecrement && !candidate.canDecrement) return false;
		return true;
	});
	const pool = candidates.length ? candidates : refreshed.filter((candidate) => staleLabel && axTargetLabelKey(candidate) === staleLabel);
	const best = pool.sort((a, b) => Math.hypot(a.x - stale.x, a.y - stale.y) - Math.hypot(b.x - stale.x, b.y - stale.y))[0];
	return best ? { ...best, ref: stale.ref } : undefined;
}

export function imageFallbackReason(
	action: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	imageMode: ImageMode = "auto",
): { reason: NonNullable<ComputerUseDetails["imageReason"]>; message: string } | undefined {
	if (imageMode === "never") return undefined;
	if (imageMode === "always") return { reason: "fallback_recovery", message: "An image was requested explicitly for visual verification." };
	if (execution.fallbackUsed === true) {
		return { reason: "fallback_recovery", message: "The action used a fallback path, so an image is attached for recovery." }
	}
	if (result.axTargets.length === 0) {
		if (isBrowserApp(result.target.appName, result.target.bundleId) && result.axDiagnostics?.reason === "window_not_found") {
			return { reason: "browser_ax_window_unavailable", message: result.axDiagnostics.message ?? "The browser window could not be resolved through Accessibility, so an image is attached for recovery." }
		}
		return { reason: "no_ax_targets", message: "No useful AX targets were found, so an image is attached for vision fallback." }
	}
	if (result.axTargets.length < 3) {
		return { reason: "sparse_ax_targets", message: "Only a few AX targets were found, so an image is attached for extra context." }
	}

	const labels = result.axTargets.map((target) => normalizeText(target.title || target.description || target.value)).filter(Boolean)
	const unlabeledCount = result.axTargets.filter((target) => !normalizeText(target.title || target.description || target.value)).length
	const strongTextRoles = new Set(["AXTextField", "AXSearchField", "AXTextArea", "AXTextView", "AXEditableText"])
	const strongTargets = result.axTargets.filter((target) => {
		const label = normalizeText(target.title || target.description || target.value)
		return strongTextRoles.has(target.role) || (!!label && (target.actions.includes("AXPress") || target.role === "AXLink" || target.role === "AXButton"))
	})
	if (strongTargets.length === 0) {
		return { reason: "weak_ax_targets", message: "No strong AX targets were found, so an image is attached for vision fallback." }
	}
	if (result.axTargets.length < 3 && !strongTargets.some((target) => strongTextRoles.has(target.role))) {
		return { reason: "sparse_ax_targets", message: "Only a few AX targets were found, so an image is attached for extra context." }
	}
	if (result.axTargets.length >= 3 && unlabeledCount * 2 > result.axTargets.length) {
		return { reason: "unlabeled_ax_targets", message: "Most AX targets are unlabeled, so an image is attached for vision fallback." }
	}
	if (labels.length > 3 && new Set(labels).size * 2 <= labels.length) {
		return { reason: "duplicated_ax_labels", message: "AX target labels are highly duplicated, so an image is attached for extra context." }
	}
	if (action === "wait" && isBrowserApp(result.target.appName, result.target.bundleId)) {
		return { reason: "browser_wait_verification", message: "Browser content may have changed visually during wait, so an image is attached for fallback." }
	}
	return undefined
}

export async function helperScreenshot(windowId: number, signal?: AbortSignal): Promise<ScreenshotPayload> {
	const result = await bridgeCommand<any>(
		"screenshot",
		{ windowId },
		{ timeoutMs: SCREENSHOT_TIMEOUT_MS, signal },
	);

	const base64 = toOptionalString(result?.pngBase64);
	if (!base64) {
		throw new Error("Helper returned an invalid screenshot payload.");
	}

	return {
		pngBase64: base64,
		width: Math.max(1, Math.trunc(toFiniteNumber(result?.width, 1))),
		height: Math.max(1, Math.trunc(toFiniteNumber(result?.height, 1))),
		scaleFactor: Math.max(1, toFiniteNumber(result?.scaleFactor, 1)),
	};
}

export function windowsByCaptureRecoveryPriority(
	windows: HelperWindow[],
	target: ResolvedTarget,
	failureCode: string,
): HelperWindow[] {
	const sorted = [...windows].sort((a, b) => scoreWindow(b) - scoreWindow(a));
	if (failureCode !== "screenshot_timeout") {
		return sorted;
	}

	const alternatives = sorted.filter((window) => window.windowId !== target.windowId);
	const original = sorted.filter((window) => window.windowId === target.windowId);
	return [...alternatives, ...original];
}

export async function recoverCaptureFromHelperFailure(
	target: ResolvedTarget,
	error: HelperCommandError,
	signal?: AbortSignal,
): Promise<{ target: ResolvedTarget; image: ScreenshotPayload }> {
	const windows = await listWindows(target.pid, signal);
	if (!windows.length) {
		throw new Error(CURRENT_TARGET_GONE_ERROR);
	}

	const app: HelperApp = {
		appName: target.appName,
		bundleId: target.bundleId,
		pid: target.pid,
	};

	const orderedWindows = windowsByCaptureRecoveryPriority(windows, target, error.code ?? "");
	const candidates = orderedWindows.filter((window) => typeof window.windowId === "number" && window.windowId > 0).slice(0, 3);
	if (!candidates.length) {
		throw normalizeError(error);
	}

	let lastError: Error = normalizeError(error);
	for (const candidateWindow of candidates) {
		const candidateTarget = toResolvedTarget(app, candidateWindow);
		try {
			const image = await helperScreenshot(candidateTarget.windowId, signal);
			return { target: candidateTarget, image };
		} catch (candidateError) {
			if (!isRecoverableScreenshotError(candidateError)) {
				throw normalizeError(candidateError);
			}
			lastError = normalizeError(candidateError);
		}
	}

	throw lastError;
}

export function captureForTarget(target: ResolvedTarget): CurrentCapture {
	return {
		stateId: randomStateId(),
		width: Math.max(1, Math.round(target.framePoints.w * target.scaleFactor)),
		height: Math.max(1, Math.round(target.framePoints.h * target.scaleFactor)),
		scaleFactor: target.scaleFactor,
		timestamp: Date.now(),
	};
}

export async function ensureCaptureImage(result: CaptureResult, signal?: AbortSignal): Promise<void> {
	if (result.image) return;
	try {
		result.image = await helperScreenshot(result.target.windowId, signal);
		result.capture.width = result.image.width;
		result.capture.height = result.image.height;
		result.capture.scaleFactor = result.image.scaleFactor;
	} catch (error) {
		if (!isRecoverableScreenshotError(error)) {
			const normalized = normalizeError(error);
			if (isBrowserApp(result.target.appName, result.target.bundleId)) {
				throw new Error(`${normalized.message} Browser capture failed for ${result.target.appName} window '${result.target.windowTitle}'. Call list_windows and retry screenshot with an explicit existing content window ref, or use navigate_browser for direct URL navigation.`);
			}
			throw normalized;
		}
		const recovered = await recoverCaptureFromHelperFailure(result.target, error, signal);
		result.target = recovered.target;
		result.image = recovered.image;
		result.capture.width = recovered.image.width;
		result.capture.height = recovered.image.height;
		result.capture.scaleFactor = recovered.image.scaleFactor;
		const axResult = await bridgeCommand(
			"axListTargets",
			{ ...nativeWindowRequest(result.target), limit: 12 },
			{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
		).catch((axError) => ({ targets: [], reason: axError instanceof HelperCommandError ? (axError.code ?? "ax_list_failed") : "ax_list_failed" }));
		result.axTargets = parseAxTargets(axResult);
		result.axDiagnostics = axDiagnosticsFromResult(axResult, result.target);
	}
	setCurrentTarget(result.target);
	runtimeState.currentCapture = result.capture;
	runtimeState.currentStateTarget = { pid: result.target.pid, windowId: result.target.windowId, windowRef: result.target.windowRef };
	runtimeState.currentAxTargets = result.axTargets;
}

export async function captureCurrentTarget(signal?: AbortSignal, priorActivation = emptyActivation()): Promise<CaptureResult> {
	let target = await resolveCurrentTarget(signal);
	let activation = { ...priorActivation };

	target = await ensureTargetWindowId(target, signal);

	const capture = captureForTarget(target);
	const axResult = await bridgeCommand(
		"axListTargets",
		{ ...nativeWindowRequest(target), limit: 12 },
		{ signal, timeoutMs: COMMAND_TIMEOUT_MS },
	).catch((axError) => ({ targets: [], reason: axError instanceof HelperCommandError ? (axError.code ?? "ax_list_failed") : "ax_list_failed" }));
	const axTargets = parseAxTargets(axResult);
	const axDiagnostics = axDiagnosticsFromResult(axResult, target);

	setCurrentTarget(target);
	runtimeState.currentCapture = capture;
	runtimeState.currentStateTarget = { pid: target.pid, windowId: target.windowId, windowRef: target.windowRef };
	runtimeState.currentAxTargets = axTargets;

	return {
		target,
		capture,
		axTargets,
		axDiagnostics,
		activation,
	};
}

export async function buildActionResult(
	action: string,
	summary: string,
	result: CaptureResult,
	execution: ExecutionTrace,
	signal?: AbortSignal,
	imageMode: ImageMode = runtimeState.currentImageMode ?? "auto",
): Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: ComputerUseDetails }> {
	const fallbackReason = imageFallbackReason(action, result, execution, imageMode);
	if (fallbackReason) {
		await ensureCaptureImage(result, signal);
	}

	const details: ComputerUseDetails = {
		action,
		target: {
			app: result.target.appName,
			bundleId: result.target.bundleId,
			pid: result.target.pid,
			windowTitle: result.target.windowTitle,
			windowId: result.target.windowId,
			windowRef: result.target.windowRef ?? runtimeState.currentTarget?.windowRef,
			nativeWindowRef: result.target.nativeWindowRef ?? runtimeState.currentTarget?.nativeWindowRef,
		},
		capture: {
			stateId: result.capture.stateId,
			width: result.capture.width,
			height: result.capture.height,
			scaleFactor: result.capture.scaleFactor,
			timestamp: result.capture.timestamp,
			coordinateSpace: "window-relative-screenshot-pixels",
		},
		axTargets: result.axTargets,
		activation: result.activation,
		execution,
		axDiagnostics: result.axDiagnostics,
		status: "ok",
		config: getComputerUseConfig(),
		imageReason: fallbackReason?.reason,
	};
	const axTargetText = result.axTargets.length
		? `\n\nPrefer these AX targets over coordinate clicks or focus-based text replacement when one matches your intent:\n${result.axTargets.map(formatAxTargetLabel).join("\n")}`
		: "";
	const fallbackText = fallbackReason ? `\n\n${fallbackReason.message}` : "";
	const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [{ type: "text", text: `${summary}${axTargetText}${fallbackText}` }];
	if (fallbackReason) {
		content.push({ type: "image", data: result.image!.pngBase64, mimeType: "image/png" });
	}

	return { content, details };
}