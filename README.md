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
| `packed mirror [--json]` | Refresh the SQLite package index |
| `packed installed [--json]` | Read Pi's installed package declarations |
| `packed catalog [--json]` | Inspect the local package index |
| `packed check [path] [--smoke] [--json]` | Diagnose Pi resources and npm packaging; optionally load extensions in an isolated child |
| `packed pack [path] [--json]` | Inspect exact `npm pack --dry-run --json --ignore-scripts` output and verify shipped Pi resources |
| `packed score [path\|name] [--json]` | Report discoverability, first-run, trust, maintenance, and observational traction evidence |
| `packed publish setup [path] [--force] [--json]` | Generate a least-privilege GitHub OIDC workflow for `npm stage publish` |
| `packed publish status [path] [--json] [--open-browser]` | Validate package, repository, workflow, Node, and npm prerequisites and print trust/approval handoff |
| `packed setup export [path] [--force] [--machine-local] [--json]` | Export immutable npm/git/HTTPS packages and scoped Pi profiles to `pi-setup.json` |
| `packed setup update [manifest] [--json]` | Deliberately refresh package versions, commits, and integrity |
| `packed setup plan [manifest] [--prune] [--json]` | Validate and show an additive or exact setup diff without mutation |
| `packed setup apply [manifest] [--prune] [--approve] [--json]` | Apply locked packages/profiles; optionally remove undeclared state last |
| `packed install <source> [--approve] [--json]` | Authenticated daemon install for `npm:`, `git:`, or `https://` sources |
| `packed install-service <source> --approve [--json]` | Registers an installed npm package's own daemon as a persistent login/boot service, via its `packed.daemonService` manifest |
| `packed remove <name> [--approve] [--json]` | Authenticated daemon removal by bare npm name |
| `packed security [always\|never] [--approve] [--json]` | Read or set the package mutation approval policy |
| `packed serve` | Run the loopback daemon |
| `packed service` | Print the systemd user unit |
| `packed version` | Print the package/service version |

### Persistent daemon services

Every daemon-backed pi package already auto-spawns its own daemon lazily on first use (see each package's own `connectWithPolicy`/`ensure*Client` wiring) -- no install step is required for basic function. Surviving a reboot, however, has always meant separately discovering and running that package's own `<bin> service install` command by hand (`web-spider service install`, `papyrus service install`, `packed service` + manual `systemctl`).

`packed install-service <source>` closes that gap for any package that opts in. A package declares its daemon entry point once, in its own `package.json`:

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

`packed install-service` reads that manifest from the already-installed npm package and calls daemon-kit's `installUserService()` -- the exact same systemd `--user` / launchd / Windows Run-key mechanism that package's own `service install` command would use, so the two are fully interchangeable. `binPath` is required; `name`/`displayName` default to the package's own (unscoped) npm name. git:/local sources aren't supported yet -- only `npm:`. Classified as a `code-execution` mutation, same tier as `install`/`update`, so it requires `--approve` under the secure default like everything else that runs code or touches system state.

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

`packed setup` is the reproducible-environment surface. Version 1 records exact npm versions and integrity, immutable git/HTTPS commits, explicitly machine-local paths, package scope, and global/project profiles. Export and plan never execute package code. `setup update` is the only resolution-refresh path. Apply requires package-operation approval, installs desired packages before atomic profile writes, and preserves undeclared state unless `--prune` is explicitly approved; prune removes profiles and packages last. The schema ships at `schema/pi-setup-v1.schema.json`; mutable git refs, portable local paths, credentials, unknown fields/versions, secret-like profile instructions, unsafe paths, and oversized inputs fail before mutation.

`packed publish setup` supports existing npm packages only. It pins GitHub actions, grants only `contents: read` and `id-token: write`, installs npm 11.15.0, runs the package's build/check/typecheck/test scripts plus `packed check`, and stages with `npm stage publish --provenance --ignore-scripts`. It never receives an npm token and never calls `npm publish`. Configure trust with the printed `npm trust github ... --allow-stage-publish` command or npm package access page, then inspect and approve the staged package with 2FA. Publishing is intentionally CLI/CI-only and is not registered as an agent tool.

On a real interactive terminal (never in `--json`/scripted/non-TTY contexts), `packed publish status` also offers to run `npm login --auth-type=web` when not logged in, and to walk you to npm's own Trusted Publisher page when trust isn't verified yet -- both only after you say yes. Headless by default: it prints the URL and waits for Enter rather than launching a browser (matching npm's own `--no-browser` config), so it's safe to run unattended or inside another tool. Pass `--open-browser` to have it launch a browser for you instead.

Running `packed publish setup <path>` inside a Bun/npm workspace (a package.json declaring `workspaces` above the target package) writes one workflow per package, named after that package (`<name>-stage-publish.yml`), triggered only by that package's own `<name>-v*` tag so two sibling packages can never race on one trigger. A package that depends on another workspace package gets a mechanical core-first ordering guard: before it can stage, the workflow reads its already-installed dependency's resolved version and fails the job if npm doesn't already carry a compatible published release. `packed publish status` mirrors that same check locally (`coreFirst` in its report) so a stale ordering shows up before a tag is ever pushed.

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
