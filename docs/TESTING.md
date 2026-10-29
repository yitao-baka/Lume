# Testing

This document defines the current verification contract. Commands are the
source of truth; historical coverage narratives and superseded instructions are
not maintained here.

## Commands

Run commands from the repository root unless noted otherwise.

```powershell
pnpm verify:docs       # Markdown links, UTF-8, and test-manifest validation
pnpm verify:fast       # Static checks, frontend units/build, Rust unit tests
pnpm verify:ui         # Fresh debug build when needed + all harness UI suites
pnpm verify:ui:changed # Select harness suites from the current git diff
pnpm verify:release    # Automated release gate + manual checklist reminder
```

Useful focused forms:

```powershell
pnpm verify:ui --suite smoke
pnpm verify:ui --suite settings,plugin-runtime --no-build
pnpm verify:ui --list
pnpm verify:legacy --group plugin-boundary
pnpm verify:legacy --group all --no-build
pnpm verify:legacy --script cdp_plugin_state_verify.mjs
```

Run `pnpm install` only after dependency or lockfile changes. `pnpm run build`
already runs the plugin-contract check. Tauri builds also run `pnpm run build`
through `beforeBuildCommand`; do not run the frontend build immediately before a
Tauri build just to prepare the embedded executable.

## Verification layers

### Static and unit

`pnpm verify:fast` is the normal post-change gate:

- `scripts/check_docs.mjs`
- TypeScript type checking
- three-language i18n key validation
- Page Runtime, clipboard model, clipboard store, and skin-system unit tests
- the production frontend build, including the plugin-contract check
- Rust unit tests

`pnpm verify:release` additionally runs `cargo clippy --all-targets`, all harness
UI suites, the curated legacy release group, and the embedded release build.

### Harness UI

The harness suites in `scripts/test-harness/suites/` exercise the real embedded
debug executable through CDP. The runner stages a private executable,
`languages/`, `res/`, and an empty data/settings/plugins directory under
`test/verify/`. It assigns a free debugging port and a debug-only
`LUME_INSTANCE_ID`, so tests do not stop or attach to the user's running Lume.

Each suite:

- owns one isolated runtime directory and one application process;
- receives fixtures before launch;
- connects to CDP targets without global `taskkill`;
- terminates only its own process tree;
- installs `SIGINT`/`SIGTERM`/process-exit cleanup;
- writes `result.json`, logs, and screenshots under `test/verify/`;
- removes a passing runtime directory unless `--keep-runtime` or
  `KEEP_TEST_RUN=1` is set;
- keeps only the newest 20 run directories so repeated local verification does
  not accumulate copied executables indefinitely.

Suites run serially because Windows focus, clipboard, native windows, and
desktop state are process-global resources. Reuse one application process for
related checks. Start a second process only for a contract that requires a
fresh process, such as first-frame settings injection, restart persistence, or
runtime recovery.

### Legacy regressions

Existing `scripts/cdp_*.mjs` files remain available as targeted regressions
while their coverage is migrated into harness suites. They are not part of the
default UI gate. Use the groups in `scripts/test-manifest.json` for explicit
selection. Legacy scripts may still perform global process cleanup; run them
only when no important Lume session is active.

### Manual verification

Real UAC prompts, service registration, real Explorer drag-and-drop, actual
hotkey delivery, and native window interactions remain manual. Follow
[MANUAL_TESTING.md](MANUAL_TESTING.md) for the release checklist.

## Change-to-verification matrix

| Change | Minimum verification |
| --- | --- |
| Documentation only | `pnpm verify:docs` |
| Shared frontend logic | `pnpm verify:fast`, then the impacted UI suites |
| Launcher shell or keyboard routing | `pnpm verify:fast`, `pnpm verify:ui --suite smoke` |
| Settings or skins | `pnpm verify:fast`, `pnpm verify:ui --suite settings`, then `pnpm verify:legacy --group settings-visual` when visual behavior changed |
| Clipboard model/store | `pnpm verify:fast`, `pnpm verify:ui --suite clipboard-ui` |
| Plugin runtime, permissions, or page model | `pnpm verify:fast`, `pnpm verify:ui --suite plugin-runtime,preview`, then `pnpm verify:legacy --group plugin-boundary` when the boundary changed |
| Elevation agent or automation settings | `pnpm verify:fast`, `pnpm verify:ui --suite agent`; registration and elevated injection stay manual |
| Native window geometry | `pnpm verify:fast`, then `pnpm verify:legacy --group window-native` |
| Release | `pnpm verify:release`, then [MANUAL_TESTING.md](MANUAL_TESTING.md) |

`pnpm verify:ui:changed` maps current changed paths to suites in
`scripts/test-manifest.json`; it falls back to `smoke` when no rule matches.
Review the selected list instead of assuming every change needs every suite.

## Harness suites

| Suite | Contract |
| --- | --- |
| `smoke` | Launcher shell, mode bar, Tab mode switch, clipboard surface, hiding |
| `settings` | Settings navigation, command search, clipboard pane, close path |
| `plugin-runtime` | API 2 keyword entry, Presenter readiness, strict CSP and sandbox |
| `clipboard-ui` | History/empty surface, categories, pause acknowledgement, clear confirmation |
| `preview` | Core preview window, undeclared-plugin denial, declared-plugin reuse |
| `agent` | Elevation-agent switches, fail-closed registration gate, UIPI explanation and status shape |

List the current set with `pnpm verify:ui --list`.

## Legacy groups

| Group | Use |
| --- | --- |
| `plugin-boundary` | Plugin navigation, clipboard, permission, and unload boundaries |
| `settings-visual` | Settings skins, accent contrast, and visual audit regressions |
| `plugin-ui` | Plugin state, LRU, theme, and mode-bar regressions |
| `window-native` | Real HWND placement and window-feature checks |
| `agent` | Elevation-agent UI and non-UAC behavior |
| `release-core` | Curated legacy gate used by `verify:release` |
| `all` | Every tracked `scripts/cdp_*.mjs` file; use deliberately |

## Adding and retiring tests

- Put a new regression into an existing harness suite when it shares lifecycle,
  fixtures, and stable state with that suite.
- Add a new harness suite only when it needs a distinct process lifecycle,
  fixture set, or isolation boundary.
- Keep one-off probes and reproduction scripts under `test/`; do not promote a
  probe into a tracked script unless it has a continuing contract.
- Register every permanent suite in `scripts/test-manifest.json` and document
  it above.
- Merge or retire a legacy script when equivalent harness coverage exists and
  the remaining unique assertions are preserved.
- Record commands, pass counts, and any kept artifact paths in
  `CHANGELOG.md`; put implementation details and pitfalls in
  `docs/ROADMAP_HISTORY.md`.

## Troubleshooting

- A UI run prints the isolated run directory on failure, including the Lume log
  tail. Start there before rerunning.
- `--no-build` is for fast iteration against a known-current executable.
  Omitting it checks source timestamps and rebuilds once when needed.
- `--force-build` rebuilds the embedded debug executable explicitly.
- Legacy scripts must not be parallelized with each other.
- Do not add blanket `taskkill /IM msedgewebview2.exe` cleanup to new tests;
  terminate the owned process tree instead.

## CI

`.github/workflows/verify.yml` runs `pnpm verify:fast` on Windows for pushes,
pull requests, and manual dispatches. `.github/workflows/verify-ui.yml` runs the
desktop harness on a self-hosted Windows runner labeled `lume-ui`; this runner
must provide an interactive desktop session for WebView2 windows.
