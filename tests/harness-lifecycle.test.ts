import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import computerUseExtension from "../extensions/computer-use.ts";
import { PassThrough } from "node:stream";
import { createHarnessLifecycle, waitForHarnessReady } from "../src/harness-lifecycle.ts";

function fakeChild(autoExit = true) {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperty(child, "pid", { value: 123 });
	const signals: Array<NodeJS.Signals | number | undefined> = [];
	child.kill = (signal) => {
		signals.push(signal);
		if (autoExit || signal === "SIGKILL") queueMicrotask(() => child.emit("exit", 0, signal));
		return true;
	};
	return { child, signals };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

test("owns direct child, starts once, awaits shutdown, and can restart", async () => {
	const children: ReturnType<typeof fakeChild>[] = [];
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
	});
	await lifecycle.start();
	await lifecycle.start();
	assert.equal(children.length, 1);
	await lifecycle.stop();
	await lifecycle.stop();
	assert.deepEqual(children[0].signals, ["SIGTERM"]);
	await lifecycle.start();
	assert.equal(children.length, 2);
	await lifecycle.stop();
});

test("reuses existing standalone server without taking ownership or signaling it", async () => {
	let spawns = 0;
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => true,
		spawn: () => { spawns++; return fakeChild().child; },
	});
	await lifecycle.start();
	await lifecycle.stop();
	assert.equal(spawns, 0);
});

test("stop cancels an in-flight asynchronous health probe", async () => {
	const probe = deferred<boolean>();
	const entered = deferred<void>();
	let spawns = 0;
	const lifecycle = createHarnessLifecycle({
		isRunning: () => { entered.resolve(); return probe.promise; },
		spawn: () => { spawns++; return fakeChild().child; },
	});
	const starting = lifecycle.start();
	await entered.promise;
	const stopping = lifecycle.stop();
	probe.resolve(false);
	await Promise.all([starting, stopping]);
	assert.equal(spawns, 0);
});

test("start arriving during stop runs only after the old child exits", async () => {
	const children: ReturnType<typeof fakeChild>[] = [];
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
	});
	await lifecycle.start();
	await Promise.all([lifecycle.stop(), lifecycle.start()]);
	assert.deepEqual(children[0].signals, ["SIGTERM"]);
	assert.equal(children.length, 2);
	await lifecycle.stop();
});

test("child exit (including losing a port race) releases only that child", async () => {
	const children: ReturnType<typeof fakeChild>[] = [];
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => {
			const child = fakeChild();
			children.push(child);
			return child.child;
		},
	});
	await lifecycle.start();
	children[0].child.emit("exit", 1, null);
	await lifecycle.start();
	await lifecycle.stop();
	assert.deepEqual(children[0].signals, []);
	assert.deepEqual(children[1].signals, ["SIGTERM"]);
});

test("handles emitted spawn errors and synchronous failures without unhandled rejection", async () => {
	const errors: unknown[] = [];
	const child = new EventEmitter() as ChildProcess;
	let attempts = 0;
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => {
			if (++attempts === 1) throw new Error("missing loader");
			queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
			return child;
		},
		onError: (error) => errors.push(error),
	});
	await lifecycle.start();
	await lifecycle.start();
	await lifecycle.stop();
	assert.equal(errors.length, 2);
});

test("bounds graceful shutdown and escalates only the owned child", async () => {
	const child = fakeChild(false);
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => child.child,
		shutdownTimeoutMs: 5,
	});
	await lifecycle.start();
	await lifecycle.stop();
	assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("startup awaits its own ready message and handles fragmented output", async () => {
	const fake = fakeChild();
	const stdout = new PassThrough();
	Object.defineProperty(fake.child, "stdout", { value: stdout });
	let ready = false;
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => fake.child,
		ready: waitForHarnessReady,
	});
	const starting = lifecycle.start().then(() => { ready = true; });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ready, false);
	stdout.write('unrelated output\n{"ready":');
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(ready, false);
	stdout.write('true}\n');
	await starting;
	assert.equal(ready, true);
	await lifecycle.stop();
});

