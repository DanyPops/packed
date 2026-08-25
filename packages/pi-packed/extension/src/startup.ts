import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DeferredStartupTask {
	readonly id: string;
	/** Higher priorities start first. Tasks run concurrently so one slow task cannot hold lower-priority work. */
	readonly priority: number;
	run(ctx: ExtensionContext, isCurrent: () => boolean): Promise<void> | void;
	dispose?(): Promise<void> | void;
}

export interface DeferredStartupHandle {
	/** Waits for the most recently scheduled deferred batch. Primarily useful for tests and diagnostics. */
	waitForDeferred(): Promise<void>;
}

export interface DeferredStartupOptions {
	/** Schedules work after Pi's current startup turn. Defaults to a zero-delay timer. */
	schedule?: (callback: () => void) => () => void;
}

function defaultSchedule(callback: () => void): () => void {
	const timer = setTimeout(callback, 0);
	return () => clearTimeout(timer);
}

/**
 * Registers lazy.nvim-style "VeryLazy" work: session_start only schedules a
 * priority-ordered batch and returns immediately. The batch starts on the next
 * timer turn, and session replacement invalidates work before it can touch a
 * stale ExtensionContext.
 */
export function registerDeferredStartup(
	pi: ExtensionAPI,
	tasks: readonly DeferredStartupTask[],
	options: DeferredStartupOptions = {},
): DeferredStartupHandle {
	const ordered = [...tasks].sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
	const schedule = options.schedule ?? defaultSchedule;
	let generation = 0;
	let cancelScheduled: (() => void) | undefined;
	let settleScheduled: (() => void) | undefined;
	let latestBatch = Promise.resolve();

	function disposeTasks(): void {
		for (const task of ordered) {
			try {
				void Promise.resolve(task.dispose?.()).catch(() => {});
			} catch {
				// Deferred cleanup is best-effort and must not delay session teardown.
			}
		}
	}

	pi.on("session_start", (_event, ctx) => {
		cancelScheduled?.();
		settleScheduled?.();
		disposeTasks();
		const currentGeneration = ++generation;
		latestBatch = new Promise<void>((resolve) => {
			settleScheduled = resolve;
		});
		cancelScheduled = schedule(() => {
			cancelScheduled = undefined;
			const settle = settleScheduled;
			settleScheduled = undefined;
			const isCurrent = () => generation === currentGeneration;
			const pending = ordered.map((task) =>
				Promise.resolve()
					.then(() => {
						if (!isCurrent()) return;
						return task.run(ctx, isCurrent);
					})
					.catch(() => {}),
			);
			void Promise.all(pending).then(() => settle?.());
		});
	});

	pi.on("session_shutdown", () => {
		generation++;
		cancelScheduled?.();
		cancelScheduled = undefined;
		settleScheduled?.();
		settleScheduled = undefined;
		disposeTasks();
	});

	return { waitForDeferred: () => latestBatch };
}
