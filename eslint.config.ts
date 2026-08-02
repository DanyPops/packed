/**
 * Narrow, gap-filling ESLint config -- Biome (biome.json) is the primary
 * linter/formatter here. This only covers what Biome 2.x still can't:
 * full type-aware no-floating-promises, import-cycle detection, and a
 * custom barrel-import ban.
 */
import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const SOURCE = [
	"packages/*/src/**/*.ts",
	"packages/*/service/src/**/*.ts",
	"packages/*/service/test/**/*.ts",
	"packages/*/extension/**/*.ts",
	"packages/*/test/**/*.ts",
	"packages/*/schema/**/*.ts",
	"packages/*/setup/**/*.ts",
];

export default tseslint.config(
	{ ignores: ["**/dist/**", "**/*.d.ts"] },

	{
		files: SOURCE,
		languageOptions: { parser: tseslint.parser },
		plugins: { "import-x": importX },
		settings: {
			"import-x/resolver": { typescript: true },
		},
		rules: {
			"import-x/no-cycle": ["error", { ignoreExternal: true }],
			// regex (not group globs), anchored with $: a bare glob like "../index" also matches an
			// unrelated "../index/build-index.ts" (ESLint's own `ignore`-package matcher treats an
			// `index`-named directory as fully matched, including its contents) -- this repo has a
			// real index/ directory that isn't a barrel.
			"no-restricted-imports": ["error", {
				patterns: [{
					regex: "^(\\.\\.?/)+index(\\.(js|ts))?$",
					message: "Do not import from barrel files. Import from the source module, or a dedicated package.json subpath, instead.",
				}],
			}],
		},
	},

	{
		files: ["packages/*/src/**/*.ts", "packages/*/service/src/**/*.ts", "packages/*/extension/**/*.ts"],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		plugins: { "@typescript-eslint": tseslint.plugin },
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
		},
	},
);