test("shutdown cancels waiting for readiness and stops the owned process", async () => {
	const fake = fakeChild();
	Object.defineProperty(fake.child, "stdout", { value: new PassThrough() });
	const errors: unknown[] = [];
	const lifecycle = createHarnessLifecycle({
		isRunning: async () => false,
		spawn: () => fake.child,
		ready: waitForHarnessReady,
		onError: error => errors.push(error),
	});
	const starting = lifecycle.start();
	await new Promise(resolve => setImmediate(resolve));
	await Promise.all([starting, lifecycle.stop()]);
	assert.deepEqual(fake.signals, ["SIGTERM"]);
	assert.deepEqual(errors, []);
});

test("readiness fails on early exit and terminates a timed-out child", async () => {
	const early = fakeChild();
	const exited = waitForHarnessReady(early.child, new AbortController().signal);
	early.child.emit("exit", 1);
	await assert.rejects(exited, /exited before ready/);
	const stalled = fakeChild();
	await assert.rejects(waitForHarnessReady(stalled.child, new AbortController().signal, 5), /before timeout/);
	assert.deepEqual(stalled.signals, ["SIGTERM"]);
});

test("extension starts a ready server and shuts down its actual child", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-extension-lifecycle-"));
	const reservation = createServer();
	reservation.listen(0, "127.0.0.1");
	await once(reservation, "listening");
	const address = reservation.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
	const overrides = {
		PI_CODING_AGENT_DIR: directory,
		PI_COMPUTER_USE_PORT: String(port),
		PI_COMPUTER_USE_LOG: join(directory, "harness.log"),
		PI_SWARM_SPAWNED: "0",
	};
	const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
	Object.assign(process.env, overrides);
	const handlers = new Map<string, (...args: any[]) => Promise<void>>();
	try {
		computerUseExtension({
			registerCommand() {},
			on(name: string, handler: (...args: any[]) => Promise<void>) {
				handlers.set(name, handler);
				return () => handlers.delete(name);
			},
		} as unknown as ExtensionAPI);
		await handlers.get("session_start")!({}, { cwd: directory, hasUI: true });
		// Startup must not resolve before the direct child is listening.
		const response = await fetch(`http://127.0.0.1:${port}/health`);
		const health = await response.json() as { pid: number };
		assert.notEqual(health.pid, process.pid);
		await handlers.get("session_shutdown")!();
		assert.throws(() => process.kill(health.pid, 0), /ESRCH/);
		await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
	} finally {
		await handlers.get("session_shutdown")?.();
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("server initializes config before first health response, without native helper", { timeout: 15000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-computer-use-lifecycle-"));
	const child = spawn(process.execPath, [
		"--import", import.meta.resolve("tsx"),
		fileURLToPath(new URL("../harness/server.ts", import.meta.url)),
	], {
		cwd: directory,
		env: {
			...process.env,
			PI_COMPUTER_USE_PORT: "0",
			PI_COMPUTER_USE_LOG: join(directory, "harness.log"),
			PI_COMPUTER_USE_BROWSER_USE: "false",
			PI_COMPUTER_USE_STEALTH_MODE: "true",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	let stderr = "";
	child.stderr!.on("data", (chunk) => { stderr += chunk; });
	try {
		const ready = await new Promise<{ port: number }>((resolve, reject) => {
			let stdout = "";
			child.stdout!.on("data", (chunk) => {
				stdout += chunk;
				if (stdout.includes("\n")) {
					try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); }
				}
			});
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
		});
		assert.notEqual(ready.port, 9876);
		const response = await fetch(`http://127.0.0.1:${ready.port}/health`);
		const health = await response.json() as { pid: number; config: unknown };
		assert.equal(health.pid, child.pid);
		assert.deepEqual(health.config, { browser_use: false, stealth_mode: true });
	} finally {
		child.kill("SIGTERM");
		await closed;
		await rm(directory, { recursive: true, force: true });
	}
});
