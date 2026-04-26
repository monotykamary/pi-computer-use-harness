#!/usr/bin/env node
/**
 * pi-computer-use — CLI for macOS computer-use via harness server.
 *
 * Usage:
 *   pi-computer-use list_apps
 *   pi-computer-use list_windows [--app Safari] [--bundleId com.apple.Safari] [--pid 123]
 *   pi-computer-use screenshot [--app Safari] [--windowTitle "Google"] [--window @w1] [--image auto|always|never]
 *   pi-computer-use click [--ref @e1] [-x 100] [-y 200] [--button left|right|middle] [--clickCount 1] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use double_click [--ref @e1] [-x 100] [-y 200] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use move_mouse -x 100 -y 200 [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use drag --path '10,20 100,200' [--ref @e1] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use scroll [-x 100] [-y 200] [--ref @e3] [--scrollX 0] [--scrollY 600] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use keypress --keys Command+L,Enter [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use type_text --text "hello" [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use set_text --text "hello" [--ref @e2] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use wait [--ms 1000] [--window @w1] [--stateId ...] [--image auto|always|never]
 *   pi-computer-use arrange_window [--window @w1] [--preset center_large] [-x 0] [-y 0] [--width 1200] [--height 800] [--image auto|always|never]
 *   pi-computer-use navigate_browser --url "https://example.com" [--window @w1] [--image auto|always|never]
 *   pi-computer-use computer_actions --actions '[{...}]' [--window @w1] [--stateId ...] [--image auto|always|never]
 *
 * Also accepts JSON for programmatic use:
 *   pi-computer-use '{ "action": "click", "ref": "@e1" }'
 *
 * Server management:
 *   pi-computer-use --status
 *   pi-computer-use --start
 *   pi-computer-use --stop
 *   pi-computer-use --restart
 *   pi-computer-use --logs
 */

import { spawn as spawnChild } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PI_COMPUTER_USE_PORT ?? 9876);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const LOG = process.env.PI_COMPUTER_USE_LOG ?? "/tmp/pi-computer-use-harness.log";

// =============================================================================
// HTTP helpers
// =============================================================================

function httpGet(url: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout: 2000 }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
			});
		});
		req.on("error", (err) => resolve({ status: 0, body: err.message }));
		req.on("timeout", () => {
			req.destroy();
			resolve({ status: 0, body: "timeout" });
		});
	});
}

function httpPost(
	url: string,
	body: string,
): Promise<{ status: number; body: string }> {
	return new Promise((resolve) => {
		const data = Buffer.from(body, "utf-8");
		const req = http.request(
			url,
			{
				method: "POST",
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-length": data.length,
				},
				timeout: 60_000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
				});
			},
		);
		req.on("error", (err) => resolve({ status: 0, body: err.message }));
		req.on("timeout", () => {
			req.destroy();
			resolve({ status: 0, body: "timeout" });
		});
		req.write(data);
		req.end();
	});
}

// =============================================================================
// Server lifecycle
// =============================================================================

async function isUp(): Promise<boolean> {
	const { status } = await httpGet(`${BASE_URL}/health`);
	return status === 200;
}

async function startServer(): Promise<boolean> {
	if (await isUp()) return true;

	let serverScript = path.resolve(__dirname, "server.js");
	if (!fs.existsSync(serverScript)) {
		const tsPath = path.resolve(__dirname, "..", "harness", "server.ts");
		if (fs.existsSync(tsPath)) serverScript = tsPath;
	}

	const useTsx = serverScript.endsWith(".ts");
	const cmd = useTsx ? "npx" : "node";
	const args = useTsx ? ["tsx", serverScript] : [serverScript];

	const env: Record<string, string> = {};
	for (const key of ["PI_COMPUTER_USE_PORT", "PI_COMPUTER_USE_LOG", "PI_COMPUTER_USE_DIR"] as const) {
		if (process.env[key]) env[key] = process.env[key]!;
	}

	const child = spawnChild(cmd, args, {
		cwd: process.cwd(),
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
		env: { ...process.env, ...env },
	});
	child.unref();

	for (let i = 0; i < 150; i++) {
		await new Promise((r) => setTimeout(r, 100));
		if (await isUp()) return true;
	}

	process.stderr.write(`pi-computer-use: server failed to start on ${BASE_URL} (see ${LOG})\n`);
	return false;
}

// =============================================================================
// Action dispatch
// =============================================================================

