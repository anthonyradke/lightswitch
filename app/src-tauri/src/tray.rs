//! System tray icon: quick profile switching without opening the window.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::state::{self, Shared};

const TRAY_ID: &str = "main";
const PROFILE_PREFIX: &str = "profile:";

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("lightswitch")
        .menu(&build_menu(app)?)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => crate::show_window(app),
            "quit" => app.exit(0),
            id => {
                if let Some(profile) = id.strip_prefix(PROFILE_PREFIX) {
                    state::activate(app, profile);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                crate::show_window(tray.app_handle());
            }
        })
        .build(app)?;
    refresh_tooltip(app);
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let (profiles, active) = {
        let shared = app.state::<Shared>();
        let core = shared.core.lock().unwrap();
        let profiles: Vec<(String, String)> =
            core.config.profiles.iter().map(|p| (p.id.clone(), p.name.clone())).collect();
        (profiles, core.config.active.clone())
    };
    for (id, name) in profiles {
        let item = CheckMenuItem::with_id(app, format!("{PROFILE_PREFIX}{id}"), name, true, id == active, None::<&str>)?;
        menu.append(&item)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "open", "Open lightswitch", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?)?;
    Ok(menu)
}

/// Rebuild the menu after profiles or the active profile change.
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    refresh_tooltip(app);
}

pub fn refresh_tooltip(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let shared = app.state::<Shared>();
    let profile = shared.core.lock().unwrap().config.active_profile().name.clone();
    let status = shared.status.lock().unwrap().clone();
    let mut text = format!("lightswitch · {profile}");
    if status.connected {
        if let Some(dpi) = status.dpi {
            text.push_str(&format!("\n{dpi} DPI"));
        }
        if let Some(b) = status.battery {
            text.push_str(&format!(" · {b}%{}", if status.charging { " ⚡" } else { "" }));
        }
    } else {
        text.push_str("\nMouse not connected");
    }
    let _ = tray.set_tooltip(Some(text));
}
