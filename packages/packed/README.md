# Packed

Standalone package lifecycle service for Pi package authors and consumers.

## CLI

```bash
packed search <query>
packed check [path]
packed pack [path]
packed score [path|name]
packed setup export [path]
packed setup plan [manifest]
packed setup apply [manifest] --approve
packed publish setup [path]
packed publish status [path]
packed serve
packed version [--json]
```

`packed version` also reports the reachable daemon's own live version against the currently installed one -- a supervised or auto-spawned daemon process can outlive the code it started with (`pi update`/a fresh checkout moves on, the daemon process doesn't restart itself), silently serving stale logic for as long as it stays reachable. A mismatch is flagged as `STALE` with a concrete restart suggestion.

Packed owns the authenticated daemon, local catalog, package validation, immutable setup manifests, and release diagnostics. It does not register Pi extensions. Install `@danypops/pi-packed` for Pi commands, tools, profiles, and TUI integration.

An npm-sourced install is staged and headlessly load-checked (via `@danypops/pi-extension-harness`, in an isolated subprocess) before it's committed -- a package whose extension throws during registration is refused rather than installed.
