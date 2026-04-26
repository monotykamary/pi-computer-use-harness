/**
 * Type definitions for pi-computer-use.
 *
 * All param interfaces, result details, helper-internal types,
 * and runtime state shape. Pure types — no runtime code.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PermissionStatus } from "./permissions.ts";

export type WindowSelector = string | number;
export type ImageMode = "auto" | "always" | "never";

export interface StateTargetSnapshot {
	pid: number;
	windowId: number;
	windowRef?: string;
}

export interface ScreenshotParams {
	app?: string;
	windowTitle?: string;
	window?: WindowSelector;
	image?: ImageMode;
}

export interface ListWindowsParams {
	app?: string;
	bundleId?: string;
	pid?: number;
}

export interface WindowTargetParams {
	window?: WindowSelector;
	stateId?: string;
	image?: ImageMode;
}

export interface ClickParams extends WindowTargetParams {
	x?: number;
	y?: number;
	ref?: string;
	button?: MouseButtonName;
	clickCount?: number;
}

export interface TypeTextParams extends WindowTargetParams {
	text: string;
}

export interface SetTextParams extends WindowTargetParams {
	text: string;
	ref?: string;
}

export interface KeypressParams extends WindowTargetParams {
	keys: string[];
}

export interface ScrollParams extends WindowTargetParams {
	x?: number;
	y?: number;
	ref?: string;
	scrollX?: number;
	scrollY?: number;
}

export interface MoveMouseParams extends WindowTargetParams {
	x: number;
	y: number;
}

export interface DragParams extends WindowTargetParams {
	path?: Array<{ x: number; y: number } | [number, number]>;
	ref?: string;
}

export type ComputerAction =
	| ({ type: "click" } & ClickParams)
	| ({ type: "double_click" } & ClickParams)
	| ({ type: "move_mouse" } & MoveMouseParams)
	| ({ type: "drag" } & DragParams)
	| ({ type: "scroll" } & ScrollParams)
	| ({ type: "keypress" } & KeypressParams)
	| ({ type: "type_text" } & TypeTextParams)
	| ({ type: "set_text" } & SetTextParams)
	| ({ type: "wait" } & WaitParams);

export interface ComputerActionsParams extends WindowTargetParams {
	actions: ComputerAction[];
}

export interface ArrangeWindowParams extends WindowTargetParams {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
	preset?: "center_large" | "left_half" | "right_half" | "top_half" | "bottom_half";
}

export interface NavigateBrowserParams extends WindowTargetParams {
	url: string;
}

export interface WaitParams extends WindowTargetParams {
	ms?: number;
}

export interface CurrentTarget {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId: number;
	windowRef?: string;
	nativeWindowRef?: string;
}

export interface CurrentCapture {
	stateId: string;
	width: number;
	height: number;
	scaleFactor: number;
	timestamp: number;
}

export interface ActivationFlags {
	activated: boolean;
	unminimized: boolean;
	raised: boolean;
}

export type ExecutionVariant = "stealth" | "default";

export interface ExecutionTrace {
	strategy:
		| "screenshot"
		| "wait"
		| "batch"
		| "window_frame"
		| "ax_press"
		| "ax_focus"
		| "coordinate_event_click"
		| "coordinate_event_double_click"
		| "coordinate_event_move"
		| "coordinate_event_drag"
		| "coordinate_event_scroll"
		| "ax_scroll"
		| "ax_action"
		| "browser_open_location"
		| "ax_set_value"
		| "raw_keypress"
		| "raw_key_text";
	axAttempted?: boolean;
	axSucceeded?: boolean;
	fallbackUsed?: boolean;
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	nonStealthReason?: string;
	actionCount?: number;
	completedActionCount?: number;
	actions?: BatchActionTrace[];
}

export interface BatchActionTrace {
	index: number;
	type: string;
	strategy: ExecutionTrace["strategy"];
	durationMs: number;
	axAttempted?: boolean;
	axSucceeded?: boolean;
	fallbackUsed?: boolean;
	runtimeMode?: ExecutionVariant;
	variant?: ExecutionVariant;
	stealthCompatible?: boolean;
	nonStealthReason?: string;
}

export interface ComputerUseDetails {
	action: string;
	target: {
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId: number;
		windowRef?: string;
		nativeWindowRef?: string;
	};
	capture: {
		stateId: string;
		width: number;
		height: number;
		scaleFactor: number;
		timestamp: number;
		coordinateSpace: "window-relative-screenshot-pixels";
	};
	axTargets?: AxTarget[];
	activation: ActivationFlags;
	execution: ExecutionTrace;
	config?: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
	status?: "ok";
	axDiagnostics?: {
		reason?: string;
		message?: string;
	};
	imageReason?:
		| "fallback_recovery"
		| "browser_ax_window_unavailable"
		| "no_ax_targets"
		| "sparse_ax_targets"
		| "weak_ax_targets"
		| "unlabeled_ax_targets"
		| "duplicated_ax_labels"
		| "browser_wait_verification";
}

export interface ListAppsDetails {
	action: "list_apps";
	apps: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		isFrontmost: boolean;
		browserUseAllowed: boolean;
	}>;
	config: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
}

export interface ListWindowsDetails {
	action: "list_windows";
	query: ListWindowsParams;
	windows: Array<{
		app: string;
		bundleId?: string;
		pid: number;
		windowTitle: string;
		windowId?: number;
		windowRef: string;
		nativeWindowRef?: string;
		framePoints: FramePoints;
		scaleFactor: number;
		isMinimized: boolean;
		isOnscreen: boolean;
		isMain: boolean;
		isFocused: boolean;
		browserUseAllowed: boolean;
		score: number;
	}>;
	config: {
		browser_use: boolean;
		stealth_mode: boolean;
	};
}

export interface HelperApp {
	appName: string;
	bundleId?: string;
	pid: number;
	isFrontmost?: boolean;
}

export interface FramePoints {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface HelperWindow {
	windowId?: number;
	windowRef?: string;
	title: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

export interface FrontmostResult {
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle?: string;
	windowId?: number;
}



export interface ScreenshotPayload {
	pngBase64: string;
	width: number;
	height: number;
	scaleFactor: number;
}

export interface FocusedElementResult {
	exists: boolean;
	elementRef?: string;
	role?: string;
	subrole?: string;
	isTextInput?: boolean;
	isSecure?: boolean;
	canSetValue?: boolean;
}

export interface FocusWindowResult {
	focused: boolean;
	alreadyFocused?: boolean;
	reason?: string;
}

export interface AxPressAtPointResult {
	pressed: boolean;
	reason?: string;
}

export interface AxFocusResult {
	focused: boolean;
	reason?: string;
}

export interface HelperAxTarget {
	elementRef?: string;
	role?: string;
	subrole?: string;
	title?: string;
	description?: string;
	value?: string;
	actions?: string[];
	isTextInput?: boolean;
	canSetValue?: boolean;
	canFocus?: boolean;
	canPress?: boolean;
	canScroll?: boolean;
	canIncrement?: boolean;
	canDecrement?: boolean;
	x?: number;
	y?: number;
	score?: number;
}

export interface ResolvedTarget extends CurrentTarget {
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

export interface PendingRequest {
	cmd: string;
	resolve: (value: any) => void;
	reject: (reason?: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
	abortListener?: () => void;
}

export interface AxTarget {
	ref: string;
	elementRef: string;
	role: string;
	subrole: string;
	title: string;
	description: string;
	value: string;
	actions: string[];
	isTextInput: boolean;
	canSetValue: boolean;
	canFocus: boolean;
	canPress: boolean;
	canScroll: boolean;
	canIncrement: boolean;
	canDecrement: boolean;
	x: number;
	y: number;
	score?: number;
}

export interface PendingBrowserAddress {
	text: string;
	pid: number;
	windowId: number;
}

export interface WindowRefRecord {
	ref: string;
	appName: string;
	bundleId?: string;
	pid: number;
	windowTitle: string;
	windowId?: number;
	nativeWindowRef?: string;
	framePoints: FramePoints;
	scaleFactor: number;
	isMinimized: boolean;
	isOnscreen: boolean;
	isMain: boolean;
	isFocused: boolean;
}

export interface RuntimeState {
	currentTarget?: CurrentTarget;
	currentCapture?: CurrentCapture;
	currentStateTarget?: StateTargetSnapshot;
	currentImageMode?: ImageMode;
	currentAxTargets?: AxTarget[];
	windowRefs: Map<string, WindowRefRecord>;
	windowRefByIdentity: Map<string, string>;
	windowWriteQueues: Map<string, Promise<void>>;
	nextWindowRefIndex: number;
	allowNextTypeTextAxReplacement?: boolean;
	pendingBrowserAddress?: PendingBrowserAddress;
	helper?: ChildProcessWithoutNullStreams;
	helperStdoutBuffer: string;
	pending: Map<string, PendingRequest>;
	requestSequence: number;
	permissionStatus?: PermissionStatus;
	lastPermissionCheckAt: number;
	helperInstallChecked: boolean;
}

export type MouseButtonName = "left" | "right" | "middle";

export interface CaptureResult {
	target: ResolvedTarget;
	capture: CurrentCapture;
	image?: ScreenshotPayload;
	axTargets: AxTarget[];
	axDiagnostics?: { reason?: string; message?: string };
	activation: ActivationFlags;
}