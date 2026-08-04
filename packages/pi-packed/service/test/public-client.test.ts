import { describe, expect, it } from "bun:test";
import { ensureClient } from "../src/public/client.ts";

describe("ensureClient (packed daemon auto-spawn-or-wait decision)", () => {
	it("connects immediately without ever checking for a service or spawning, when already reachable", async () => {
		let spawnCalls = 0;
		let serviceChecks = 0;
		const client = { fake: true } as never;
		const result = await ensureClient({
			connect: async () => client,
			isServiceInstalled: () => {
				serviceChecks++;
				return false;
			},
			spawn: () => {
				spawnCalls++;
			},
			sleep: async () => {},
		});
		expect(result).toBe(client);
		expect(spawnCalls).toBe(0);
		expect(serviceChecks).toBe(0);
	});

	it("spawns a detached daemon when no service is installed and none is reachable", async () => {
		let spawnCalls = 0;
		let connectAttempts = 0;
		const client = { fake: true } as never;
		const result = await ensureClient({
			connect: async () => {
				connectAttempts++;
				if (connectAttempts < 3) throw new Error("not yet");
				return client;
			},
			isServiceInstalled: () => false,
			spawn: () => {
				spawnCalls++;
			},
			sleep: async () => {},
			retryAttempts: 5,
			retryDelayMs: 0,
		});
		expect(result).toBe(client);
		expect(spawnCalls).toBe(1);
	});

	it("never spawns a second daemon when a supervised service is installed -- the real fix for the confirmed stray-daemon hazard: an auto-spawned orphan can silently outlive and win the lock race against every later supervised restart", async () => {
		let spawnCalls = 0;
		let connectAttempts = 0;
		const client = { fake: true } as never;
		const result = await ensureClient({
			connect: async () => {
				connectAttempts++;
				if (connectAttempts < 3) throw new Error("not yet");
				return client;
			},
			isServiceInstalled: () => true,
			spawn: () => {
				spawnCalls++;
			},
			sleep: async () => {},
			retryAttempts: 5,
			retryDelayMs: 0,
		});
		expect(result).toBe(client);
		expect(spawnCalls).toBe(0); // waited for the supervised service instead
		expect(connectAttempts).toBeGreaterThan(1); // genuinely retried, not a single shot
	});

	it("explains the supervisor failure and recovery when a managed service never becomes reachable", async () => {
		let message = "";
		try {
			await ensureClient({
				connect: async () => {
					throw new Error("never reachable");
				},
				isServiceInstalled: () => true,
				spawn: () => {
					throw new Error("must never be called");
				},
				sleep: async () => {},
				retryAttempts: 2,
				retryDelayMs: 0,
			});
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("managed Packed service is registered but unreachable");
		expect(message).toContain("restart the managed service");
		expect(message).toContain("will not auto-spawn a competing process");
		expect(message).not.toContain("packed doctor");
	});

	it("fails with a plain timeout message, and did spawn, when no service is installed and nothing ever becomes reachable", async () => {
		let spawnCalls = 0;
		await expect(
			ensureClient({
				connect: async () => {
					throw new Error("never reachable");
				},
				isServiceInstalled: () => false,
				spawn: () => {
					spawnCalls++;
				},
				sleep: async () => {},
				retryAttempts: 2,
				retryDelayMs: 0,
			}),
		).rejects.toThrow(/did not become ready/);
		expect(spawnCalls).toBe(1);
	});

	it("checks for an installed service exactly once per ensureClient call, not once per retry", async () => {
		let serviceChecks = 0;
		let connectAttempts = 0;
		const client = { fake: true } as never;
		await ensureClient({
			connect: async () => {
				connectAttempts++;
				if (connectAttempts < 4) throw new Error("not yet");
				return client;
			},
			isServiceInstalled: () => {
				serviceChecks++;
				return true;
			},
			spawn: () => {},
			sleep: async () => {},
			retryAttempts: 10,
			retryDelayMs: 0,
		});
		expect(serviceChecks).toBe(1);
	});
});
