//! Background thread that owns the HID++ connection.
//!
//! The mouse sleeps when idle and may reset its DPI to the onboard profile on
//! power-up, so the worker re-applies the desired settings whenever it
//! reconnects, wakes, or notices the DPI has drifted.

use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use hidpp::{feature, Error, Mouse};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::Shared;

pub enum Cmd {
    /// Settings of the active profile (also clears any temporary DPI).
    Apply { dpi: u16, rate: u16 },
    /// Temporary DPI override (DPI shift button); `None` restores.
    TempDpi(Option<u16>),
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Receiver/cable interface found.
    pub present: bool,
    /// Mouse is awake and answering.
    pub connected: bool,
    pub name: Option<String>,
    pub battery: Option<u8>,
    pub charging: bool,
    pub dpi: Option<u16>,
    pub rate: Option<u16>,
    pub error: Option<String>,
}

const OPEN_RETRY: Duration = Duration::from_secs(2);
const POLL_EVERY: Duration = Duration::from_secs(5);
const BATTERY_EVERY: Duration = Duration::from_secs(60);
const APPLY_RETRY: Duration = Duration::from_secs(2);
/// How long we block on HID reads before checking for new commands.
const EVENT_WAIT_MS: i32 = 30;

pub fn spawn(app: AppHandle, rx: Receiver<Cmd>) {
    std::thread::Builder::new()
        .name("device".into())
        .spawn(move || Worker::new(app, rx).run())
        .expect("spawn device thread");
}

struct Worker {
    app: AppHandle,
    rx: Receiver<Cmd>,
    mouse: Option<Mouse>,
    wireless_index: Option<u8>,
    desired: Option<(u16, u16)>,
    temp_dpi: Option<u16>,
    applied: bool,
    rate_applied: bool,
    next_open: Instant,
    next_apply: Instant,
    next_poll: Instant,
    next_battery: Instant,
    status: Status,
}

impl Worker {
    fn new(app: AppHandle, rx: Receiver<Cmd>) -> Self {
        let now = Instant::now();
        Self {
            app,
            rx,
            mouse: None,
            wireless_index: None,
            desired: None,
            temp_dpi: None,
            applied: false,
            rate_applied: false,
            next_open: now,
            next_apply: now,
            next_poll: now,
            next_battery: now,
            status: Status::default(),
        }
    }

    fn run(mut self) {
        loop {
            let prev = self.status.clone();
            if !self.drain_commands() {
                return;
            }
            if self.mouse.is_none() {
                self.try_open();
            }
            if self.mouse.is_some() {
                self.service();
            } else {
                // Nothing to talk to: sleep until the next open attempt or a command.
                let wait = self.next_open.saturating_duration_since(Instant::now());
                match self.rx.recv_timeout(wait) {
                    Ok(cmd) => self.handle(cmd),
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            if self.status != prev {
                self.publish();
            }
        }
    }

    fn drain_commands(&mut self) -> bool {
        loop {
            match self.rx.try_recv() {
                Ok(cmd) => self.handle(cmd),
                Err(TryRecvError::Empty) => return true,
                Err(TryRecvError::Disconnected) => return false,
            }
        }
    }

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Apply { dpi, rate } => {
                if self.desired.map(|d| d.1) != Some(rate) {
                    self.rate_applied = false;
                }
                self.desired = Some((dpi, rate));
                self.temp_dpi = None;
            }
            Cmd::TempDpi(dpi) => self.temp_dpi = dpi,
        }
        self.applied = false;
        self.next_apply = Instant::now();
    }

    fn try_open(&mut self) {
        if Instant::now() < self.next_open {
            return;
        }
        match Mouse::open() {
            Ok(mut m) => {
                self.wireless_index = m.feature_index(feature::WIRELESS_STATUS).ok();
                self.status.name = m.name().ok();
                self.status.present = true;
                self.status.connected = true;
                self.status.error = None;
                self.mouse = Some(m);
                self.on_wake();
            }
            Err(e) => {
                self.status.present = !matches!(e, Error::NoInterface);
                self.status.connected = false;
                self.status.error = Some(e.to_string());
                self.next_open = Instant::now() + OPEN_RETRY;
            }
        }
    }

