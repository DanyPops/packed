import { describe, expect, it } from "bun:test";
import type { Component } from "malevich-tui-components";
import { TuiErrorBoundary } from "../extension/src/tui-error-boundary.ts";

const fallback = ["Packed could not render.", "Restart Pi and run /packed again."];

describe("TuiErrorBoundary", () => {
	it("contains a render exception and replaces it with bounded actionable output", () => {
		let failures = 0;
		const component: Component = {
			render() {
				throw new TypeError("Card is not a constructor");
			},
			invalidate() {},
		};
		const boundary = new TuiErrorBoundary(component, fallback, () => {
			failures += 1;
		});

		expect(boundary.render(80)).toEqual(fallback);
		expect(boundary.render(80)).toEqual(fallback);
		expect(failures).toBe(1);
	});

	it("contains an input exception and renders the same safe failure state", () => {
		const component: Component = {
			render() {
				return ["ready"];
			},
			invalidate() {},
			handleInput() {
				throw new Error("input failed");
			},
		};
		const boundary = new TuiErrorBoundary(component, fallback);

		boundary.handleInput("i");

		expect(boundary.render(80)).toEqual(fallback);
	});
});
