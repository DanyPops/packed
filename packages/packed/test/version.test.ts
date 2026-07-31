import { describe, expect, it } from "bun:test";
import { buildVersionReport, formatVersionReport } from "../src/shared/version.ts";

describe("buildVersionReport (daemon-vs-installed drift detection)", () => {
	it("reports no daemon section at all when none is reachable -- not a drift concern", () => {
		expect(buildVersionReport("0.3.1", undefined)).toEqual({ installed: "0.3.1" });
	});

	it("reports a matching daemon as not stale", () => {
		expect(buildVersionReport("0.3.1", "0.3.1")).toEqual({ installed: "0.3.1", daemon: { version: "0.3.1", stale: false } });
	});

	it("reports a mismatched daemon as stale, regardless of direction", () => {
		expect(buildVersionReport("0.3.1", "0.3.0")).toEqual({ installed: "0.3.1", daemon: { version: "0.3.0", stale: true } });
		expect(buildVersionReport("0.3.0", "0.3.1")).toEqual({ installed: "0.3.0", daemon: { version: "0.3.1", stale: true } });
	});
});

describe("formatVersionReport", () => {
	it("prints just the installed version when no daemon is reachable", () => {
		expect(formatVersionReport({ installed: "0.3.1" })).toBe("packed 0.3.1 (installed)\n");
	});

	it("prints a clear up-to-date line when the daemon matches", () => {
		const report = buildVersionReport("0.3.1", "0.3.1");
		expect(formatVersionReport(report)).toBe("packed 0.3.1 (installed)\ndaemon running v0.3.1 -- up to date\n");
	});

	it("prints an explicit STALE warning with a concrete restart suggestion when the daemon predates the installed version", () => {
		const report = buildVersionReport("0.3.1", "0.3.0");
		const output = formatVersionReport(report);
		expect(output).toContain("STALE");
		expect(output).toContain("daemon running v0.3.0");
		expect(output).toContain("restart required to pick up v0.3.1");
		expect(output).toContain("systemctl --user restart pi-packed.service");
	});
});
