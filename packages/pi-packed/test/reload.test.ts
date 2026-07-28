import { describe, expect, it } from "bun:test";
import { reloadWarning } from "../extension/src/reload.ts";

describe("reloadWarning (shared pre-confirmation wording)", () => {
	it("warns remove as a definite reload, install/update as a likely one", () => {
		expect(reloadWarning("remove")).toContain("will require a Pi reload");
		expect(reloadWarning("install")).toContain("will likely require a Pi reload");
		expect(reloadWarning("update")).toContain("will likely require a Pi reload");
	});
});