    fn on_wake(&mut self) {
        let now = Instant::now();
        self.applied = false;
        self.rate_applied = false;
        self.next_apply = now;
        self.next_battery = now;
        self.next_poll = now + POLL_EVERY;
    }

    fn service(&mut self) {
        let now = Instant::now();
        if !self.applied && now >= self.next_apply {
            self.apply();
        }
        if Instant::now() >= self.next_poll {
            self.poll();
        }
        if Instant::now() >= self.next_battery {
            self.read_battery();
        }
        self.wait_for_event();
    }

    fn target_dpi(&self) -> Option<u16> {
        self.temp_dpi.or(self.desired.map(|d| d.0))
    }

    fn apply(&mut self) {
        let Some((_, rate)) = self.desired else { return };
        let target = self.target_dpi().unwrap_or(800);
        let rate_applied = self.rate_applied;
        let result = self.with_mouse(|m| {
            m.ensure_host_mode()?;
            let dpi = m.set_dpi(target)?;
            if !rate_applied && m.report_rate()? != rate {
                m.set_report_rate(rate)?;
            }
            Ok((dpi, m.report_rate()?))
        });
        match result {
            Some((dpi, hz)) => {
                self.applied = true;
                self.rate_applied = true;
                self.status.dpi = Some(dpi);
                self.status.rate = Some(hz);
            }
            None => self.next_apply = Instant::now() + APPLY_RETRY,
        }
    }

    fn poll(&mut self) {
        self.next_poll = Instant::now() + POLL_EVERY;
        if let Some(dpi) = self.with_mouse(|m| m.dpi()) {
            let was_asleep = !self.status.connected;
            self.status.dpi = Some(dpi);
            if was_asleep || self.target_dpi().is_some_and(|t| t != dpi) {
                self.on_wake();
            }
        }
    }

    fn read_battery(&mut self) {
        self.next_battery = Instant::now() + BATTERY_EVERY;
        if let Some((pct, charging)) = self.with_mouse(|m| m.battery()) {
            self.status.battery = Some(pct);
            self.status.charging = charging;
        }
    }

    fn wait_for_event(&mut self) {
        let Some(m) = self.mouse.as_mut() else { return };
        match m.read_event(EVENT_WAIT_MS) {
            // The wireless status feature announces the mouse (re)connecting.
            Ok(Some((index, _, _))) if Some(index) == self.wireless_index => {
                self.status.connected = true;
                self.on_wake();
            }
            Ok(_) => {}
            Err(_) => self.drop_mouse(),
        }
    }

    /// Run a request, tracking sleep (timeouts) and unplugging (HID errors).
    fn with_mouse<T>(&mut self, f: impl FnOnce(&mut Mouse) -> hidpp::Result<T>) -> Option<T> {
        let m = self.mouse.as_mut()?;
        match f(m) {
            Ok(v) => {
                self.status.connected = true;
                self.status.error = None;
                Some(v)
            }
            Err(Error::Hid(e)) => {
                self.status.error = Some(e.to_string());
                self.drop_mouse();
                None
            }
            Err(e) => {
                // Timeouts and HID++ errors: the mouse is asleep or out of range.
                self.status.connected = false;
                self.status.error = Some(e.to_string());
                None
            }
        }
    }

    fn drop_mouse(&mut self) {
        self.mouse = None;
        self.status.connected = false;
        self.status.present = false;
        self.next_open = Instant::now() + OPEN_RETRY;
    }

    fn publish(&self) {
        let shared = self.app.state::<Shared>();
        *shared.status.lock().unwrap() = self.status.clone();
        let _ = self.app.emit("device", &self.status);
        crate::tray::refresh_tooltip(&self.app);
    }
}
