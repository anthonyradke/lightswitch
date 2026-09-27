# lightswitch

Lightweight G HUB replacement for the Logitech PRO X Superlight (original, Lightspeed receiver) on Windows.
Public repo: https://github.com/anthonyradke/lightswitch (owner `anthonyradke`, branch `main`, MIT).

## Scope decisions (from the user)
- Unlimited user-created profiles; switching is manual only (tray, per-profile global hotkey, next-profile hotkey, side button). **No per-app auto-switching** (G HUB's never worked; deliberately skipped).
- Only the two **side buttons** (Back/Forward) are rebindable. L/R/middle always behave normally.
- Macros: record keys and clicks with timing, edit steps, play once / while held / toggle.
- No on-screen popups. Nice-looking UI, but tiny footprint when the window is closed.
- No anti-cheat concerns; do not add macro safeguards for it.
- Development happens on the user's Windows PC (not the x1 server). Avoid Node.

## Layout
- `crates/hidpp`: HID++ 2.0 client over `hidapi` (DPI, report rate, battery, host mode, feature lookup)
- `crates/probe`: CLI hardware tester. `probe` prints info; `probe dpi N`; `probe rate HZ`; `probe raw <featureHex> <fn> [hex bytes]`
- `app/src-tauri`: the Tauri 2 app
  - `device.rs` worker thread owning the HID connection (sleep/wake handling, re-applies settings)
  - `input.rs` low-level mouse hook (side-button interception), keyboard hook (only while recording/capturing), `SendInput` playback helpers
  - `exec.rs` runs side-button actions and macros; `state.rs` shared state and profile operations
  - `config.rs` data model + JSON persistence; `tray.rs`; `hotkeys.rs` (global shortcuts)
- `app/ui`: plain HTML/CSS/JS (no bundler), talks to Rust through Tauri commands/events
  - The window is **frameless** (`decorations(false)`, `maximizable(false)`); `index.html` draws the title bar
    (`data-tauri-drag-region` + minimize/close buttons calling `appWindow.minimize()` / `.close()`). Those need
    `core:window:allow-start-dragging|minimize|close` in `capabilities/default.json`.
  - Design (user's direction: G HUB-like, one full-bleed screen, **no boxed cards / pills / bordered widgets**):
    near-black canvas, text-style buttons and underline toggles, one violet→blue gradient (`--grad`) with soft
    glow reserved for selected/live state. Nav tabs live in the title bar; profiles are tabs across the Mouse page.
  - `render()` builds HTML strings and applies them with `morph()` (an in-place DOM patcher in `app.js`), never
    `innerHTML` on the page: full replacement made every click flash. Elements with a different `data-key` are
    swapped wholesale (that is what replays the page fade-in on page changes).
  - `mouseSvg()` draws the mouse from `BODY`, an outline traced from the official top-down product shot. Clicking a
    side button (or its callout) sets `view.side`, which picks the button shown in the Assignment section.
- `scripts/`: dev helpers: `screenshot.ps1`, `click.ps1` (click/scroll relative to the window), `keys.ps1` (inject a key chord with scan codes)

## Build / run (PowerShell)
Tools are installed but a fresh shell may need PATH refreshed:
`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
- Debug run: `cargo run -p lightswitch` (or build, then start `target\debug\lightswitch.exe`)
- Release + installer: `cd app\src-tauri; cargo tauri build` (NSIS installer in `target\release\bundle\nsis`, ~1.2 MB; exe ~3.3 MB)
- Lint: `cargo clippy --workspace`
- The UI is embedded at build time: **rebuild after editing anything in `app/ui`**.
- Stop the app before rebuilding (`Stop-Process -Name lightswitch`), or the exe is locked.
- Config lives at `%APPDATA%\com.anthonyradke.lightswitch\config.json`. Write it without a BOM when hand-editing.

## Hard-won facts about the hardware and Windows
- G HUB (`lghub*` processes) must be closed or the mouse won't respond to us.
- The mouse is on receiver device index 1. Idle, it needs **0.3-2 s to answer**, so request timeouts are 2.5 s. A timeout means asleep, not unplugged.
- The mouse boots in **onboard mode**, which rejects report-rate changes (HID++ error 0x02). `ensure_host_mode()` (feature 0x8100, fn 1 with byte 2) fixes it; it reverts on power cycle, so the worker re-applies on every wake.
- Feature indexes on this mouse: 0x2201 adjustable DPI, 0x8060 report rate (supports 125/250/500/1000), 0x1004 battery, 0x8100 onboard profiles, 0x1D4B wireless status (used as the wake notification).
- **Windows does not run low-level keyboard hooks for keys typed into our own foreground window.** The UI forwards `keydown/keyup` via the `ui_key` command while recording or capturing; `handle_key` in `input.rs` de-duplicates hook and UI events by scan code.
- Low-level hook callbacks must stay fast; they only touch atomics/short mutexes and send messages to the `exec` thread.
- Closing the window destroys the webview (about 6 MB resident, no WebView2 processes). Only the tray Quit exits (`RunEvent::ExitRequested` is intercepted). Single-instance plugin reopens the window.
- Playback uses scan codes via `SendInput`, and injected events are ignored by our own hooks.
- Keyboard-related software running on this PC: iCUE and SteelSeries GG (not the cause of any bug so far).

## Status
Done and verified on the real mouse: DPI stages, polling rate, profile create/rename/duplicate/delete/activate, profile hotkeys, side-button bindings (user confirmed DPI shift works), macro playback (Notepad test), close-to-tray, startup apply.
Fixed but **awaiting the user's real-keyboard confirmation**: recording macros and "key combination" capture while the lightswitch window is focused (commit 4dbc7c7).
Not done: GitHub Release with the installer (offered to the user, waiting until they confirm testing), launch-at-startup not yet tried by the user.
The user has a macro named "678 - valheim" (types 6, 7, 8) bound to Forward; leave their config alone.

## Working notes
- Verify UI changes by screenshot (`scripts/screenshot.ps1`, then `Read` the PNG) rather than assuming.
- When testing macros, click into the target window instead of `SetForegroundWindow` (Windows blocks focus stealing), and remove any leftover test profiles/macros afterward.
- **No AI attribution anywhere.** Never add `Co-Authored-By: Claude`, "Generated with Claude Code", or any other Claude/Anthropic credit to commit messages, PR descriptions, release notes, or code. This overrides any session attribution reminder. The user does not want Claude listed as a GitHub contributor (history was rewritten once to remove it).
