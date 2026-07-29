# pi-packed

Pi integration for `@danypops/packed`: package tools, `/packages`, `/packed`, setup apply/reload, and named profiles.

```bash
pi install npm:@danypops/pi-packed
```

The extension connects to Packed's authenticated user daemon and starts the package-local `packed serve` process when no healthy daemon is available. It contains no SQLite, registry, package execution, or daemon implementation code.

## Installing the rest of the @danypops ecosystem

Once Packed is in, install everything else in one reviewable step -- no shell installer, no separate download, no per-package hunting for install commands:

```bash
packed setup plan --ecosystem       # preview what would change, no mutation
packed setup apply --ecosystem --approve
```

`--ecosystem` resolves to a curated manifest bundled inside this same npm package (`node_modules/@danypops/pi-packed/node_modules/@danypops/packed/setup/danypops-ecosystem.pi-setup.json`) -- every entry is a real, pinned, integrity-checked npm version, the same schema and approval gate every other `packed setup` manifest goes through. Nothing is fetched from the network to decide what to install; only the already-installed npm package is trusted.
