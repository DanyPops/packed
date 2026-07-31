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
```

Packed owns the authenticated daemon, local catalog, package validation, immutable setup manifests, and release diagnostics. It does not register Pi extensions. Install `@danypops/pi-packed` for Pi commands, tools, profiles, and TUI integration.

An npm-sourced install is staged and headlessly load-checked (via `@danypops/pi-extension-harness`, in an isolated subprocess) before it's committed -- a package whose extension throws during registration is refused rather than installed.