async function postAction(jsonBody: string): Promise<void> {
	const { status, body } = await httpPost(`${BASE_URL}/action`, jsonBody);
	if (status === 200) {
		try {
			const parsed = JSON.parse(body);
			if (parsed.ok && parsed.result?.text) {
				process.stdout.write(parsed.result.text + "\n");
			} else if (!parsed.ok) {
				process.stderr.write(`Error: ${parsed.error}\n`);
				process.exit(1);
			}
		} catch {
			if (body.trim()) process.stdout.write(body + "\n");
		}
	} else if (status === 0) {
		process.stderr.write(`Error: cannot reach harness server at ${BASE_URL}\n`);
		process.exit(1);
	} else {
		try {
			const parsed = JSON.parse(body);
			process.stderr.write(`Error: ${parsed.error ?? body}\n`);
		} catch {
			process.stderr.write(`Error: HTTP ${status} — ${body}\n`);
		}
		process.exit(1);
	}
}

// =============================================================================
// Argument parser
// =============================================================================

function extractFlag(args: string[], name: string): string | undefined {
	const idx = args.findIndex((a) => a === `--${name}`);
	if (idx !== -1 && idx + 1 < args.length) {
		const val = args[idx + 1];
		args.splice(idx, 2);
		return val;
	}
	return undefined;
}

function extractFlagBool(args: string[], name: string): boolean {
	const idx = args.findIndex((a) => a === `--${name}`);
	if (idx !== -1) {
		args.splice(idx, 1);
		return true;
	}
	return false;
}

function extractShortFlag(args: string[], name: string): string | undefined {
	const idx = args.findIndex((a) => a === `-${name}`);
	if (idx !== -1 && idx + 1 < args.length) {
		const val = args[idx + 1];
		args.splice(idx, 2);
		return val;
	}
	return undefined;
}

// -----------------------------------------------------------------------------
// Parse helpers for CLI-natural flag values
// -----------------------------------------------------------------------------

/**
 * Parse --keys value.
 *
 * Natural:   Command+L,Enter     → ["Command+L", "Enter"]
 * Legacy:    '["Enter"]'          → ["Enter"]
 */
function parseKeys(raw: string): string[] {
	if (raw.startsWith("[")) return JSON.parse(raw);
	return raw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
}

/**
 * Parse --path value for drag.
 *
 * Natural:   10,20 100,200           → [{x:10,y:20},{x:100,y:200}]
 * Legacy:    '[{"x":10,"y":20}]'   → [{x:10,y:20}]
 */
function parseDragPath(raw: string): Array<{ x: number; y: number } | [number, number]> {
	if (raw.startsWith("[")) return JSON.parse(raw);
	return raw
		.trim()
		.split(/\s+/)
		.map((pair) => {
			const parts = pair.split(",");
			if (parts.length !== 2) throw new Error(`Invalid drag point '${pair}'. Use x,y pairs like: 10,20 100,200`);
			return { x: Number(parts[0]), y: Number(parts[1]) };
		});
}

