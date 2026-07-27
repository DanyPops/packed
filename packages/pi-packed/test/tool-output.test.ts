import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	createInfoDetails,
	createModelContent,
	createMutationDetails,
	createSearchDetails,
	parsePackageToolDetails,
	renderPackageToolCall,
	renderPackageToolResult,
} from "../extension/src/tool-output.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const context = { isPartial: false } as any;

describe("pi-packed dual-channel tool output", () => {
	it("bounds model content independently from structured details", () => {
		const content = createModelContent("x".repeat(20_000));
		expect(content.truncated).toBe(true);
		expect(content.text.length).toBeLessThanOrEqual(2_000);
		expect(content.text).toContain(`[truncated ${content.omitted} characters]`);

		const details = createSearchDetails("theme", 500, Array.from({ length: 80 }, (_, index) => ({
			name: `pkg-${index}`,
			version: "1.0.0",
			description: "d".repeat(1_000),
		})));
		expect(details.items).toHaveLength(50);
		expect(details.items[0]?.description.length).toBeLessThanOrEqual(240);
		expect(details.truncated).toBe(true);
		expect(parsePackageToolDetails(details)?.kind).toBe("search");
	});

	it("keeps package info bounded and excludes raw npm metadata", () => {
		const details = createInfoDetails({
			name: "pkg",
			version: "1.2.3",
			description: "description",
			homepage: "https://example.test/pkg?token=secret",
			repository: "https://user:secret@example.test/repo?key=value",
			license: "MIT",
			keywords: Array.from({ length: 50 }, (_, index) => `keyword-${index}`),
			pi: { extensions: ["private/internal/path.ts"], prompts: ["secret"] },
			packageEvidence: { shape: "manifest", verified: true, evidence: ["pi.extensions"] },
			publication: { provenanceUrl: "https://registry.example/provenance?token=secret", trustedPublisher: "unknown" },
		});
		expect(details.package.keywords).toHaveLength(20);
		expect(details.package).toMatchObject({ shape: "manifest", verified: true, provenance: "https://registry.example/provenance", trustedPublisher: "unknown" });
		expect(JSON.stringify(details)).not.toContain("private/internal");
		expect(JSON.stringify(details)).not.toContain("secret");
	});

	it("renders collapsed and expanded outcomes without parsing model content", () => {
		const details = createSearchDetails("theme", 2, [
			{ name: "one", version: "1.0.0", description: "First" },
			{ name: "two", version: "2.0.0", description: "Second" },
		]);
		const result = { content: [{ type: "text" as const, text: "unrelated compact model result" }], details };
		const collapsed = renderPackageToolResult(result, { expanded: false, isPartial: false }, theme, context).render(80).join("\n");
		const expanded = renderPackageToolResult(result, { expanded: true, isPartial: false }, theme, context).render(80).join("\n");
		expect(collapsed).toContain("2 packages");
		expect(expanded).toContain("one@1.0.0");
		expect(expanded).not.toContain("unrelated compact");
	});

	it("redacts URL credentials and query data from calls and mutation details", () => {
		const target = "https://user:password@example.test/pkg.tgz?token=secret";
		const call = renderPackageToolCall("Install package", { source: target }, theme).render(100).join("\n");
		const details = createMutationDetails("install", target, "succeeded", `installed ${target}`);
		expect(call).toContain("https://example.test/pkg.tgz");
		expect(JSON.stringify(details)).not.toContain("password");
		expect(JSON.stringify(details)).not.toContain("secret");
	});

	it("falls back safely for absent or malformed persisted details", () => {
		const fallback = renderPackageToolResult(
			{ content: [{ type: "text" as const, text: "safe fallback" }], details: { kind: "unknown" } },
			{ expanded: false, isPartial: false }, theme, context,
		).render(80).join("\n");
		expect(fallback).toContain("safe fallback");
		expect(parsePackageToolDetails({ kind: "unknown" })).toBeUndefined();
		const invalidTotal = createSearchDetails("query", 1, []);
		invalidTotal.total = Number.POSITIVE_INFINITY;
		expect(parsePackageToolDetails(invalidTotal)).toBeUndefined();
		const oversizedInfo = createInfoDetails({ name: "pkg", version: "1.0.0" });
		oversizedInfo.package.repository = "x".repeat(2_000);
		expect(parsePackageToolDetails(oversizedInfo)).toBeUndefined();
	});
});
