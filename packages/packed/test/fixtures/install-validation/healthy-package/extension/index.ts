export default function healthyFixtureExtension(pi: { registerCommand: (name: string, def: unknown) => void }) {
	pi.registerCommand("healthy-fixture", { description: "registers cleanly", handler: async () => {} });
}
