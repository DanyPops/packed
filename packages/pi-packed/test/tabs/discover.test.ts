import { describe, expect, it } from "bun:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Natives, PackageSummary } from "../../extension/src/packed.ts";
import { InstallServiceError } from "../../extension/src/packed.ts";
import type { TabHost } from "../../extension/src/tab-host.ts";
import { applyInstall, FindTab } from "../../extension/src/tabs/discover.ts";

const result: PackageSummary = { name: "pi-lsp", version: "1.0.0", description: "LSP support" };

function fakeCtx(confirm: boolean, notices: string[], reloads: { count: number }): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			async confirm(_title: string, message: string) {
				notices.push(`confirm:${message}`);
				return confirm;
			},
			notify(message: string) {
				notices.push(message);
			},
		},
		async reload() {
			reloads.count += 1;
		},
	} as unknown as ExtensionCommandContext;
}

describe("FindTab entity inspection", () => {
	it("uses i to inspect the selected search-result Card after search settles", async () => {
		let inspected: string | undefined;
		const host = {
			inspectPackage(name: string) {
				inspected = name;
			},
			requestRender() {},
		} as unknown as TabHost;
		const tab = new FindTab(
			{
				async search() {
					return { query: "hello", total: 1, results: [{ name: "demo", version: "1.0.0", description: "Demo" }] };
				},
			} as unknown as Natives,
			host,
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text } as Theme,
		);
		tab.handleInput("hello");
		tab.handleInput("\r");
		await Bun.sleep(0);
		tab.handleInput("i");
		expect(inspected).toBe("demo");
		expect(tab.render(40).join("\n")).toContain("┌");
	});
});

describe("applyInstall (/packed find's install action)", () => {
	it("warns inline before running, requires approval like every other mutation surface", async () => {
		const notices: string[] = [];
		const reloads = { count: 0 };
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async install() {
				return "Installed npm:pi-lsp";
			},
			async installService() {
				throw new InstallServiceError("not a daemon", true);
			},
		} as unknown as Natives;

		const outcome = await applyInstall(result, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("installed");
		expect(notices.some((n) => n.startsWith("confirm:"))).toBe(true);
		expect(reloads.count).toBe(1);
	});

	it("never installs or reloads when approval is declined", async () => {
		const reloads = { count: 0 };
		let installCalled = false;
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async install() {
				installCalled = true;
				return "";
			},
		} as unknown as Natives;

		const outcome = await applyInstall(result, natives, fakeCtx(false, [], reloads));

		expect(outcome).toBe("cancelled");
		expect(installCalled).toBe(false);
		expect(reloads.count).toBe(0);
	});

	it("reports install failure without reloading", async () => {
		const reloads = { count: 0 };
		const notices: string[] = [];
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async install() {
				throw new Error("registry unreachable");
			},
		} as unknown as Natives;

		const outcome = await applyInstall(result, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("failed");
		expect(reloads.count).toBe(0);
		expect(notices.some((n) => n.includes("registry unreachable"))).toBe(true);
	});

	it("surfaces a genuine service-registration failure without failing the install itself", async () => {
		const reloads = { count: 0 };
		const notices: string[] = [];
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async install() {
				return "Installed npm:pi-lsp";
			},
			async installService() {
				throw new Error("systemctl unavailable");
			},
		} as unknown as Natives;

		const outcome = await applyInstall(result, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("installed");
		expect(reloads.count).toBe(1);
		expect(notices.some((n) => n.includes("systemctl unavailable"))).toBe(true);
	});

	it("stays silent about service registration for an ordinary, non-daemon package", async () => {
		const reloads = { count: 0 };
		const notices: string[] = [];
		const natives = {
			async security() {
				return { mutationApproval: "always" as const };
			},
			async install() {
				return "Installed npm:pi-lsp";
			},
			async installService() {
				throw new InstallServiceError("not a daemon", true);
			},
		} as unknown as Natives;

		const outcome = await applyInstall(result, natives, fakeCtx(true, notices, reloads));

		expect(outcome).toBe("installed");
		expect(notices.some((n) => n.includes("could not register"))).toBe(false);
	});
});
