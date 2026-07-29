# Packed workspace

Private Bun workspace for:

- `packages/packed` — `@danypops/packed`, the standalone CLI, daemon, catalog, validation, package lifecycle, and setup core.
- `packages/pi-packed` — `@danypops/pi-packed`, the Pi commands, tools, profiles, and TUI adapter.

The workspace root is never published. The extension imports only the compiled `@danypops/packed/client` and `@danypops/packed/protocol` boundaries.

Packed provides DNF-style package management for the [Pi](https://github.com/earendil-works/pi) agent that both **you** and the **agent** can use.

The agent gets native tools (`pkg_search`, `pkg_info`, `pkg_install`, `pkg_update`, and `pkg_remove`); you get
the `packed` CLI and an interactive `/packages` TUI. The extension is a thin,
Node-compatible client. Registry access, SQLite, and package execution remain
inside the supervised Bun daemon.

```text
┌─ Pi extension (Node-compatible) ──────────────┐
│ pkg_search · pkg_info · pkg_install/update/remove│
│ /packages · /packed permission settings         │
│ operation-aware approval · no Bun/SQLite access │
└──────────────────┬────────────────────────────┘
                   │ authenticated loopback HTTP
┌─ packed.service (Bun) ────────────────────────┐
│ typed package client API · watcher · mirror   │
│ npm registry · SQLite WAL · pi install/remove │
└───────────────────────────────────────────────┘
```

## Quickstart

```bash
bun test
packed service > ~/.config/systemd/user/packed.service
systemctl --user daemon-reload
systemctl --user enable --now packed.service

packed search lsp
packed install npm:pi-lsp
packed installed --json

# In Pi after installing the package:
/packages
```

Packages execute arbitrary code and mutate Pi settings/install roots. One daemon-owned operation policy classifies every public package operation. Install, update, remove, and security-setting changes require explicit approval by default (`mutationApproval: always`); search, info, installed, catalog, check, and update-status reads are bounded reads, while mirror refresh is classified maintenance. Open `/packed` to retain the recommended approval policy or deliberately choose the unsafe **Never require mutation approval** opt-out. `/packages` uses the same policy for updates and removals.

## CLI

| Command | What |
|---|---|
| `packed search <q> [--offline] [--limit N] [--json]` | Search npm or the local mirror, scoped to `keywords:pi-package` |
| `packed info <name> [--json]` | Show version, repository, Pi manifest, size, and license |
| `packed updates [--json]` | Show drift from the local mirror |
| `packed update <source> [--approve] [--json]` | Update one configured source through `pi update --extension` |
| `packed update --self [--approve] [--json]` | Update Packed itself (npm-global installs; a local checkout is left to your own `git pull`) and restart its supervised `pi-packed.service` (Linux/systemd only) |
| `packed mirror [--json]` | Refresh the SQLite package index |
| `packed installed [--json]` | Read Pi's installed package declarations |
| `packed catalog [--json]` | Inspect the local package index |
| `packed check [path] [--smoke] [--json]` | Diagnose Pi resources and npm packaging; optionally load extensions in an isolated child |
| `packed pack [path] [--json]` | Inspect exact `npm pack --dry-run --json --ignore-scripts` output and verify shipped Pi resources |
| `packed score [path\|name] [--json]` | Report discoverability, first-run, trust, maintenance, observational traction, declared Pi-version compatibility, and freshness (candidate vs. pi-coding-agent's own latest publish) evidence |
| `packed publish setup [path] [--force] [--json]` | Generate a least-privilege GitHub OIDC workflow for `npm stage publish` |
| `packed publish status [path] [--json] [--open-browser]` | Validate package, repository, workflow, Node, and npm prerequisites and print trust/approval handoff |
| `packed setup export [path] [--force] [--machine-local] [--json]` | Export immutable npm/git/HTTPS packages and scoped Pi profiles to `pi-setup.json` |
| `packed setup update [manifest] [--json]` | Deliberately refresh package versions, commits, and integrity |
| `packed setup plan [manifest\|--ecosystem] [--prune] [--json]` | Validate and show an additive or exact setup diff without mutation |
| `packed setup apply [manifest\|--ecosystem] [--prune] [--approve] [--json]` | Apply locked packages/profiles; optionally remove undeclared state last |
| `packed install <source> [--approve] [--no-service] [--json]` | Authenticated daemon install for `npm:`, `git:`, or `https://` sources; auto-registers a detected Vehicle daemon as a persistent service in the same step unless `--no-service` |
| `packed install-service <source> --approve [--json]` | Standalone service (re-)registration for an already-installed npm package's own daemon, via detection or an explicit `packed.daemonService` manifest |
| `packed remove <name> [--approve] [--json]` | Authenticated daemon removal by bare npm name; applies and reports any declared `pi.cleanup` paths first |
| `packed advisories [name] [--json]` | Report known advisories (severity, id, vulnerable range, patched-version age) for one or all installed npm-sourced Pi packages -- no lockfile required |
| `packed pi status [--json]` | Report the running Pi version against pi.dev's own latest-release endpoint -- the same source `pi update --self` itself uses, never the npm registry. On a real interactive terminal, offers to run `pi update --self` when behind |
| `packed resources list [--project <path>] [--json]` | List every installed package's extensions/skills/prompts/themes and their enabled state |
| `packed resources toggle <source> <field> <path> <on\|off> [--project <path>] [--approve] [--json]` | Enable or disable one declared resource through the same settings.json filter arrays `pi config` writes |
| `packed security [always\|never] [--approve] [--json]` | Read or set the package mutation approval policy |
| `packed serve` | Run the loopback daemon |
| `packed service` | Print the systemd user unit |
| `packed version` | Print the package/service version |

### Persistent daemon services

Every daemon-backed pi package already auto-spawns its own daemon lazily on first use (see each package's own `connectWithPolicy`/`ensure*Client` wiring) -- no install step is required for basic function. Surviving a reboot, however, has always meant separately discovering and running that package's own `<bin> service install` command by hand (`web-spider service install`, `papyrus service install`, `packed service` + manual `systemctl`).

`ensurePackedClient()` checks for a real, installed supervised service (`isServiceInstalled`, a plain file-existence check on the systemd unit / launchd plist path) before ever auto-spawning. When one is installed, it never spawns a second, differently-supervised process -- it retries the connection and, if the service genuinely never comes up, fails with a message pointing at the service instead of silently creating a competing daemon. This closes a real, confirmed hazard: an auto-spawned orphan gets a much longer idle budget than a supervised service typically does, so it could otherwise keep winning daemon-kit's single-instance lock race against every later `systemctl restart`, invisibly, for the rest of that budget.

**`packed install npm:<pkg> --approve` registers a detected daemon as a persistent service automatically, in the same step.** No manifest, no second command, for the common case: `resolveDaemonServiceSpec` first checks for an explicit `packed.daemonService` manifest (still supported, still wins when present -- useful for a non-standard bin name or args), then falls back to `detectVehicleDaemonService()`, which reads two conventions every real daemon-backed package already follows without declaring anything extra: a `bin` entry in `package.json`, and a `serve` subcommand on that same binary. A real dependency on `@danypops/vehicle-server` (or the legacy `@danypops/daemon-kit`) is the signal detection looks for -- checked on the installed package itself first, then one level into its own `dependencies` (the common shape: a Pi extension like `@danypops/pi-papyrus` has no daemon of its own, but npm already resolved its real daemon dependency, `@danypops/papyrus`, into its own `node_modules` during install). Service registration piggybacks on the exact same approval already granted for `install` -- both are the same `code-execution` mutation tier, not a new consent surface -- and never fails the install itself: a package that isn't a daemon at all (the overwhelming majority) is silently skipped, and a genuine registration failure (systemctl unavailable, etc.) is reported alongside a successful install, not in place of it. Pass `--no-service` to skip the attempt entirely.

An explicit manifest is still the right call for a non-standard package:

```json
{
  "packed": {
    "daemonService": {
      "binPath": "dist/cli.js",
      "args": ["serve"],
      "name": "web-spider",
      "displayName": "Web Spider"
    }
  }
}
```

`packed install-service <source>` remains available standalone -- for re-registering a service later without reinstalling the package, or for a package that opted out of auto-registration with `--no-service` the first time. It reads a manifest or falls back to the same detection `install` uses, and calls daemon-kit's `installUserService()` -- the exact same systemd `--user` / launchd / Windows Run-key mechanism that package's own `service install` command would use, so the two are fully interchangeable. git:/local sources aren't supported yet -- only `npm:`. Classified as a `code-execution` mutation, same tier as `install`/`update`, so it requires `--approve` under the secure default like everything else that runs code or touches system state.

Guarded CLI mutations require `--approve` under the secure default. This is pi-packed mutation authorization, distinct from Pi's project-trust `--approve` semantics. Install/remove JSON results are stable objects:

```json
{"ok":true,"source":"npm:pi-lsp","output":"Installed npm:pi-lsp"}
```

`packed check` does not load extensions or execute package lifecycle scripts by default. It emits stable diagnostic codes, composes publint for generic npm entrypoint/export/module-format checks, and owns Pi resource containment checks. Human output is capped at 8,000 characters; JSON output is capped at 32,000 characters.

`packed pack` uses npm's authoritative dry-run file list while suppressing lifecycle scripts. It bounds command time and output, rejects missing declared resources and sensitive-looking files, and classifies the tarball as keyword-only, manifest-shaped, or conventional Pi-shaped.

`packed score` reports each readiness dimension separately. npm downloads are bounded weekly/monthly observations and never contribute to a quality score. Provenance is shown when npm publishes an attestation; trusted-publisher status remains unknown unless independently verified because provenance alone does not prove that configuration.

### Pi profiles

Packed reads the existing `~/.pi/agent/profiles.json` and trusted-project `<project>/.pi/profiles.json` files; project names override global names. No conversion is required. A profile can set `provider`, `model`, `thinkingLevel`, `tools`, `instructions`, `theme`, and advisory `allowedModels` globs.

- `pi --profile work` activates a profile at startup.
- `/profile` opens the selector; `/profile work` activates one directly.
- `Ctrl+Shift+U` cycles through sorted profiles and the unprofiled state.
- Clearing restores the model, tools, thinking level, and theme captured before activation.
- Packed preserves `profiles-last.json` and existing `profile-state` session entries for migration from `pi-profiles`.

Remove the separate `pi-profiles` extension after installing a Packed release with profile support; loading both would register the same flag, command, and shortcut. Packed never deletes `profiles.json` or `profiles-last.json` during package removal. To roll back, remove the newer Packed source, reinstall the prior Packed version and `pi-profiles`, then restart Pi; the retained profile files and `profile-state` session entries remain compatible.

Inside Pi, `/packed setup plan [manifest] [--prune]` previews the same daemon plan. `/packed setup apply [manifest] [--prune]` confirms once, sends explicit daemon approval, and reloads Pi only when package state changed. Reload is terminal for that command frame. A trusted project's `defaultProfile` activates after that reload and on new sessions; no profile is auto-selected when `defaultProfile` is absent.

`--ecosystem` (plan/apply only) resolves to a curated @danypops starter manifest bundled in this same npm package (`setup/danypops-ecosystem.pi-setup.json`) -- every entry is a real, pinned, integrity-checked npm version, not a placeholder. This is the answer to "how do I install the whole toolchain": no shell installer, since every consumer already has npm/bun by the time Packed itself is reachable (Pi is an npm package too), and a shell script would just end up shelling back out to `pi install`/`packed install` anyway. `packed setup apply --ecosystem` uses the exact same schema-validated, approval-gated, no-network-fetch-to-decide-what-runs path as any hand-authored manifest.

`packed setup` is the reproducible-environment surface. Version 1 records exact npm versions and integrity, immutable git/HTTPS commits, explicitly machine-local paths, package scope, and global/project profiles. Export and plan never execute package code. `setup update` is the only resolution-refresh path. Apply requires package-operation approval, installs desired packages before atomic profile writes, and preserves undeclared state unless `--prune` is explicitly approved; prune removes profiles and packages last. The schema ships at `schema/pi-setup-v1.schema.json`; mutable git refs, portable local paths, credentials, unknown fields/versions, secret-like profile instructions, unsafe paths, and oversized inputs fail before mutation.

`packed publish setup` supports existing npm packages only. It pins GitHub actions, grants only `contents: read` and `id-token: write`, installs npm 11.15.0, runs the package's build/check/typecheck/test scripts plus `packed check`, and stages with `npm stage publish --provenance --ignore-scripts`. It never receives an npm token and never calls `npm publish`. Configure trust with the printed `npm trust github ... --allow-stage-publish` command or npm package access page, then inspect and approve the staged package with 2FA. Publishing is intentionally CLI/CI-only and is not registered as an agent tool.

On a real interactive terminal (never in `--json`/scripted/non-TTY contexts), `packed publish status` also offers to run `npm login --auth-type=web` when not logged in, and to walk you to npm's own Trusted Publisher page when trust isn't verified yet -- both only after you say yes. Headless by default: it prints the URL and waits for Enter rather than launching a browser (matching npm's own `--no-browser` config), so it's safe to run unattended or inside another tool. Pass `--open-browser` to have it launch a browser for you instead.

`freshness` prefers a real last-commit date over an npm publish-date proxy: for a local checkout it reads `git log` directly (no network); for a registry candidate it tries GitHub's Commits API against the package's declared `repository` (and `repository.directory` for a monorepo subpackage), GitHub-host-only and unauthenticated, falling back to the candidate's own npm publish date whenever the real commit date can't be resolved (non-GitHub host, no declared repository, or a rate-limited/failed lookup). Always observational, never a pass/fail gate.

Running `packed publish setup <path>` inside a Bun/npm workspace (a package.json declaring `workspaces` above the target package) writes one workflow per package, named after that package (`<name>-stage-publish.yml`), triggered only by that package's own `<name>-v*` tag so two sibling packages can never race on one trigger. A package that depends on another workspace package gets a mechanical core-first ordering guard: before it can stage, the workflow reads its already-installed dependency's resolved version and fails the job if npm doesn't already carry a compatible published release. `packed publish status` mirrors that same check locally (`coreFirst` in its report) so a stale ordering shows up before a tag is ever pushed.

A package may optionally declare `pi.cleanup: string[]` in its own `package.json` -- relative paths within its own installed directory that `packed remove` deletes and reports before delegating the actual uninstall to `pi remove`, addressing a real gap (`pi remove` fires no uninstall hook, so a package's own leftover state can otherwise survive removal silently). Every declared path is reported (`removed`/`missing`/`escaped`/`failed`), never deleted silently. Any path escaping the package's own directory (absolute, `..`, or a symlink pointing outside) fails closed as `escaped` and is never touched -- the same discipline `packed check` already enforces for declared resource patterns, and `packed check` validates a `pi.cleanup` declaration statically too. A package that declares nothing sees zero behavior change.

`packed advisories` batches every installed npm-sourced package's real, on-disk resolved version against npm's own lockfile-free bulk advisory endpoint (`POST -/npm/v1/security/advisories/bulk`) -- zero code execution, one bounded/timed-out network call. Each finding includes a patched-version-age heuristic as an explicit, separate field, never folded into severity: a fix published within the last 7 days is weaker assurance than one that has aged without a new report (the "poisoned patch" pattern), since the patched version is derived from the advisory's vulnerable-version range against the package's real publish history, not a field the bulk endpoint itself returns. Findings render through the same bounded `Diagnostic` envelope `packed check` uses, not a new ad hoc shape.

`packed check` also reports two purely static, non-executing capability signals over the exact shipped tarball contents: `PI_LIFECYCLE_SCRIPT_DECLARED` (warning) for any declared `preinstall`/`install`/`postinstall`/`prepare` script, with its exact command as evidence, and `PI_CAPABILITY_IMPORT` (info) for a shipped file importing a capability-suggestive module (`child_process`, `net`, `fs`, `bun:sqlite`, `dgram`, `worker_threads`, `node:`-prefixed or not). Neither blocks by itself -- both are evidence for a human or model to weigh, not a verdict.

`packed check --smoke` is explicit code execution. On Linux it loads at most ten extensions, one at a time, under bubblewrap with no network, a read-only package and runner, a 16 MiB temporary filesystem, a 3-second timeout, 64 KiB output cap, 16-process limit, 64-file-descriptor limit, and no inherited environment. It captures registrations without starting a model or invoking handlers. Smoke mode fails closed with `PI_EXTENSION_SMOKE_SANDBOX_UNAVAILABLE` when bubblewrap or `prlimit` is unavailable.

Failures use exit code 1 and `{ "ok": false, ... , "error": "..." }` with
credential-safe diagnostics. Usage errors use exit code 2.

## Native tool presentation

Native tools keep three output contracts independent:

- model-facing `content` is concise, credential-safe, and capped at 2,000 characters;
- renderer-facing `details` uses a versioned bounded package DTO and never retains raw npm metadata or manifest values;
- CLI human output and `--json` remain presenters over daemon DTOs and do not parse either native-tool channel.

Calls and results have themed collapsed and expanded renderers. Missing or legacy details fall back to model content, while daemon and execution failures are thrown through Pi's native error channel. Package approval refusal remains a normal `cancelled` or `denied` outcome.

## Service API

Every route requires the bearer token stored in the private state directory.
The daemon listens on loopback only.

| Method | Route |
|---|---|
| `GET` | `/health` |
| `GET` | `/ready` |
| `GET`, `POST` | `/api/v1/ops` — typed operation discovery and dispatch |
| `GET` | `/search?q=&limit=&offline=1` |
| `GET` | `/info?name=` |
| `GET` | `/installed` |
| `GET` | `/security` |
| `POST` | `/security` with `{ "mutationApproval": "always" | "never", "approved": true }` |
| `GET` | `/updates` |
| `GET` | `/catalog` |
| `POST` | `/install` with `{ "source": "...", "approved": true }` |
| `POST` | `/install-service` with `{ "source": "...", "approved": true }` |
| `POST` | `/update` with `{ "source": "...", "approved": true }` |
| `POST` | `/remove` with `{ "name": "...", "approved": true }` |

Packed uses daemon-kit's XDG split by default:

- data: `$XDG_DATA_HOME/pi-packed/packed.db`
- private state: `$XDG_STATE_HOME/pi-packed/{token,updates.json,security.json}`
- process discovery: `$XDG_RUNTIME_DIR/pi-packed/handle.json`

The first run copies missing data from the former `~/.cache/pi-packed/` layout. Existing 128-bit daemon tokens are rotated to daemon-kit's 256-bit format. `PI_PACKED_HOME` keeps all files under one explicit directory for compatibility. Relevant environment variables:

- `PI_PACKED_HOME`
- `PI_PACKED_PI_HOME`
- `PI_PACKED_WATCH_SECS`
- `PI_PACKED_CATALOG_SECS`
- `PI_PACKED_IDLE_SECS`
- `PI_PACKED_PI_BIN` / `PI_BIN`

## Architecture and safety

- **Daemon-owned SQLite:** extensions never open the mirror directly.
- **Runtime boundary:** extensions never call `Bun.spawn`; only the supervised
  Bun daemon owns the `ExecInstaller` adapter.
- **Authenticated typed client:** extension and mutation CLI paths use daemon-kit's operation client and reconnect after daemon restarts; legacy REST routes remain compatible.
- **Ports and adapters:** registry and installer ports keep policy independent
  from npm, SQLite, subprocess, HTTP, and UI adapters.
- **Operation-aware authorization:** one policy matrix classifies reads, maintenance, code execution, settings mutation, and security mutation; guarded daemon routes reject missing approval with stable `approval_required` errors.
- **Allowlisted mutation input:** package sources and names reject shell
  metacharacters before reaching the installer.
- **Bounded requests:** daemon calls use timeouts and return structured errors
  without tokens or credentials.

## Development

```bash
bun test
bunx tsc --noEmit
```
