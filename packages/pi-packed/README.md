# pi-packed

Pi integration for `@danypops/packed`: package tools, `/packed`, setup apply/reload, and named profiles.

```bash
pi install npm:@danypops/pi-packed
```

The extension connects to Packed's authenticated user daemon and starts the package-local `packed serve` process when no healthy daemon is available. It contains no SQLite, registry, package execution, or daemon implementation code.

## Commands

- `/packed` -- opens on the packages panel: every installed Pi package, with update availability. Select one to update or remove it; `r` refreshes, `/` filters, `Tab` cycles view modes, `s` opens settings.
- `/packed` settings (`s` from the panel) -- package mutation-approval settings: require confirmation before install/update/remove/security changes (the default), or turn it off.
- `/packed config` -- enable or disable individual extensions, skills, prompt templates, and themes declared by installed packages, per package, at global or project scope.
- `/packed setup plan [path] [--prune]` / `/packed setup apply [path] [--prune]` -- preview or apply a reproducible-environment manifest (`pi-setup.json`) against installed packages and profiles.
- `/profile [name]` -- switch to a named Pi profile (provider, model, tools, instructions, theme), reading `~/.pi/agent/profiles.json` and a trusted project's own `.pi/profiles.json`. `pi --profile <name>` activates one at startup; `Ctrl+Shift+U` cycles through them.
