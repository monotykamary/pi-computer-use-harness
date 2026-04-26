/**
 * pi-computer-use harness server.
 *
 * Long-lived HTTP server that holds runtimeState and the native Swift
 * helper process.  The CLI (`pi-computer-use screenshot`, etc.) sends
 * action requests here; the server dispatches against the same in-memory
 * state so window refs, AX targets, and capture metadata survive across
 * CLI calls.
 *
 * Endpoints (bind 127.0.0.1:9876 by default; override with $PI_COMPUTER_USE_PORT):
 *   POST /action   body = JSON { action, ...params }
 *                  Response: { ok: true, result: { text, details, imagePath? } } | { ok: false, error: string }
 *   GET  /health   { ok: true, uptime, pid }
 *   POST /quit     graceful shutdown
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	performArrangeWindow,
	performListApps,
	performListWindows,
	performClick,
	performComputerActions,
	performDoubleClick,
	performDrag,
	performKeypress,
	performMoveMouse,
	performNavigateBrowser,
	performScreenshot,
	performScroll,
	performSetText,
	performTypeText,
	performWait,
} from "../src/perform.ts";
import { ensureBridgeReady, getRuntimeStateSnapshot, stopBridge } from "../src/bridge-ipc.ts";
import type {
	ArrangeWindowParams,
	ClickParams,
	ComputerActionsParams,
	ComputerUseDetails,
	DragParams,
	KeypressParams,
	ListWindowsParams,
	MoveMouseParams,
	NavigateBrowserParams,
	ScreenshotParams,
	ScrollParams,
	SetTextParams,
	TypeTextParams,
	WaitParams,
} from "../src/types.ts";
import { loadComputerUseConfig } from "../src/config.js";

// =============================================================================
// Screenshot temp directory
// =============================================================================

const SCREENSHOT_DIR = path.join(os.tmpdir(), "pi-computer-use");

function ensureScreenshotDir(): void {
	if (!fs.existsSync(SCREENSHOT_DIR)) {
		fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
	}
}

function writeScreenshotPng(stateId: string, pngBase64: string): string {
	ensureScreenshotDir();
	const filePath = path.join(SCREENSHOT_DIR, `${stateId}.png`);
	const buffer = Buffer.from(pngBase64, "base64");
	fs.writeFileSync(filePath, buffer);
	return filePath;
}

// =============================================================================
// Action dispatch
// =============================================================================

type ActionParams = Record<string, unknown>;

interface HarnessResult {
	text: string;
	details: unknown;
	imagePath?: string;
}

function currentRuntimeMode(): "stealth" | "default" {
	const config = loadComputerUseConfig(os.homedir());
	return config.config.stealth_mode ? "stealth" : "default";
}

async function dispatchAction(action: string, params: ActionParams): Promise<HarnessResult> {
	switch (action) {
		case "list_apps": {
			const result = await performListApps();
			return { text: result.content.map((c: any) => c.text).join("\n"), details: result.details };
		}

		case "list_windows": {
			const p: ListWindowsParams = {
				app: params.app as string | undefined,
				bundleId: params.bundleId as string | undefined,
				pid: params.pid as number | undefined,
			};
			const result = await performListWindows(p);
			return { text: result.content.map((c: any) => c.text).join("\n"), details: result.details };
		}

		case "screenshot": {
			const p: ScreenshotParams = {
				app: params.app as string | undefined,
				windowTitle: params.windowTitle as string | undefined,
				window: params.window as string | number | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performScreenshot(p);
			const details = result.details as ComputerUseDetails;

			let imagePath: string | undefined;
			// Write image to temp file if present
			for (const c of result.content) {
				if (c.type === "image" && "data" in c) {
					imagePath = writeScreenshotPng(details.capture.stateId, String((c as any).data));
				}
			}

			// Build text with AX targets and file path hint
			const textParts: string[] = [];
			for (const c of result.content) {
				if (c.type === "text" && c.text) textParts.push(c.text);
			}

			let text = textParts.join("\n");
			if (imagePath) {
				text += `\n\nScreenshot saved to: ${imagePath}\nUse the read tool to view it: read("${imagePath}")`;
			}

			return { text, details, imagePath };
		}

		case "click": {
			const p: ClickParams = {
				x: params.x as number | undefined,
				y: params.y as number | undefined,
				ref: params.ref as string | undefined,
				button: params.button as "left" | "right" | "middle" | undefined,
				clickCount: params.clickCount as number | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performClick(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "double_click": {
			const p: ClickParams = {
				x: params.x as number | undefined,
				y: params.y as number | undefined,
				ref: params.ref as string | undefined,
				button: params.button as "left" | "right" | "middle" | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performDoubleClick(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "move_mouse": {
			const p: MoveMouseParams = {
				x: params.x as number,
				y: params.y as number,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performMoveMouse(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "drag": {
			const p: DragParams = {
				path: params.path as Array<{ x: number; y: number }> | undefined,
				ref: params.ref as string | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performDrag(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "scroll": {
			const p: ScrollParams = {
				x: params.x as number | undefined,
				y: params.y as number | undefined,
				ref: params.ref as string | undefined,
				scrollX: params.scrollX as number | undefined,
				scrollY: params.scrollY as number | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performScroll(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "keypress": {
			const p: KeypressParams = {
				keys: params.keys as string[],
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performKeypress(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "type_text": {
			const p: TypeTextParams = {
				text: params.text as string,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performTypeText(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "set_text": {
			const p: SetTextParams = {
				text: params.text as string,
				ref: params.ref as string | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performSetText(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "wait": {
			const p: WaitParams = {
				ms: params.ms as number | undefined,
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performWait(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "arrange_window": {
			const p: ArrangeWindowParams = {
				window: params.window as string | number | undefined,
				preset: params.preset as ArrangeWindowParams["preset"],
				x: params.x as number | undefined,
				y: params.y as number | undefined,
				width: params.width as number | undefined,
				height: params.height as number | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performArrangeWindow(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "navigate_browser": {
			const p: NavigateBrowserParams = {
				url: params.url as string,
				window: params.window as string | number | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performNavigateBrowser(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		case "computer_actions": {
			const p: ComputerActionsParams = {
				actions: params.actions as ComputerActionsParams["actions"],
				window: params.window as string | number | undefined,
				stateId: params.stateId as string | undefined,
				image: params.image as "auto" | "always" | "never" | undefined,
			};
			const result = await performComputerActions(p);
			const details = result.details as ComputerUseDetails;
			return withOptionalImage(result, details);
		}

		default:
			throw new Error(`Unknown action: ${action}`);
	}
}

function withOptionalImage(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details: unknown },
	_details: ComputerUseDetails,
): HarnessResult {
	let imagePath: string | undefined;
	const textParts: string[] = [];

	for (const c of result.content) {
		if (c.type === "text" && c.text) {
			textParts.push(c.text);
		} else if (c.type === "image" && (c as any).data) {
			imagePath = writeScreenshotPng(_details.capture.stateId, String((c as any).data));
		}
	}

	let text = textParts.join("\n");
	if (imagePath) {
		text += `\n\nScreenshot saved to: ${imagePath}\nUse the read tool to view it: read("${imagePath}")`;
	}

	return { text, details: _details, imagePath };
}

// =============================================================================
// HTTP Server
// =============================================================================

const PORT = Number(process.env.PI_COMPUTER_USE_PORT ?? 9876);
const startedAt = Date.now();
const LOG = process.env.PI_COMPUTER_USE_LOG ?? "/tmp/pi-computer-use-harness.log";

const TEXT_JSON = { "content-type": "application/json; charset=utf-8" } as const;
const TEXT_PLAIN = { "content-type": "text/plain; charset=utf-8" } as const;

function serverLog(msg: string): void {
	const ts = new Date().toISOString();
	const line = `[${ts}] ${msg}\n`;
	try {
		fs.appendFileSync(LOG, line);
	} catch {
		// Best effort
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

async function ensureBridge(): Promise<void> {
	await ensureBridgeReady();
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

	if (req.method === "OPTIONS") {
		res.writeHead(204);
		res.end();
		return;
	}

	// Health check
	if (req.method === "GET" && url.pathname === "/health") {
		const state = getRuntimeStateSnapshot();
		res.writeHead(200, TEXT_JSON);
		res.end(
			JSON.stringify({
				ok: true,
				uptime: Math.floor((Date.now() - startedAt) / 1000),
				pid: process.pid,
				hasTarget: state.hasTarget,
				hasCapture: state.hasCapture,
				config: state.config,
			}),
		);
		return;
	}

	// Action endpoint
	if (req.method === "POST" && url.pathname === "/action") {
		let body: string;
		try {
			body = await readBody(req);
		} catch {
			res.writeHead(400, TEXT_JSON);
			res.end(JSON.stringify({ ok: false, error: "failed to read body" }));
			return;
		}

		let params: ActionParams;
		try {
			params = JSON.parse(body);
		} catch {
			res.writeHead(400, TEXT_JSON);
			res.end(JSON.stringify({ ok: false, error: "invalid JSON" }));
			return;
		}

		const action = params.action;
		if (!action || typeof action !== "string") {
			res.writeHead(400, TEXT_JSON);
			res.end(JSON.stringify({ ok: false, error: "missing or invalid 'action' field" }));
			return;
		}

		serverLog(`action: ${action}`);

		try {
			await ensureBridge();
			const result = await dispatchAction(action, params);
			serverLog(`action: ${action} -> ok`);
			res.writeHead(200, TEXT_JSON);
			res.end(JSON.stringify({ ok: true, result }));
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			serverLog(`action: ${action} -> error: ${msg}`);
			res.writeHead(500, TEXT_JSON);
			res.end(JSON.stringify({ ok: false, error: msg }));
		}
		return;
	}

	// Graceful shutdown
	if (req.method === "POST" && url.pathname === "/quit") {
		res.writeHead(200, TEXT_JSON);
		res.end(JSON.stringify({ ok: true }));
		setTimeout(() => {
			server.close();
			stopBridge();
			process.exit(0);
		}, 100);
		return;
	}

	// 404
	res.writeHead(404, TEXT_PLAIN);
	res.end("not found\n");
});

server.listen(PORT, "127.0.0.1", () => {
	const addr = server.address();
	const actualPort = typeof addr === "object" && addr ? addr.port : PORT;
	const msg = JSON.stringify({
		ok: true,
		ready: true,
		port: actualPort,
		message: `pi-computer-use harness listening on http://127.0.0.1:${actualPort}`,
	});
	process.stdout.write(msg + "\n");
	serverLog(`harness started on port ${actualPort}`);
});

// Graceful shutdown on signals
const shutdown = (signal: string) => {
	serverLog(`received ${signal}, shutting down`);
	server.close();
	stopBridge();
	process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export { server };
