# lightswitch

A small, fast replacement for Logitech G HUB, built for the **PRO X Superlight** on Windows.

- **Unlimited profiles**: DPI stages, polling rate and side-button bindings per profile
- **Instant switching** from the tray menu, a global shortcut per profile, a "next profile" shortcut, or a side button
- **Macros**: record keys and clicks with their timing, edit the steps, and play them once, while held, or as a toggle
- **Side buttons** can be a key combination, a macro, a DPI shift (sniper), DPI cycling, or a profile switch
- **Tiny footprint**: about 6 MB of memory when the window is closed; the UI is only loaded while it's open

> **G HUB must be fully closed** (quit it from the tray, or uninstall it). Both apps talk to the mouse over the same channel.

## Install

Download `lightswitch_x.y.z_x64-setup.exe` from [Releases](https://github.com/anthonyradke/lightswitch/releases) and run it.
Closing the window keeps lightswitch running in the tray. Use **Quit** from the tray menu to exit.

## How it works

- The mouse is controlled over Logitech's HID++ 2.0 protocol through the Lightspeed receiver (`crates/hidpp`).
  lightswitch puts the mouse in *host mode* so it can change the polling rate, and re-applies your settings
  whenever the mouse wakes or reconnects.
- Side buttons and macro recording use Windows low-level input hooks. Playback uses `SendInput` with scan codes,
  so it works in games that ignore virtual-key input.
- Profiles live in `%APPDATA%\com.anthonyradke.lightswitch\config.json`.

## Build from source

Requires Rust (MSVC toolchain) and the Tauri CLI (`cargo install tauri-cli`).

```
cargo run -p lightswitch            # run the app (debug)
cd app/src-tauri && cargo tauri build   # release exe + installer in target/release/bundle
cargo run -p probe                  # hardware test: print device info
cargo run -p probe -- dpi 800       # set DPI directly
```

## Layout

- `crates/hidpp`: HID++ 2.0 client (DPI, report rate, battery, host mode)
- `crates/probe`: command-line hardware test tool
- `app/src-tauri`: the app (device worker, input hooks, macro player, tray, hotkeys)
- `app/ui`: the settings window (plain HTML/CSS/JS, no build step)
- `scripts`: dev helpers for screenshots and synthetic input
