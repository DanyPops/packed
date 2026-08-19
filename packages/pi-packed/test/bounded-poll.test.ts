import { describe, expect, it } from "bun:test";
import { BoundedPoll } from "../extension/src/bounded-poll.ts";

describe("BoundedPoll", () => {
	it("calls tick repeatedly at the given interval once started", async () => {
		const poll = new BoundedPoll();
		let calls = 0;
		poll.start(5, () => {
			calls++;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		poll.stop();
		expect(calls).toBeGreaterThanOrEqual(2);
	});

	it("a second start() is a no-op, not a competing second timer", async () => {
		const poll = new BoundedPoll();
		let calls = 0;
		poll.start(5, () => {
			calls++;
		});
		poll.start(5, () => {
			calls++;
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		poll.stop();
		// If start() stacked a second timer, calls would roughly double for the same window.
		const first = calls;
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(calls).toBe(first); // stopped -- no further ticks from either timer
	});

	it("stop() is safe to call even if never started", () => {
		const poll = new BoundedPoll();
		expect(() => poll.stop()).not.toThrow();
	});

	it("stop() then start() again resumes ticking", async () => {
		const poll = new BoundedPoll();
		let calls = 0;
		poll.start(5, () => calls++);
		await new Promise((resolve) => setTimeout(resolve, 15));
		poll.stop();
		const afterFirstRun = calls;

		poll.start(5, () => calls++);
		await new Promise((resolve) => setTimeout(resolve, 15));
		poll.stop();
		expect(calls).toBeGreaterThan(afterFirstRun);
	});
});
