# @danypops/packed

Host-neutral contracts and persistence primitives shared by Packed host integrations.

## Atomic JSON

```ts
import { writeJsonAtomic } from "@danypops/packed/atomic-json";

await writeJsonAtomic("state.json", { ready: true }, { mode: 0o600 });
```

Pi package lifecycle, profiles, commands, and TUI integration belong to `@danypops/pi-packed`.
