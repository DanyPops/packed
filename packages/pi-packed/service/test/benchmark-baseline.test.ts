import { describe, expect, it } from "bun:test";
import {
	benchmarkArtifact,
	doctorDailyProjection,
	runBenchmarkWorkload,
	PACKED_BENCHMARK_SCENARIOS,
} from "../benchmarks/baseline.ts";

class FakeClient {
	readonly calls: Array<{ operation: string; input: Record<string, unknown> }> = [];

	async invoke(operation: string, input: Record<string, unknown>): Promise<unknown> {
		this.calls.push({ operation, input });
		if (operation === "package.catalog") return { packages: [{ name: "pi-one" }], sha256: "catalog-digest" };
		if (operation === "package.index") return { packages: [{ name: "pi-one" }], truncated: false };
		if (operation === "package.updates") return { updates: [] };
		if (operation === "package.catalog.sync") return { synced: 12 };
		if (operation === "package.index.build") return { packages: [{ name: "pi-one" }], truncated: false };
		if (operation === "package.updates.project") return { updates: [{ name: "pi-one" }] };
		if (operation === "doctor.run") return { ok: true, scanned: 4, extensions: [], conflicts: [] };
		throw new Error(`unexpected operation ${operation}`);
	}
}

describe("Packed benchmark scenarios", () => {
	it("covers all bounded workload classes", () => {
		expect(PACKED_BENCHMARK_SCENARIOS.map((scenario) => scenario.name)).toEqual([
			"idle-polling",
			"cached-reads-cold",
			"cached-reads-warm",
			"doctor-cold",
			"doctor-warm",
			"doctor-concurrent",
			"catalog-sync-cold",
			"catalog-sync-warm",
			"index-build-cold",
			"index-build-warm",
			"updates-project",
		]);
		for (const scenario of PACKED_BENCHMARK_SCENARIOS) {
			expect(scenario.repetitions).toBeGreaterThan(0);
			expect(scenario.repetitions).toBeLessThanOrEqual(5);
			expect(scenario.concurrency).toBeLessThanOrEqual(2);
			expect(scenario.deadlineMs).toBeLessThanOrEqual(120_000);
		}
	});

	it("uses bounded inputs and digest output", async () => {
		const client = new FakeClient();
		for (const mode of [
			"cached-reads-warm",
			"doctor-warm",
			"catalog-sync-warm",
			"index-build-warm",
			"updates-project",
		] as const) {
			expect(await runBenchmarkWorkload(mode, client, "/synthetic/project")).toMatch(/^[a-f0-9]{64}$/);
		}
		expect(client.calls.map((call) => call.operation)).toEqual([
			"package.catalog",
			"package.index",
			"package.updates",
			"doctor.run",
			"package.catalog.sync",
			"package.index.build",
			"package.updates.project",
		]);
	});

	it("projects Doctor cost from complete days", () => {
		expect(doctorDailyProjection({ since: "2026-08-20", until: "2026-09-03", days: 14, calls: 28_000 }, 12, 20)).toEqual({
			status: "available",
			source: "packed metrics.query",
			since: "2026-08-20",
			until: "2026-09-03",
			days: 14,
			calls: 28_000,
			callsPerDay: 2_000,
			projectedDailyCpuMs: 24_000,
			projectedDailyWallMs: 40_000,
		});
	});

	it("bounds artifacts and marks unavailable counters", () => {
		const artifact = benchmarkArtifact({
			generatedAt: "2026-01-01T00:00:00.000Z",
			environment: { platform: "linux", architecture: "x64", runtime: "bun", logicalCpuCount: 8 },
			frequency: { status: "unavailable" },
			results: [{ name: "doctor-cold", benchmark: { workload: { outputDigest: "a".repeat(64) } } }],
		});
		const serialized = JSON.stringify(artifact);
		expect(serialized.length).toBeLessThan(256_000);
		expect(serialized).not.toContain("/home/");
		expect(serialized).not.toContain("settings.json");
		expect(artifact.schemaVersion).toBe(1);
		expect(artifact.networkBytes).toBe("unavailable");
	});
});
