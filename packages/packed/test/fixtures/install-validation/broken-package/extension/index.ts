export default function brokenFixtureExtension(_pi: unknown) {
	throw new Error("brokenFixtureExtension deliberately fails during registration");
}
