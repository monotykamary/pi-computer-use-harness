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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadComputerUseConfig, getLoadedComputerUseConfig } from "../src/config.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Resolve the project root (where package.json lives). */
function getProjectRoot(): string {
	// When pi loads the extension via tsx, __dirname is the source
	// directory containing this file (e.g. .../pi-computer-use/extensions).
	// The project root is one level up.
	return join(__dirname, "..");
}

/** Resolve the CLI entry point (TypeScript source). */
function getCliTsPath(): string {
	return join(getProjectRoot(), "harness", "cli.ts");
}

function installShellAlias(): void {
	try {
		const agentBinDir = join(homedir(), ".pi", "agent", "bin");
		if (!fs.existsSync(agentBinDir)) {
			fs.mkdirSync(agentBinDir, { recursive: true });
		}
		const cliTsPath = getCliTsPath();
		const linkPath = join(agentBinDir, "pi-computer-use");

		// Use npx tsx so the wrapper works regardless of global tsx installation.
		// The project root must be the cwd so relative imports in cli.ts resolve.
		const projectRoot = getProjectRoot();
		const wrapperContent = `#!/bin/sh
cd "${projectRoot}" 2>/dev/null
exec npx tsx "${cliTsPath}" "$@"
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

interface HarnessServerController {
	start(): void;
	stop(): void;
}

function createHarnessServer(): HarnessServerController {
	let harnessProcess: ChildProcess | null = null;

	function start(): void {
		if (harnessProcess) return;
		if (process.env.PI_SWARM_SPAWNED === "1") return;

		const cliTsPath = getCliTsPath();
		const projectRoot = getProjectRoot();

		try {
			harnessProcess = spawnChild("npx", ["tsx", cliTsPath, "--start"], {
				cwd: projectRoot,
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
