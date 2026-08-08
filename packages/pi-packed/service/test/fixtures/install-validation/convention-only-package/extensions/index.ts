export default function conventionOnlyFixtureExtension(pi: { registerCommand: (name: string, def: unknown) => void }) {
	pi.registerCommand("convention-only-fixture", { description: "registers cleanly", handler: async () => {} });
}
