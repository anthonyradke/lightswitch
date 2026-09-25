# lightswitch

A lightweight, fast replacement for Logitech G HUB, built for the **PRO X Superlight**.

Goals:
- Unlimited user-created profiles (DPI stages, polling rate, side-button bindings, macros)
- Quick manual profile switching (tray menu, global hotkeys)
- Macro recording and playback, bound to the mouse side buttons
- A clean UI (Tauri) that is fully unloaded when closed, leaving a tiny tray process

> G HUB must be fully closed while lightswitch is running. Both talk to the mouse over the same HID++ channel.

## Status

- [x] Milestone 1: HID++ 2.0 probe (device name, battery, DPI get/set, report rate, feature list)
- [ ] Milestone 2: profiles, tray, hotkey switching
- [ ] Milestone 3: macro recording/playback, side-button remapping
- [ ] Milestone 4: Tauri UI
- [ ] Milestone 5: autostart, releases

## Layout

- `crates/hidpp` - HID++ 2.0 protocol client (via `hidapi`)
- `crates/probe` - hardware test CLI

## Try it

```
cargo run -p probe            # print device info
cargo run -p probe -- dpi 800 # set DPI
```
