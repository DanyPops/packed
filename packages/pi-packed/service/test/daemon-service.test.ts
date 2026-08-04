import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VehicleRegistrar } from "@danypops/armada";
import { createArmadaTestHarness } from "@danypops/armada/testing";
import { detectVehicleDaemonService, RealDaemonServiceInstaller, resolveDaemonServiceSpec } from "../src/daemon/daemon-service.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakePiHome(): string {
	const root = mkdtempSync(join(tmpdir(), "packed-daemon-service-"));
	roots.push(root);
	return root;
}

function writePackage(piHome: string, name: string, manifest: unknown): void {
	const dir = join(piHome, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", ...(manifest ? { packed: { daemonService: manifest } } : {}) }),
	);
}

function writeRawPackage(dir: string, pkg: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

describe("resolveDaemonServiceSpec", () => {
	it("builds a ServiceSpec from a package's packed.daemonService manifest", () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", {
			binPath: "dist/cli.js",
			args: ["serve"],
			restartOnFailure: true,
			restartSec: 2,
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/web-spider-daemon");
		expect(result).toEqual({
			ok: true,
			spec: {
				name: "web-spider-daemon",
				displayName: undefined,
				version: "1.0.0",
				binPath: join(piHome, "npm", "node_modules", "@danypops/web-spider-daemon", "dist/cli.js"),
				args: ["serve"],
				handlePath: expect.stringContaining("web-spider-daemon") as unknown as string,
				workingDirectory: undefined,
				restartOnFailure: true,
				restartSec: 2,
			},
		});
	});

	it("honors an explicit name/displayName override instead of deriving one from the npm package name", () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", name: "web-spider", displayName: "Web Spider" });

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/web-spider-daemon");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.spec.name).toBe("web-spider");
		expect(result.spec.displayName).toBe("Web Spider");
	});

	it("fails closed for a package that declares no daemonService manifest", () => {
		const piHome = fakePiHome();
		writePackage(piHome, "some-pkg", undefined);

		const result = resolveDaemonServiceSpec(piHome, "npm:some-pkg");
		expect(result).toEqual({
			ok: false,
			notADaemon: true,
			reason: expect.stringContaining("does not declare a packed.daemonService manifest") as unknown as string,
		});
	});

	it("fails closed for a package that was never actually installed", () => {
		const piHome = fakePiHome();
		const result = resolveDaemonServiceSpec(piHome, "npm:never-installed");
		expect(result.ok).toBe(false);
	});

	it("fails closed for a non-npm source -- git:/local resolution isn't supported yet", () => {
		const piHome = fakePiHome();
		const result = resolveDaemonServiceSpec(piHome, "git:github.com/u/r@v1");
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("only supports npm:") as unknown as string });
	});

	it("falls back to detection when the package itself is the daemon (bin + real vehicle-server dependency, no manifest)", () => {
		const piHome = fakePiHome();
		const dir = join(piHome, "npm", "node_modules", "@danypops/papyrus");
		writeRawPackage(dir, {
			name: "@danypops/papyrus",
			version: "1.0.0",
			bin: { papyrus: "src/cli.ts" },
			dependencies: { "@danypops/vehicle-server": "^0.1.0" },
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/papyrus");
		expect(result).toEqual({
			ok: true,
			spec: {
				name: "papyrus",
				displayName: undefined,
				version: "1.0.0",
				binPath: join(dir, "src/cli.ts"),
				args: ["serve"],
				handlePath: expect.stringContaining("papyrus") as unknown as string,
				workingDirectory: undefined,
			},
		});
	});

	it("falls back to detection one level into a real dependency -- a Pi extension with no daemon of its own", () => {
		const piHome = fakePiHome();
		const extDir = join(piHome, "npm", "node_modules", "@danypops/pi-papyrus");
		writeRawPackage(extDir, { name: "@danypops/pi-papyrus", version: "1.0.0", dependencies: { "@danypops/papyrus": "^0.38.0" } });
		const depDir = join(extDir, "node_modules", "@danypops/papyrus");
		writeRawPackage(depDir, {
			name: "@danypops/papyrus",
			version: "0.38.0",
			bin: { papyrus: "src/cli.ts" },
			dependencies: { "@danypops/vehicle-server": "^0.1.0" },
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/pi-papyrus");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.spec.binPath).toBe(join(depDir, "src/cli.ts"));
		expect(result.spec.args).toEqual(["serve"]);
		expect(result.spec.name).toBe("papyrus");
	});

	it("falls back to detection via npm's hoisted top-level node_modules, not just a nested one -- the real on-disk layout for a flat npm install", () => {
		const piHome = fakePiHome();
		const extDir = join(piHome, "npm", "node_modules", "@danypops/pi-papyrus");
		writeRawPackage(extDir, { name: "@danypops/pi-papyrus", version: "1.0.0", dependencies: { "@danypops/papyrus": "^0.38.0" } });
		// Hoisted to the SAME top-level node_modules as pi-papyrus itself, not nested under it --
		// confirmed live as the real layout npm produces for a flat single-root install (Packed's
		// own piHome/npm install target), as opposed to the nested-dependency layout the prior test
		// exercises. Both are real, both must resolve.
		const depDir = join(piHome, "npm", "node_modules", "@danypops/papyrus");
		writeRawPackage(depDir, {
			name: "@danypops/papyrus",
			version: "0.38.0",
			bin: { papyrus: "src/cli.ts" },
			dependencies: { "@danypops/vehicle-server": "^0.1.0" },
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/pi-papyrus");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.spec.binPath).toBe(join(depDir, "src/cli.ts"));
		expect(result.spec.args).toEqual(["serve"]);
		expect(result.spec.name).toBe("papyrus");
	});

	it("also detects the legacy @danypops/daemon-kit dependency name, not just vehicle-server", () => {
		const piHome = fakePiHome();
		const dir = join(piHome, "npm", "node_modules", "@danypops/web-spider-daemon");
		writeRawPackage(dir, {
			name: "@danypops/web-spider-daemon",
			version: "1.0.0",
			bin: { "web-spider": "src/cli.ts" },
			dependencies: { "@danypops/daemon-kit": "^0.18.0" },
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/web-spider-daemon");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.spec.binPath).toBe(join(dir, "src/cli.ts"));
	});

	it("an explicit manifest still wins over detection when both are present", () => {
		const piHome = fakePiHome();
		const dir = join(piHome, "npm", "node_modules", "@danypops/papyrus");
		writeRawPackage(dir, {
			name: "@danypops/papyrus",
			version: "1.0.0",
			bin: { papyrus: "src/cli.ts" },
			dependencies: { "@danypops/vehicle-server": "^0.1.0" },
			packed: { daemonService: { binPath: "dist/cli.js", args: ["serve", "--custom"], name: "papyrus-custom" } },
		});

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/papyrus");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok");
		expect(result.spec.binPath).toBe(join(dir, "dist/cli.js"));
		expect(result.spec.args).toEqual(["serve", "--custom"]);
		expect(result.spec.name).toBe("papyrus-custom");
	});

	it("detects nothing for a package with a bin but no real vehicle-server/daemon-kit dependency", () => {
		const piHome = fakePiHome();
		const dir = join(piHome, "npm", "node_modules", "some-cli");
		writeRawPackage(dir, { name: "some-cli", version: "1.0.0", bin: { "some-cli": "src/cli.ts" }, dependencies: { commander: "^12.0.0" } });

		expect(detectVehicleDaemonService(dir, "some-cli")).toBeUndefined();
		const result = resolveDaemonServiceSpec(piHome, "npm:some-cli");
		expect(result.ok).toBe(false);
	});
});

describe("RealDaemonServiceInstaller -- Armada registration through the in-process registrar", () => {
	it("install() resolves the package and drives Armada's real registrar/reconciler through the isolated harness", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			const outcome = await installer.install(piHome, "npm:@danypops/web-spider-daemon");

			expect(outcome).toMatchObject({ ok: true, result: { installed: true }, spec: { name: "web-spider-daemon" } });
			expect(harness.application("web-spider-daemon").state()).toBe("ready");
			expect(harness.events()).toEqual([
				"replace:armada-web-spider-daemon.service",
				"start:armada-web-spider-daemon.service",
				"ready:web-spider-daemon",
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("install() never asks Armada to replace Packed from inside Packed's own process", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/pi-packed", { binPath: "service/src/cli/cli.ts", args: ["serve"] });
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			const outcome = await installer.install(piHome, "npm:@danypops/pi-packed");

			expect(outcome).toMatchObject({ ok: true, result: { installed: false }, spec: { name: "pi-packed" } });
			expect(harness.events()).toEqual([]);
			expect(await harness.registrar.isRegistered("pi-packed")).toBe(false);
		} finally {
			await harness.dispose();
		}
	});

	it("install() reports a non-daemon package without touching Armada", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "some-pkg", undefined);
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			const outcome = await installer.install(piHome, "npm:some-pkg");

			expect(outcome).toMatchObject({ ok: false, notADaemon: true });
			expect(harness.events()).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("remove() unregisters the resolved Vehicle through Armada's real registrar", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			await installer.install(piHome, "npm:@danypops/web-spider-daemon");
			const outcome = await installer.remove(piHome, "npm:@danypops/web-spider-daemon");

			expect(outcome).toMatchObject({ ok: true, result: { installed: true } });
			expect(await harness.registrar.isRegistered("web-spider-daemon")).toBe(false);
			expect(harness.events().at(-1)).toBe("remove:armada-web-spider-daemon.service");
		} finally {
			await harness.dispose();
		}
	});

	it("restart() is a no-op when Armada has no registration for this Vehicle", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			const outcome = await installer.restart(piHome, "npm:@danypops/web-spider-daemon");

			expect(outcome).toMatchObject({ ok: true, restarted: false });
			expect(harness.events()).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("restart() re-registers a changed on-disk version through Armada's update plan", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });
		const harness = await createArmadaTestHarness();
		try {
			const installer = new RealDaemonServiceInstaller(harness.registrar);
			await installer.install(piHome, "npm:@danypops/web-spider-daemon");
			const packagePath = join(piHome, "npm", "node_modules", "@danypops/web-spider-daemon", "package.json");
			writeFileSync(
				packagePath,
				JSON.stringify({
					name: "@danypops/web-spider-daemon",
					version: "1.1.0",
					packed: { daemonService: { binPath: "dist/cli.js", args: ["serve"] } },
				}),
			);
			const outcome = await installer.restart(piHome, "npm:@danypops/web-spider-daemon");

			expect(outcome).toMatchObject({ ok: true, restarted: true, spec: { version: "1.1.0" } });
			expect(harness.events().slice(-4)).toEqual([
				"stop:armada-web-spider-daemon.service",
				"replace:armada-web-spider-daemon.service",
				"start:armada-web-spider-daemon.service",
				"ready:web-spider-daemon",
			]);
		} finally {
			await harness.dispose();
		}
	});

	it("surfaces a failed Armada registration's diagnostics in-band", async () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });
		const registrar: VehicleRegistrar = {
			register: async () => ({ ok: false, diagnostics: [{ code: "X", severity: "error", path: "/", message: "native failure" }] }),
			unregister: async () => ({ ok: false, diagnostics: [] }),
			isRegistered: async () => false,
		};
		const installer = new RealDaemonServiceInstaller(registrar);

		const outcome = await installer.install(piHome, "npm:@danypops/web-spider-daemon");

		expect(outcome).toMatchObject({ ok: true, result: { installed: false, reason: "native failure" } });
	});
});
