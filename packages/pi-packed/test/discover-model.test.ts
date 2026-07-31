import { describe, expect, it } from "bun:test";
import { shouldSearch } from "../extension/src/discover-model.ts";

describe("shouldSearch (/packed find's dual-purpose Enter key)", () => {
	it("searches on the first Enter, before anything has been searched", () => {
		expect(shouldSearch("pi-lsp", undefined, false)).toBe(true);
	});

	it("does not search an empty query with no prior results", () => {
		expect(shouldSearch("", undefined, false)).toBe(false);
	});

	it("re-searches when the query changed since the last search", () => {
		expect(shouldSearch("pi-lsp-v2", "pi-lsp", true)).toBe(true);
	});

	it("treats an unchanged query with existing results as 'activate the highlighted result'", () => {
		expect(shouldSearch("pi-lsp", "pi-lsp", true)).toBe(false);
	});
});
