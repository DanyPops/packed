import { describe, expect, it } from "bun:test";
import { Spinner } from "../extension/src/spinner.ts";

describe("Spinner", () => {
	it("starts on the first frame", () => {
		expect(new Spinner().glyph()).toBe("⠋");
	});

	it("tick() is pure and synchronous -- advances exactly one frame, no timer required to test it", () => {
		const spinner = new Spinner();
		const first = spinner.glyph();
		spinner.tick();
		expect(spinner.glyph()).not.toBe(first);
	});

	it("wraps back to the first frame after a full cycle", () => {
		const spinner = new Spinner();
		const seen = new Set<string>();
		for (let i = 0; i < 10; i++) {
			seen.add(spinner.glyph());
			spinner.tick();
		}
		expect(spinner.glyph()).toBe("⠋"); // 10 frames, back to start
		expect(seen.size).toBe(10); // every frame really is distinct
	});

	it("start() wires tick() to a real interval and calls onTick after each advance", async () => {
		const spinner = new Spinner();
		const initial = spinner.glyph();
		let ticks = 0;
		spinner.start(() => { ticks += 1; });
		await new Promise((resolve) => setTimeout(resolve, 250));
		spinner.stop();
		expect(ticks).toBeGreaterThan(0);
		expect(spinner.glyph()).not.toBe(initial);
	});

	it("stop() is safe to call before start(), and more than once", () => {
		const spinner = new Spinner();
		expect(() => { spinner.stop(); spinner.stop(); }).not.toThrow();
	});

	it("stop() actually halts the interval -- no further ticks after stopping", async () => {
		const spinner = new Spinner();
		let ticks = 0;
		spinner.start(() => { ticks += 1; });
		await new Promise((resolve) => setTimeout(resolve, 100));
		spinner.stop();
		const ticksAtStop = ticks;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(ticks).toBe(ticksAtStop);
	});

	it("start() is idempotent -- calling it again restarts cleanly instead of stacking a second interval", async () => {
		const spinner = new Spinner();
		let ticks = 0;
		spinner.start(() => { ticks += 1; });
		spinner.start(() => { ticks += 1; }); // must not leave the first interval running too
		await new Promise((resolve) => setTimeout(resolve, 250));
		const ticksAtOneRunning = ticks;
		spinner.stop();
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(ticks).toBe(ticksAtOneRunning); // confirms only one interval was ever active
	});
});
