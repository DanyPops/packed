# @danypops/packed

Host-neutral Agent Tools composition contracts and persistence primitives shared by host integrations.

## Agent Tools

`@danypops/packed/agent-tools` compiles static package and tool descriptors into a deterministic Agent Tools Lock. The lock records exact package identity, integrity, resources, ownership, permissions, limits, compatibility, and enabled tools. Runtime health, credentials, grants, and host materialization remain host-owned.

## Atomic JSON

```ts
import { writeJsonAtomic } from "@danypops/packed/atomic-json";

await writeJsonAtomic("state.json", { ready: true }, { mode: 0o600 });
```

## Repository policy

`packed-policy` rejects tracked vendor directories, dependency archives, minified bundles, `bundledDependencies`, and multiple locked versions of `@danypops/*` packages. Run it after dependency installation:

```sh
packed-policy
packed-policy --json
```

Exact temporary exceptions belong in `.package-policy.json`. Artifact exceptions name tracked paths. Duplicate-resolution exceptions name every allowed version and lockfile introducer; any drift fails the check.

Pi package lifecycle, profiles, commands, and TUI integration belong to `@danypops/pi-packed`.
