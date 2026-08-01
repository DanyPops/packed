# pi-packed

Pi integration for `@danypops/packed`: package tools, `/packed`, setup apply/reload, and named profiles.

```bash
pi install npm:@danypops/pi-packed
```

The extension connects to Packed's authenticated user daemon and starts the package-local `packed serve` process when no healthy daemon is available. It contains no SQLite, registry, package execution, or daemon implementation code.

## Commands

- `/packed` -- one floating overlay, four tabs (Packages/Find/Config/Settings), always shown in a persistent tab bar at the top, each label's own first letter highlighted as its mnemonic. `Tab`/`Shift-Tab` (or `←`/`→`) sweep between them; from any tab other than Packages, `p`/`f`/`c`/`s` also jump straight to the matching one (never stolen while that tab's own filter/query box is capturing text). `Esc` returns to Packages from anywhere else, or closes the panel from Packages itself. Every approval and reload confirmation, on any tab, renders inline on this same panel (`y`/`n` keys), never a separate popup or native dialog. A standing test (`keymap.test.ts`, using Malevich's tree-style `findMnemonicConflicts`) verifies no two actions genuinely reachable at once share a key.
  - **Packages** (the default tab) -- every installed Pi package, with update availability. Mnemonics follow lazy.nvim's own convention (uppercase acts on every row, lowercase on the one under the cursor):
    - `u` / `U` -- update the selected package / update every outdated package, one combined confirmation and one reload. `U` shows a spinner inline next to the package currently updating, settling into a real ✓ or ✗ plus a short tail of that update's own captured output once it finishes -- the list stays visible throughout, nothing swaps to a separate screen. A reload is confirmed separately from the update itself -- decline it to defer: the update already happened, only picking it up in this Pi session is deferred until `/reload`.
    - `x` -- remove the selected package.
    - `d` -- disable (or re-enable) the selected package's own extensions.
    - `c` -- jump to the Config tab, scoped to the selected package.
    - `f` -- jump to the Find tab. `s` -- jump to the Settings tab.
    - `Enter` opens a smaller floating action menu with all of the above. `r` refreshes, `/` filters, `v` cycles view modes.
  - **Find** -- search the npm registry for new Pi packages and install one.
  - **Config** -- enable or disable individual extensions, skills, prompt templates, and themes declared by installed packages, per package, at global or project scope (`v` switches global/project). `/packed config` opens the panel landing directly on this tab.
  - **Settings** -- change whether package mutations (install/update/remove/toggle) require confirmation.
- `/packed setup plan [path] [--prune]` / `/packed setup apply [path] [--prune]` -- preview or apply a reproducible-environment manifest (`pi-setup.json`) against installed packages and profiles.
- `/profile [name]` -- switch to a named Pi profile (provider, model, tools, instructions, theme), reading `~/.pi/agent/profiles.json` and a trusted project's own `.pi/profiles.json`. `pi --profile <name>` activates one at startup; `Ctrl+Shift+U` cycles through them.
