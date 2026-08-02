# Packed

Packed separates host-neutral package composition from host integration.

- `packages/packed` — `@danypops/packed`, host-neutral contracts and persistence primitives.
- `packages/pi-packed` — `@danypops/pi-packed`, the Pi package daemon, CLI, validation, setup, tools, profiles, and TUI.

The workspace root is private and is never published.

## Development

```bash
bun run build
bun run lint:ci
bun run test
bun run typecheck
```
