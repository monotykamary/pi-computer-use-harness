import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));

function client(binary) {
	const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
	const pending = new Map();
	let sequence = 0;
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += chunk; });
	const lines = createInterface({ input: child.stdout });
	lines.on("line", line => {
		const reply = JSON.parse(line);
		const waiter = pending.get(reply.id);
		if (!waiter) return;
		pending.delete(reply.id);
		clearTimeout(waiter.timer);
		if (reply.ok) waiter.resolve(reply.result);
		else waiter.reject(new Error(JSON.stringify(reply.error)));
	});
	child.on("error", rejectAll);
	child.on("exit", code => rejectAll(new Error(`Helper exited (${code}): ${stderr}`)));
	function rejectAll(error) {
		for (const waiter of pending.values()) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		pending.clear();
	}
	return {
		child,
		request(cmd, split = false) {
			const id = String(++sequence);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Helper request timed out: ${cmd}; ${stderr}`));
				}, 5000);
				pending.set(id, { resolve, reject, timer });
				const message = JSON.stringify({ id, cmd }) + "\n";
				if (split) {
					const midpoint = Math.floor(message.length / 2);
					child.stdin.write(message.slice(0, midpoint));
					setTimeout(() => child.stdin.write(message.slice(midpoint)), 20);
				} else child.stdin.write(message);
			});
		},
		async stop() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = once(child, "exit");
			child.kill("SIGTERM");
			await exited;
			lines.close();
		},
	};
}

async function eventually(predicate, message) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(100);
	}
	assert.fail(message);
}

test("one native helper sees app launch and exit while stdin is idle", {
	skip: process.platform !== "darwin",
	timeout: 120000,
}, async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), "pi-native-discovery-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const helper = process.env.PI_COMPUTER_USE_TEST_HELPER ?? path.join(dir, "bridge");
	if (!process.env.PI_COMPUTER_USE_TEST_HELPER) {
		execFileSync(process.execPath, ["scripts/build-native.mjs", "--variant", "legacy", "--output", helper], {
			cwd: root, stdio: "inherit", timeout: 60000,
		});
	}

	// A disposable regular app with no windows; never activate or modify a user's app.
	const bundle = path.join(dir, "Discovery Fixture.app");
	const macOS = path.join(bundle, "Contents", "MacOS");
	await mkdir(macOS, { recursive: true });
	await writeFile(path.join(bundle, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.pi.discovery-fixture.${process.pid}</string>
<key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundleName</key><string>Discovery Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
	const source = path.join(dir, "fixture.swift");
	await writeFile(source, `import AppKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
print("ready")
fflush(stdout)
app.run()
`);
	const executable = path.join(macOS, "fixture");
	execFileSync("xcrun", ["swiftc", "-framework", "AppKit", source, "-o", executable], { timeout: 60000 });

	const bridge = client(helper);
	t.after(() => bridge.stop());
	await bridge.request("listApps"); // Initialize NSWorkspace before the app exists.
	const fixture = spawn(executable, [], { stdio: ["ignore", "pipe", "pipe"] });
	t.after(async () => {
		if (fixture.exitCode === null && fixture.signalCode === null) {
			const exited = once(fixture, "exit");
			fixture.kill("SIGTERM");
			await exited;
		}
	});
	await once(fixture.stdout, "data");

	// Fresh processes establish that Launch Services sees the fixture, independently
	// of the persistent helper's own NSWorkspace cache.
	await eventually(async () => {
		const observer = client(helper);
		try { return (await observer.request("listApps")).some(app => app.pid === fixture.pid); }
		finally { await observer.stop(); }
	}, "Fixture did not register as a regular application");
	await eventually(async () => (await bridge.request("listApps")).some(app => app.pid === fixture.pid),
		"Persistent helper omitted the newly launched app (NSWorkspace cache is stale)");

	const exited = once(fixture, "exit");
	fixture.kill("SIGTERM");
	await exited;
	await eventually(async () => !(await bridge.request("listApps")).some(app => app.pid === fixture.pid),
		"Persistent helper retained an exited app");

	// The event-driven reader must still handle fragments and consecutive requests.
	assert.ok(Array.isArray(await bridge.request("listApps", true)));
	const replies = await Promise.all([bridge.request("listApps"), bridge.request("listApps")]);
	assert.ok(replies.every(Array.isArray));
	const helperExit = once(bridge.child, "exit");
	bridge.child.stdin.end();
	const [code] = await helperExit;
	assert.equal(code, 0, "stdin EOF should shut down the helper cleanly");
});
