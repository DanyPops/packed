# Development Rules

Two packages: `packed` (repository-policy checks, adoption/doctor checks, the
`repository-policy-cli`) and `pi-packed` (the Pi extension + daemon -- package install/publish,
service supervision via `@danypops/armada`, a real `VehicleRegistry`). See `@danypops/vehicle`'s
own AGENTS.md for the shared substrate both build on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "confirmed
  live") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable.
- Read a file in full before a wide-ranging change to it.
- `pi-packed`'s adoption/doctor checks (`service/src/adoption/*`) are policy code -- a check that
  silently stops firing is worse than one that's too strict. Add a test for a new check's own
  positive AND negative case, not just the happy path.
- `duplicate-dependency-doctor.ts` exists because bun's default hoisting does not fail on
  non-overlapping semver ranges for pre-1.0 packages -- it silently nests multiple copies
  instead. Keep this doctor in sync with any new shared-state package this ecosystem adds as a
  `peerDependency` elsewhere (vehicle-client-pi, lector, ...).
- `vehicle-registration.ts`/`vehicle-target.ts` are the daemon-side and client-side halves of
  this package's own Vehicle adoption -- changing one without checking the other regresses the
  wire contract silently (no compiler error across a manifest boundary).

## Commands

- Per-package: `bun run --cwd packages/<pkg> build`, then that package's own typecheck/test.
- Whole workspace: `bun run build` (must run first -- typecheck/test both depend on built
  `dist/`), `bun run typecheck`, `bun run test`, `bun run lint` (`biome check --write . &&
  eslint packages --max-warnings 0`), `bun run policy` (this repo's own `repository-policy-cli`,
  dogfooding its own check surface).
- `prepare` wires `core.hooksPath` to `.githooks` -- a fresh clone needs `bun install` once
  before local hooks are active.
- Run the touched package's build + typecheck + test after every change, then the
  workspace-wide typecheck before considering a change done.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` (and any package holding shared mutable module-level state) is a
  `peerDependency`, not a plain `dependency` -- verify via source inspection before migrating a
  dependency's kind, don't assume.
- Before trusting a test result, confirm the workspace's own declared dependency floor for a
  sibling package actually covers that sibling's current local version -- a stale floor makes
  bun silently resolve an old published copy instead of linking local source.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH for a backward-compatible change), build +
  typecheck + test + lint locally, commit, push, then tag and push the tag.
  `@danypops/packed` uses `packed-v<version>`, `@danypops/pi-packed` uses
  `pi-packed-v<version>` -- see `.github/workflows/publish.yml`. Push tags one at a time, never
  batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking

- Work here is tracked in the shared Papyrus task database (project root: this repo's own
  directory). `tasks.start` → implement → `tasks.set_gates` (a real, re-runnable command proving
  the fix) → `tasks.submit` → `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.
