import type { ChildProcess } from "node:child_process";

/** Await this child's readiness, not a different process answering on the port. */
export function waitForHarnessReady(child: ChildProcess, signal: AbortSignal, timeoutMs = 15000): Promise<void> {
	return new Promise((resolve, reject) => {
		let buffer = "";
		const finish = (error?: Error) => {
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			child.off("exit", onExit);
			child.off("error", onError);
			signal.removeEventListener("abort", onAbort);
			if (error) reject(error); else resolve();
		};
		const onExit = (code: number | null) => finish(new Error(`Harness exited before ready (${code})`));
		const onError = (error: Error) => finish(error);
		const onAbort = () => finish(new Error("Harness startup cancelled"));
		const onData = (chunk: Buffer) => {
			buffer += chunk.toString();
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				try {
					if (JSON.parse(line).ready === true) { finish(); return; }
				} catch { /* Ignore unrelated output. */ }
			}
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error("Harness did not become ready before timeout"));
		}, timeoutMs);
		child.stdout?.on("data", onData);
		child.once("exit", onExit);
		child.once("error", onError);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

interface HarnessLifecycleOptions {
	isRunning(): Promise<boolean>;
	spawn(): ChildProcess;
	ready?(child: ChildProcess, signal: AbortSignal): Promise<void>;
	onError?(error: unknown): void;
	shutdownTimeoutMs?: number;
}

/** Own only the direct child we spawn, never a server discovered on the shared port. */
export function createHarnessLifecycle(options: HarnessLifecycleOptions) {
	let generation = 0;
	let queue = Promise.resolve();
	let starting: AbortController | undefined;
	let owned: { child: ChildProcess; exited: Promise<void> } | undefined;

	function enqueue(operation: () => Promise<void>): Promise<void> {
		queue = queue.then(operation).catch((error) => options.onError?.(error));
		return queue;
	}

	return {
		start(): Promise<void> {
			const request = ++generation;
			return enqueue(async () => {
				if (request !== generation || owned) return;
				const running = await options.isRunning();
				// Shutdown may have arrived while the health request was pending.
				if (request !== generation || running) return;
				const child = options.spawn();
				let finish!: () => void;
				const entry = { child, exited: new Promise<void>((resolve) => { finish = resolve; }) };
				owned = entry;
				const onExit = () => {
					if (owned === entry) owned = undefined;
					finish();
				};
				child.once("exit", onExit);
				// spawn errors are asynchronous and must always have a listener.
				child.on("error", (error) => {
					options.onError?.(error);
					if (!child.pid) onExit();
				});
				const controller = new AbortController();
				starting = controller;
				try {
					await options.ready?.(child, controller.signal);
				} catch (error) {
					if (!controller.signal.aborted) throw error;
				} finally {
					if (starting === controller) starting = undefined;
				}
			});
		},
		stop(): Promise<void> {
			++generation;
			starting?.abort();
			return enqueue(async () => {
				const entry = owned;
				if (!entry) return;
				const waitForExit = async () => {
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						return await Promise.race([
							entry.exited.then(() => true),
							new Promise<false>((resolve) => {
								timer = setTimeout(() => resolve(false), options.shutdownTimeoutMs ?? 2000);
							}),
						]);
					} finally {
						clearTimeout(timer);
					}
				};
				entry.child.kill("SIGTERM");
				if (!await waitForExit()) {
					entry.child.kill("SIGKILL");
					if (!await waitForExit()) throw new Error("Harness child did not exit after SIGKILL");
				}
			});
		},
	};
}
