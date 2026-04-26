/**
 * pi-computer-use extension — thin lifecycle shell.
 *
 * Registers no tools. All computer-use interactions happen through
 * the `pi-computer-use` CLI, which dispatches to a long-lived harness
 * server holding the native Swift helper and runtime state.
 *
 * This extension only:
 *   - Installs the CLI shell alias on session start
 *   - Starts the harness server
 *   - Stops the harness server on shutdown
 *   - Provides the /computer-use command for config inspection
 */

import { homedir } from "node:os";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadComputerUseConfig, getLoadedComputerUseConfig } from "../src/config.ts";

// =============================================================================
// CLI path resolution
// =============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function getCliPath(): string {
	// When running from dist/: __dirname = .../dist, so dist/harness/cli.js exists
	const compiledPath = join(__dirname, "harness", "cli.js");
	if (fs.existsSync(compiledPath)) return compiledPath;
	// When running from source via tsx: __dirname = project root
	const fromSource = join(__dirname, "dist", "harness", "cli.js");
	if (fs.existsSync(fromSource)) return fromSource;
	return compiledPath;
}

// =============================================================================
// Shell alias installation
// =============================================================================

function installShellAlias(): void {
	try {
		const agentBinDir = join(homedir(), ".pi", "agent", "bin");
		if (!fs.existsSync(agentBinDir)) {
			fs.mkdirSync(agentBinDir, { recursive: true });
		}
		const cliPath = getCliPath();
		const linkPath = join(agentBinDir, "pi-computer-use");

		const wrapperContent = `#!/bin/sh
exec node "${cliPath}" "$@"
`;

		let currentContent: string | null = null;
		try {
			currentContent = fs.readFileSync(linkPath, "utf-8");
		} catch {
			// doesn't exist
		}
		if (currentContent !== wrapperContent) {
			fs.writeFileSync(linkPath, wrapperContent, { mode: 0o755 });
		}
	} catch {
		// Best effort
	}
}

// =============================================================================
// Harness server lifecycle
// =============================================================================

interface HarnessServerController {
	start(): void;
	stop(): void;
}

function createHarnessServer(): HarnessServerController {
	let harnessProcess: ChildProcess | null = null;

	function start(): void {
		if (harnessProcess) return;
		if (process.env.PI_SWARM_SPAWNED === "1") return;

		const cliPath = getCliPath();

		try {
			harnessProcess = spawnChild("node", [cliPath, "--start"], {
				cwd: process.cwd(),
				stdio: ["ignore", "ignore", "ignore"],
				detached: true,
			});
			harnessProcess.unref();
		} catch {
			// Harness server is optional — lifecycle still works without it
		}
	}

	function stop(): void {
		if (!harnessProcess) return;
		try {
			harnessProcess.kill("SIGTERM");
		} catch {
			// Best effort
		}
		harnessProcess = null;
	}

	return { start, stop };
}

// =============================================================================
// Config display
// =============================================================================

function formatConfigStatus(): string {
	const loaded = getLoadedComputerUseConfig();
	const lines = [
		"pi-computer-use config",
		"",
		`browser_use: ${loaded.config.browser_use ? "enabled" : "disabled"}`,
		`stealth_mode: ${loaded.config.stealth_mode ? "enabled" : "disabled"}`,
		"",
		"Sources:",
	];
	for (const source of loaded.sources) {
		const status = source.error ? `error: ${source.error}` : source.exists ? "loaded" : "not found";
		lines.push(`- ${source.path}: ${status}`);
	}
	const envKeys = Object.keys(loaded.env);
	lines.push(`- env overrides: ${envKeys.length ? envKeys.join(", ") : "none"}`);
	return lines.join("\n");
}

// =============================================================================
// Extension
// =============================================================================

export default function computerUseExtension(pi: ExtensionAPI): void {
	const harnessServer = createHarnessServer();

	pi.registerCommand("computer-use", {
		description: "Show pi-computer-use configuration",
		handler: async (_args, ctx) => {
			loadComputerUseConfig(ctx.cwd);
			ctx.ui.notify(formatConfigStatus(), "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		loadComputerUseConfig(ctx.cwd);
		installShellAlias();

		if (!ctx.hasUI) {
			return;
		}

		// Start the harness server so CLI commands work immediately
		harnessServer.start();
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadComputerUseConfig(ctx.cwd);
	});

	pi.on("session_shutdown", async () => {
		harnessServer.stop();
	});
}
