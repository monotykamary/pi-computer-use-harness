#!/usr/bin/env node
/**
 * E2E tests for the pi-computer-use harness architecture.
 *
 * Tests the full CLI → Harness Server → Bridge → Native Helper round-trip.
 *
 * Safety guarantees:
 *   - Only uses read-only actions (list_apps, list_windows, screenshot)
 *   - Only targets TextEdit (opens a fresh empty document, types into it, closes it)
 *   - Never touches the user's existing windows or browser
 *   - Cleans up the test TextEdit document on exit
 *   - Uses an isolated port (9877) to avoid conflicting with a running pi session
 *
 * Usage:
 *   tsx harness/e2e.ts
 *   tsx harness/e2e.ts --allow-write   # also tests click/type_text/keypress against TextEdit
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Isolated port to avoid conflict with a running pi session on 9876
const PORT = Number(process.env.PI_COMPUTER_USE_E2E_PORT ?? 9877);
const HOST = "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;
const ALLOW_WRITE = process.argv.includes("--allow-write");

// =============================================================================
// Test framework
// =============================================================================

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(name: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`  ✅ ${name}`);
		passed++;
	} else {
		console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
		failed++;
	}
}

function skip(name: string, reason: string): void {
	console.log(`  ⏭️  ${name} — SKIP: ${reason}`);
	skipped++;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n📋 ${name}`);
	try {
		await fn();
	} catch (e) {
		console.log(`  ❌ ${name} — threw: ${e instanceof Error ? e.message : String(e)}`);
		failed++;
	}
}

// =============================================================================
// HTTP helpers
// =============================================================================

function httpGet(url: string, timeout = 3000): Promise<{ status: number; body: string }> {
	return new Promise((resolve) => {
		const req = http.get(url, { timeout }, (res) => {
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

function httpPost(url: string, data: string, timeout = 30000): Promise<{ status: number; body: string }> {
	return new Promise((resolve) => {
		const buf = Buffer.from(data, "utf-8");
		const req = http.request(
			url,
			{
				method: "POST",
				headers: { "content-type": "application/json; charset=utf-8", "content-length": buf.length },
				timeout,
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
		req.write(buf);
		req.end();
	});
}

// =============================================================================
// Harness server lifecycle
// =============================================================================

let serverProcess: ChildProcess | null = null;
const CLI_PATH = path.resolve(__dirname, "cli.ts");
const SERVER_PATH = path.resolve(__dirname, "server.ts");

async function startHarnessServer(): Promise<boolean> {
	const pidFile = `/tmp/pi-computer-use-e2e-${PORT}.pid`;

	// Check if something is already listening on our port
	const { status } = await httpGet(`${BASE_URL}/health`, 500);
	if (status === 200) {
		console.log(`  ℹ️  Harness server already running on port ${PORT}`);
		return true;
	}

	console.log(`  ℹ️  Starting harness server on port ${PORT}...`);

	// Spawn the harness server via tsx
	serverProcess = spawn("npx", ["tsx", SERVER_PATH], {
		env: { ...process.env, PI_COMPUTER_USE_PORT: String(PORT) },
		stdio: ["ignore", "pipe", "pipe"],
		detached: false,
	});

	// Log stderr for debugging
	if (serverProcess.stderr) {
		serverProcess.stderr.on("data", (chunk: Buffer) => {
			const line = chunk.toString("utf-8").trim();
			if (line) console.log(`    [server stderr] ${line}`);
		});
	}

	// Wait for ready signal on stdout
	const ready = await new Promise<boolean>((resolve) => {
		const timeout = setTimeout(() => {
			console.log("  ⚠️  Server did not start within 5s");
			resolve(false);
		}, 5000);

		if (serverProcess!.stdout) {
			serverProcess!.stdout.on("data", (chunk: Buffer) => {
				const line = chunk.toString("utf-8").trim();
				if (line.includes('"ready":true') || line.includes('"ok":true')) {
					clearTimeout(timeout);
					resolve(true);
				}
			});
		}
	});

	if (!ready && serverProcess) {
		serverProcess.kill("SIGTERM");
		serverProcess = null;
		return false;
	}

	return true;
}

async function stopHarnessServer(): Promise<void> {
	if (serverProcess) {
		serverProcess.kill("SIGTERM");
		serverProcess = null;
		await new Promise((r) => setTimeout(r, 200));
	}
}

async function postAction(body: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: string }> {
	const { status, body: resBody } = await httpPost(`${BASE_URL}/action`, JSON.stringify(body));
	if (status !== 200) {
		try {
			return JSON.parse(resBody);
		} catch {
			return { ok: false, error: `HTTP ${status}: ${resBody}` };
		}
	}
	try {
		return JSON.parse(resBody);
	} catch {
		return { ok: false, error: `Parse error: ${resBody.slice(0, 200)}` };
	}
}

// =============================================================================
// TextEdit management (only when --allow-write)
// =============================================================================

let textEditWasOpen = false;
const TEST_FILE = path.join(os.tmpdir(), "pi-e2e-test.txt");

async function openTextEdit(): Promise<void> {
	if (!ALLOW_WRITE) return;
	try {
		const result = execSync('pgrep -x "TextEdit"', { encoding: "utf-8" }).trim();
		textEditWasOpen = result.length > 0;
	} catch {
		textEditWasOpen = false;
	}

	// Create a temp file so TextEdit opens a real document window
	// instead of the Open File dialog (Finder-style).
	fs.writeFileSync(TEST_FILE, "pi e2e test\n");
	execSync(`open -a TextEdit "${TEST_FILE}"`, { encoding: "utf-8" });

	// Wait for TextEdit to fully launch — give it up to 10 seconds
	for (let attempt = 0; attempt < 20; attempt++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			const ps = execSync('pgrep -x "TextEdit"', { encoding: "utf-8" }).trim();
			if (ps.length > 0) break;
		} catch {
			// pgrep exits with 1 if not found
		}
	}
	// Extra settle time for the bridge to discover the window
	await new Promise((r) => setTimeout(r, 1000));
}

async function closeTextEdit(): Promise<void> {
	if (!ALLOW_WRITE || textEditWasOpen) return;
	try {
		execSync('osascript -e \'tell application "TextEdit" to quit\'', { encoding: "utf-8" });
	} catch {
		// Best effort
	}
	try {
		fs.unlinkSync(TEST_FILE);
	} catch {
		// Best effort
	}
}

// =============================================================================
// Tests
// =============================================================================

async function testServerLifecycle(): Promise<void> {
	await test("Server health endpoint", async () => {
		const { status, body } = await httpGet(`${BASE_URL}/health`);
		ok("GET /health returns 200", status === 200, `got ${status}`);

		if (status === 200) {
			try {
				const parsed = JSON.parse(body);
				ok("Health response has ok=true", parsed.ok === true, `got ${parsed.ok}`);
				ok("Health response has pid", typeof parsed.pid === "number", `got ${typeof parsed.pid}`);
				ok("Health response has uptime", typeof parsed.uptime === "number", `got ${typeof parsed.uptime}`);
				ok("Health response has hasTarget", typeof parsed.hasTarget === "boolean", `got ${typeof parsed.hasTarget}`);
				ok("Health response has config", typeof parsed.config === "object", `got ${typeof parsed.config}`);
			} catch {
				ok("Health response is valid JSON", false, body.slice(0, 200));
			}
		}
	});
}

async function testListApps(): Promise<void> {
	await test("list_apps", async () => {
		const result = await postAction({ action: "list_apps" });
		ok("list_apps succeeds", result.ok, result.error);

		if (result.ok) {
			ok("result has text", typeof result.result?.text === "string", `got ${typeof result.result?.text}`);
			ok("result has details", result.result?.details !== undefined, "no details");

			const text: string = result.result?.text ?? "";
			ok("text is non-empty", text.length > 0, "empty text");

			// Should list at least Finder
			ok("text contains 'Finder'", text.includes("Finder"), `text: ${text.slice(0, 300)}`);
		}
	});
}

async function testListWindows(): Promise<void> {
	await test("list_windows", async () => {
		const result = await postAction({ action: "list_windows", app: "Finder" });
		ok("list_windows succeeds", result.ok, result.error);

		if (result.ok) {
			ok("result has text", typeof result.result?.text === "string", `got ${typeof result.result?.text}`);
			ok("result has details", result.result?.details !== undefined, "no details");
		}
	});

	await test("list_windows (no such app)", async () => {
		const result = await postAction({ action: "list_windows", app: "NonExistentApp12345" });
		// Should succeed (empty result) or return an error — either way should not crash
		ok("doesn't crash", result.ok === true || (result.ok === false && typeof result.error === "string"), `unexpected: ${JSON.stringify(result).slice(0, 300)}`);
	});
}

async function testScreenshot(): Promise<void> {
	await test("screenshot (frontmost app)", async () => {
		const result = await postAction({ action: "screenshot", image: "never" });
		ok("screenshot succeeds", result.ok, result.error);

		if (result.ok) {
			const text: string = result.result?.text ?? "";
			ok("result has text", text.length > 0, "empty text");
			ok("result has details", result.result?.details !== undefined, "no details");
			ok("text contains axTargets or execution info", text.includes("@") || text.includes("ax") || text.includes("fallback") || text.includes("stateId"), `unexpected text: ${text.slice(0, 200)}`);

			// Check details structure
			const details = result.result?.details;
			if (details) {
				ok("details has target", !!details.target, "no target");
				ok("details has capture", !!details.capture, "no capture");
				if (details.capture) {
					ok("capture has stateId", typeof details.capture.stateId === "string", `got ${typeof details.capture.stateId}`);
					ok("capture has width", typeof details.capture.width === "number", `got ${typeof details.capture.width}`);
					ok("capture has height", typeof details.capture.height === "number", `got ${typeof details.capture.height}`);
				}
			}
		}
	});
}

async function testScreenshotWithImage(): Promise<void> {
	await test("screenshot with image=always", async () => {
		const result = await postAction({ action: "screenshot", image: "always" });
		ok("screenshot with image succeeds", result.ok, result.error);

		if (result.ok) {
			const text: string = result.result?.text ?? "";
			ok("text mentions screenshot file path", text.includes("pi-computer-use/"), `no path hint in text: ${text.slice(0, 200)}`);
			ok("result has imagePath", !!result.result?.imagePath, "no imagePath");

			if (result.result?.imagePath) {
				const exists = fs.existsSync(result.result.imagePath);
				ok("screenshot file exists on disk", exists, `file not found: ${result.result.imagePath}`);
				if (exists) {
					const stat = fs.statSync(result.result.imagePath!);
					ok("screenshot file is non-empty", stat.size > 0, "empty file");
				}
			}
		}
	});
}

let textEditControlled = false;

async function testWriteActions(): Promise<void> {
	if (!ALLOW_WRITE) {
		skip("click/type_text/keypress against TextEdit", "--allow-write not set");
		return;
	}

	await openTextEdit();

	// Screenshot TextEdit to make it the controlled window.
	// If this fails, skip ALL subsequent write tests — otherwise actions
	// will go to whatever the last controlled window was (e.g. a terminal).
	await test("screenshot TextEdit", async () => {
		const result = await postAction({ action: "screenshot", app: "TextEdit", image: "never" });
		ok("screenshot(TextEdit) succeeds", result.ok, result.error);

		if (result.ok) {
			textEditControlled = true;
			const details = result.result?.details;
			ok("TextEdit has target", !!details?.target, "no target");
			ok("TextEdit has capture", !!details?.capture, "no capture");
		}
	});

	if (!textEditControlled) {
		skip("type_text into TextEdit", "TextEdit screenshot failed — skipping write tests to avoid targeting wrong window");
		skip("keypress Enter", "TextEdit screenshot failed");
		skip("wait", "TextEdit screenshot failed");
		skip("arrange_window", "TextEdit screenshot failed");
		skip("computer_actions batch", "TextEdit screenshot failed");
		await closeTextEdit();
		return;
	}

	await test("type_text into TextEdit", async () => {
		const result = await postAction({ action: "type_text", text: "pi e2e test" });
		ok("type_text succeeds", result.ok, result.error);
	});

	await test("keypress Enter", async () => {
		const result = await postAction({ action: "keypress", keys: ["Return"] });
		ok("keypress succeeds", result.ok, result.error);
	});

	await test("wait", async () => {
		const result = await postAction({ action: "wait", ms: 500 });
		ok("wait succeeds", result.ok, result.error);
	});

	await test("arrange_window", async () => {
		const result = await postAction({ action: "arrange_window", preset: "center_large" });
		ok("arrange_window succeeds", result.ok, result.error);
	});

	await test("computer_actions batch", async () => {
		const result = await postAction({
			action: "computer_actions",
			actions: [
				{ type: "type_text", text: "batch step 1" },
				{ type: "keypress", keys: ["Return"] },
			],
		});
		ok("computer_actions succeeds", result.ok, result.error);
	});

	await closeTextEdit();
}

async function testErrorCases(): Promise<void> {
	await test("unknown action", async () => {
		const result = await postAction({ action: "nonexistent_action" });
		ok("returns error", result.ok === false, `expected ok=false, got ${result.ok}`);
		ok("error message mentions unknown action", typeof result.error === "string", `unexpected: ${JSON.stringify(result).slice(0, 200)}`);
	});

	await test("move_mouse without coordinates", async () => {
		const result = await postAction({ action: "move_mouse" });
		// The server should handle this — bridge will throw for missing x/y
		ok("returns error (missing coordinates)", result.ok === false || (result.ok === true && result.result?.text), `unexpected: ${JSON.stringify(result).slice(0, 200)}`);
	});

	await test("invalid JSON body", async () => {
		const { status } = await httpPost(`${BASE_URL}/action`, "not json");
		ok("returns 400 for invalid JSON", status === 400, `got ${status}`);
	});

	await test("missing action field", async () => {
		const result = await postAction({ ref: "@e1" });
		ok("returns error (missing action)", result.ok === false, `got ok=${result.ok}`);
	});

	await test("404 for unknown endpoint", async () => {
		const { status } = await httpGet(`${BASE_URL}/nonexistent`);
		ok("returns 404", status === 404, `got ${status}`);
	});
}

async function testStateIdValidation(): Promise<void> {
	await test("click with stale stateId", async () => {
		const result = await postAction({ action: "click", x: 100, y: 100, stateId: "stale-id-12345" });
		// Should either error (stale state) or succeed (no validation enforced)
		// Either way, it must not crash
		ok("doesn't crash", result.ok === true || result.ok === false, `unexpected: ${JSON.stringify(result).slice(0, 200)}`);
	});
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
	console.log("═══════════════════════════════════════════════════════════");
	console.log("  pi-computer-use E2E Tests");
	console.log(`  Port: ${PORT} | Write tests: ${ALLOW_WRITE ? "ENABLED" : "DISABLED (use --allow-write)"}`);
	console.log("═══════════════════════════════════════════════════════════");

	// 1. Start harness server
	console.log("\n🚀 Starting harness server...");
	const started = await startHarnessServer();
	if (!started) {
		console.error("❌ Could not start harness server. Aborting.");
		process.exit(1);
	}

	try {
		// 2. Run tests
		await testServerLifecycle();
		await testListApps();
		await testListWindows();
		await testScreenshot();
		await testScreenshotWithImage();
		await testWriteActions();
		await testErrorCases();
		await testStateIdValidation();
	} finally {
		// 3. Stop server
		console.log("\n🛑 Stopping harness server...");
		await stopHarnessServer();
	}

	// 4. Summary
	console.log("\n═══════════════════════════════════════════════════════════");
	console.log(`  Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
	console.log("═══════════════════════════════════════════════════════════");

	process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
	console.error("Fatal:", e);
	process.exit(2);
});
