import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDaemonServiceSpec } from "../src/daemon-service.ts";

function fakePiHome(): string {
	return mkdtempSync(join(tmpdir(), "packed-daemon-service-"));
}

function writePackage(piHome: string, name: string, manifest: unknown): void {
	const dir = join(piHome, "npm", "node_modules", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...(manifest ? { packed: { daemonService: manifest } } : {}) }));
}

describe("resolveDaemonServiceSpec", () => {
	it("builds a ServiceSpec from a package's packed.daemonService manifest", () => {
		const piHome = fakePiHome();
		writePackage(piHome, "@danypops/web-spider-daemon", { binPath: "dist/cli.js", args: ["serve"] });

		const result = resolveDaemonServiceSpec(piHome, "npm:@danypops/web-spider-daemon");
		expect(result).toEqual({
			ok: true,
			spec: {
				name: "web-spider-daemon",
				displayName: undefined,
				binPath: join(piHome, "npm", "node_modules", "@danypops/web-spider-daemon", "dist/cli.js"),
				args: ["serve"],
				descriptorPath: expect.stringContaining("web-spider-daemon") as unknown as string,
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
		expect(result).toEqual({ ok: false, reason: expect.stringContaining("does not declare a packed.daemonService manifest") as unknown as string });
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
});
