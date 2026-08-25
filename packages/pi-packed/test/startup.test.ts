import { describe, expect, it } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDeferredStartup } from "../extension/src/startup.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	return {
		pi: {
			on(event: string, handler: Handler) {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI,
		handlers,
	};
}

const ctx = {} as ExtensionContext;

describe("registerDeferredStartup", () => {
	it("returns from session_start before slow work and starts higher priorities first", async () => {
		const { pi, handlers } = fakePi();
		const scheduled: Array<() => void> = [];
		const starts: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handle = registerDeferredStartup(
			pi,
			[
				{
					id: "slow-high",
					priority: 900,
					async run() {
						starts.push("slow-high");
						await blocked;
					},
				},
				{ id: "fast-low", priority: 100, run: () => void starts.push("fast-low") },
			],
			{
				schedule(callback) {
					scheduled.push(callback);
					return () => {};
				},
			},
		);

		expect(handlers.get("session_start")!({ reason: "startup" }, ctx)).toBeUndefined();
		expect(starts).toEqual([]);
		scheduled[0]!();
		await Promise.resolve();
		expect(starts).toEqual(["slow-high", "fast-low"]);

		let settled = false;
		void handle.waitForDeferred().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		await handle.waitForDeferred();
		expect(settled).toBe(true);
	});

	it("cancels queued work and invalidates in-flight session context on shutdown", async () => {
		const { pi, handlers } = fakePi();
		const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
		const applied: string[] = [];
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handle = registerDeferredStartup(
			pi,
			[
				{
					id: "contextual",
					priority: 100,
					async run(_ctx, isCurrent) {
						await blocked;
						if (isCurrent()) applied.push("stale-ui-write");
					},
				},
			],
			{
				schedule(callback) {
					const item = { callback, cancelled: false };
					scheduled.push(item);
					return () => {
						item.cancelled = true;
					};
				},
			},
		);

		handlers.get("session_start")!({ reason: "startup" }, ctx);
		scheduled[0]!.callback();
		await Promise.resolve();
		handlers.get("session_shutdown")!({ reason: "reload" }, ctx);
		release();
		await handle.waitForDeferred();
		expect(applied).toEqual([]);

		handlers.get("session_start")!({ reason: "reload" }, ctx);
		handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		expect(scheduled[1]!.cancelled).toBe(true);
		scheduled[1]!.callback();
		await Promise.resolve();
		expect(applied).toEqual([]);
	});
});
