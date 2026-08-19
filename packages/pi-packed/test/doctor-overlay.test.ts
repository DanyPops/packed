import { afterEach, describe, expect, it } from "bun:test";
import type { DoctorReport } from "@danypops/pi-packed/doctor-format";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DoctorOverlay } from "../extension/src/doctor-overlay.ts";

function cleanReport(): DoctorReport {
	return { ok: true, conflicts: [], extensions: [], scanned: 9, truncated: false, serviceUnits: [], duplicateDependencies: [] };
}

function dirtyReport(): DoctorReport {
	return {
		...cleanReport(),
		ok: false,
		serviceUnits: [
			{ code: "SERVICE_STALE_CODE", severity: "warning", package: "@danypops/pi-papyrus", unitName: "papyrus", message: "stale" },
		],
	};
}

function fakeClient(invoke: () => Promise<DoctorReport>): VehicleClient {
	return {
		async manifest() {
			return { name: "packed", version: "0.0.0", description: "", operations: [] };
		},
		invoke,
		async close() {},
	} as unknown as VehicleClient;
}

describe("DoctorOverlay", () => {
	afterEach(() => {});

	it("registers the widget once refresh() finds at least one real issue", async () => {
		let registeredKey: string | undefined;
		const uiCtx = {
			setWidget: (key: string, factory: unknown) => {
				if (factory !== undefined) registeredKey = key;
			},
		} as unknown as ExtensionUIContext;

		const overlay = new DoctorOverlay(fakeClient(async () => dirtyReport()));
		overlay.setUI(uiCtx);
		await overlay.refresh();

		expect(registeredKey).toBeDefined();
	});

	it("hides (unregisters) the widget once refresh() finds a clean report", async () => {
		let report = dirtyReport();
		const setWidgetCalls: unknown[] = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;

		const overlay = new DoctorOverlay(fakeClient(async () => report));
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		report = cleanReport();
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});

	it("never throws, even when the daemon is unreachable or rendering itself fails", async () => {
		const overlay = new DoctorOverlay(
			fakeClient(async () => {
				throw new Error("daemon unavailable");
			}),
		);
		overlay.setUI({} as ExtensionUIContext);
		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("does nothing (no throw) when refresh() is called before setUI()", async () => {
		const overlay = new DoctorOverlay(fakeClient(async () => dirtyReport()));
		await expect(overlay.refresh()).resolves.toBeUndefined();
	});

	it("startPolling/stopPolling/dispose manage a bounded fallback poll, same as every other overlay in this ecosystem", async () => {
		let calls = 0;
		const overlay = new DoctorOverlay(
			fakeClient(async () => {
				calls += 1;
				return cleanReport();
			}),
		);
		overlay.setUI({ setWidget: () => {} } as unknown as ExtensionUIContext);

		overlay.startPolling(5);
		await new Promise((resolve) => setTimeout(resolve, 25));
		overlay.stopPolling();
		const callsAfterStop = calls;
		expect(callsAfterStop).toBeGreaterThan(0);

		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(calls).toBe(callsAfterStop); // stopped -- no further ticks

		overlay.dispose();
	});

	it("dispose() unregisters the widget and stops polling", async () => {
		const setWidgetCalls: unknown[] = [];
		const uiCtx = { setWidget: (_key: string, factory: unknown) => setWidgetCalls.push(factory) } as unknown as ExtensionUIContext;
		const overlay = new DoctorOverlay(fakeClient(async () => dirtyReport()));
		overlay.setUI(uiCtx);
		await overlay.refresh();
		expect(setWidgetCalls.at(-1)).toBeDefined();

		overlay.dispose();
		expect(setWidgetCalls.at(-1)).toBeUndefined();
	});
});