// =============================================================================
// CLI entrypoint
// =============================================================================

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);

	if (rawArgs.length === 0) {
		process.stderr.write(`pi-computer-use — macOS computer-use CLI

Usage:
  pi-computer-use list_apps
  pi-computer-use list_windows [--app Safari] [--pid 123]
  pi-computer-use screenshot [--app Safari] [--windowTitle "..."] [--window @w1] [--image auto|always|never]
  pi-computer-use click [--ref @e1] [-x N] [-y N] [--button left|right|middle] [--window @w1] [--stateId ...] [--image auto|always|never]
  pi-computer-use double_click [--ref @e1] [-x N] [-y N] [--window @w1] [--image auto|always|never]
  pi-computer-use move_mouse -x N -y N [--window @w1] [--image auto|always|never]
  pi-computer-use drag --path '10,20 100,200' [--ref @e1] [--window @w1] [--image auto|always|never]
  pi-computer-use scroll [-x N] [-y N] [--ref @e3] [--scrollY 600] [--window @w1] [--image auto|always|never]
  pi-computer-use keypress --keys Command+L,Enter [--window @w1] [--image auto|always|never]
  pi-computer-use type_text --text "hello" [--window @w1] [--image auto|always|never]
  pi-computer-use set_text --text "hello" [--ref @e2] [--window @w1] [--image auto|always|never]
  pi-computer-use wait [--ms 1000] [--window @w1] [--image auto|always|never]
  pi-computer-use arrange_window [--window @w1] [--preset center_large] [-x N] [-y N] [--width N] [--height N] [--image auto|always|never]
  pi-computer-use navigate_browser --url "https://example.com" [--window @w1] [--image auto|always|never]
  pi-computer-use computer_actions --actions '[...]' [--window @w1] [--stateId ...] [--image auto|always|never]

  pi-computer-use --status     Check if harness server is running
  pi-computer-use --start      Start the harness server
  pi-computer-use --stop       Stop the harness server
  pi-computer-use --restart    Restart the harness server
  pi-computer-use --logs       Tail the server log

Also accepts JSON for programmatic use:
  pi-computer-use '{ "action": "click", "ref": "@e1" }'

Environment:
  PI_COMPUTER_USE_PORT     Server port (default: 9876)
  PI_COMPUTER_USE_LOG      Log file (default: /tmp/pi-computer-use-harness.log)
`);
		return;
	}

	const first = rawArgs[0];

	// --- Server management commands ---
	if (first === "--status") {
		const { status, body } = await httpGet(`${BASE_URL}/health`);
		process.stdout.write(status === 200 ? body + "\n" : '{"ok":false,"error":"down"}\n');
		process.exit(status === 200 ? 0 : 1);
	}

	if (first === "--start") {
		await startServer();
		const { body } = await httpGet(`${BASE_URL}/health`);
		process.stdout.write(body + "\n");
		return;
	}

	if (first === "--stop") {
		if (await isUp()) {
			await httpPost(`${BASE_URL}/quit`, "");
			process.stdout.write('{"ok":true,"stopped":true}\n');
		} else {
			process.stdout.write('{"ok":true,"stopped":false,"note":"already down"}\n');
		}
		return;
	}

	if (first === "--restart") {
		if (await isUp()) {
			await httpPost(`${BASE_URL}/quit`, "");
			await new Promise((r) => setTimeout(r, 200));
		}
		await startServer();
		const { body } = await httpGet(`${BASE_URL}/health`);
		process.stdout.write(body + "\n");
		return;
	}

	if (first === "--logs") {
		const { spawn } = await import("node:child_process");
		spawn("tail", ["-f", LOG], { stdio: "inherit" });
		return;
	}

	// --- JSON passthrough ---
	if (first.startsWith("{")) {
		if (!(await startServer())) process.exit(1);
		await postAction(first);
		return;
	}

	// --- Action subcommands ---
	if (!(await startServer())) process.exit(1);

	const args = [...rawArgs]; // mutable copy
	const action = args.shift()!;

	switch (action) {
		case "list_apps":
			await postAction(JSON.stringify({ action: "list_apps" }));
			break;

		case "list_windows": {
			const app = extractFlag(args, "app");
			const bundleId = extractFlag(args, "bundleId");
			const pid = extractFlag(args, "pid");
			await postAction(
				JSON.stringify({
					action: "list_windows",
					...(app ? { app } : {}),
					...(bundleId ? { bundleId } : {}),
					...(pid ? { pid: Number(pid) } : {}),
				}),
			);
			break;
		}

		case "screenshot": {
			const app = extractFlag(args, "app");
			const windowTitle = extractFlag(args, "windowTitle");
			const window = extractFlag(args, "window");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "screenshot",
					...(app ? { app } : {}),
					...(windowTitle ? { windowTitle } : {}),
					...(window ? { window } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "click": {
			const ref = extractFlag(args, "ref");
			const x = extractShortFlag(args, "x") ?? extractFlag(args, "x");
			const y = extractShortFlag(args, "y") ?? extractFlag(args, "y");
			const button = extractFlag(args, "button");
			const clickCount = extractFlag(args, "clickCount");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "click",
					...(ref ? { ref } : {}),
					...(x ? { x: Number(x) } : {}),
					...(y ? { y: Number(y) } : {}),
					...(button ? { button } : {}),
					...(clickCount ? { clickCount: Number(clickCount) } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "double_click": {
			const ref = extractFlag(args, "ref");
			const x = extractShortFlag(args, "x") ?? extractFlag(args, "x");
			const y = extractShortFlag(args, "y") ?? extractFlag(args, "y");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "double_click",
					...(ref ? { ref } : {}),
					...(x ? { x: Number(x) } : {}),
					...(y ? { y: Number(y) } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "move_mouse": {
			const x = extractShortFlag(args, "x") ?? extractFlag(args, "x");
			const y = extractShortFlag(args, "y") ?? extractFlag(args, "y");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!x || !y) {
				process.stderr.write("Error: move_mouse requires -x and -y.\n");
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "move_mouse",
					x: Number(x),
					y: Number(y),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "drag": {
			const pathRaw = extractFlag(args, "path");
			const ref = extractFlag(args, "ref");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!pathRaw && !ref) {
				process.stderr.write("Error: drag requires --path or --ref.\n");
				process.exit(1);
			}
			let pathVal: Array<{ x: number; y: number } | [number, number]> | undefined;
			if (pathRaw) {
				try {
					pathVal = parseDragPath(pathRaw);
				} catch (e) {
					process.stderr.write(`Error: invalid --path value: ${e instanceof Error ? e.message : e}\n`);
					process.exit(1);
				}
			}
			await postAction(
				JSON.stringify({
					action: "drag",
					...(pathVal ? { path: pathVal } : {}),
					...(ref ? { ref } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "scroll": {
			const x = extractShortFlag(args, "x") ?? extractFlag(args, "x");
			const y = extractShortFlag(args, "y") ?? extractFlag(args, "y");
			const ref = extractFlag(args, "ref");
			const scrollX = extractFlag(args, "scrollX");
			const scrollY = extractFlag(args, "scrollY");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "scroll",
					...(x ? { x: Number(x) } : {}),
					...(y ? { y: Number(y) } : {}),
					...(ref ? { ref } : {}),
					...(scrollX ? { scrollX: Number(scrollX) } : {}),
					...(scrollY ? { scrollY: Number(scrollY) } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "keypress": {
			const keysRaw = extractFlag(args, "keys");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!keysRaw) {
				process.stderr.write("Error: keypress requires --keys (e.g. --keys Command+L,Enter or --keys '[\"Enter\"]').\n");
				process.exit(1);
			}
			let keys: string[];
			try {
				keys = parseKeys(keysRaw);
			} catch (e) {
				process.stderr.write(`Error: invalid --keys value: ${e instanceof Error ? e.message : e}\n`);
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "keypress",
					keys,
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "type_text": {
			const text = extractFlag(args, "text");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!text) {
				process.stderr.write("Error: type_text requires --text.\n");
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "type_text",
					text,
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "set_text": {
			const text = extractFlag(args, "text");
			const ref = extractFlag(args, "ref");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!text) {
				process.stderr.write("Error: set_text requires --text.\n");
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "set_text",
					text,
					...(ref ? { ref } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "wait": {
			const ms = extractFlag(args, "ms");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "wait",
					...(ms ? { ms: Number(ms) } : {}),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "arrange_window": {
			const window = extractFlag(args, "window");
			const preset = extractFlag(args, "preset");
			const x = extractShortFlag(args, "x") ?? extractFlag(args, "x");
			const y = extractShortFlag(args, "y") ?? extractFlag(args, "y");
			const width = extractFlag(args, "width");
			const height = extractFlag(args, "height");
			const image = extractFlag(args, "image");
			await postAction(
				JSON.stringify({
					action: "arrange_window",
					...(window ? { window } : {}),
					...(preset ? { preset } : {}),
					...(x ? { x: Number(x) } : {}),
					...(y ? { y: Number(y) } : {}),
					...(width ? { width: Number(width) } : {}),
					...(height ? { height: Number(height) } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "navigate_browser": {
			const url = extractFlag(args, "url");
			const window = extractFlag(args, "window");
			const image = extractFlag(args, "image");
			if (!url) {
				process.stderr.write("Error: navigate_browser requires --url.\n");
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "navigate_browser",
					url,
					...(window ? { window } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		case "computer_actions": {
			const actionsJson = extractFlag(args, "actions");
			const window = extractFlag(args, "window");
			const stateId = extractFlag(args, "stateId");
			const image = extractFlag(args, "image");
			if (!actionsJson) {
				process.stderr.write("Error: computer_actions requires --actions (JSON array).\n");
				process.exit(1);
			}
			await postAction(
				JSON.stringify({
					action: "computer_actions",
					actions: JSON.parse(actionsJson),
					...(window ? { window } : {}),
					...(stateId ? { stateId } : {}),
					...(image ? { image } : {}),
				}),
			);
			break;
		}

		default:
			process.stderr.write(`Unknown command: ${action}. Use --help for usage.\n`);
			process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`pi-computer-use: ${err instanceof Error ? err.message : err}\n`);
	process.exit(1);
});
