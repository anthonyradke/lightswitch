"use strict";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const RATES = [125, 250, 500, 1000];
const MAX_STAGES = 5;
const ACTION_TYPES = [
  ["default", "Default"],
  ["disabled", "Disabled"],
  ["keys", "Key combination"],
  ["macro", "Macro"],
  ["dpiShift", "DPI shift (while held)"],
  ["dpiCycle", "Cycle DPI stages"],
  ["nextProfile", "Next profile"],
  ["profile", "Switch to profile"],
];
const MODES = [
  ["once", "Once"],
  ["whileHeld", "While held"],
  ["toggle", "Toggle"],
];
const MOUSE_NAMES = { left: "Left click", right: "Right click", middle: "Middle click", back: "Back button", forward: "Forward button" };

let S = null; // backend state: { config, dpiStage, device, hotkeyErrors, configPath }
let autostart = false;
const view = { page: "profile", profileId: null, macroId: null };
let hotkeyCapture = null; // "profile" | "next" while listening for a hotkey
let keyCapture = null; // { kind: "back" | "forward" | "step" } while the backend captures keys
let recording = null; // { start, timer }
let confirmDelete = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cfg = () => S.config;
const profile = () => cfg().profiles.find((p) => p.id === view.profileId) || cfg().profiles[0];
const currentMacro = () => cfg().macros.find((m) => m.id === view.macroId);
const newId = () => Date.now().toString(16) + Math.random().toString(16).slice(2, 8);
const clampDpi = (v) => Math.round(Math.min(25600, Math.max(100, Number(v) || 800)) / 50) * 50;

const icons = {
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  mouse: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z" fill="currentColor"/></svg>',
  key: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/></svg>',
};

// ---------- persistence ----------

let saveTimer = null;
function save(delay = 250) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const st = await invoke("save_config", { config: cfg() });
    S.dpiStage = st.dpiStage;
    S.hotkeyErrors = st.hotkeyErrors;
    renderErrors();
    renderSidebar();
  }, delay);
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- formatting ----------

function codeLabel(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  const arrows = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };
  return arrows[code] || code;
}

function hotkeyHtml(text) {
  const parts = text.split("+").map((p) => `<kbd>${esc(codeLabel(p))}</kbd>`);
  return `<span class="keys">${parts.join('<span class="plus">+</span>')}</span>`;
}

function keysHtml(keys) {
  return `<span class="keys">${keys.map((k) => `<kbd>${esc(k.name)}</kbd>`).join('<span class="plus">+</span>')}</span>`;
}

function modeLabel(mode) {
  return (MODES.find((m) => m[0] === mode) || MODES[0])[1];
}

// ---------- sidebar ----------

function renderSidebar() {
  const list = cfg().profiles.map((p) => {
    const cls = ["profile-item"];
    if (p.id === cfg().active) cls.push("active");
    if (view.page === "profile" && p.id === view.profileId) cls.push("selected");
    return `<button class="${cls.join(" ")}" data-act="profile-open" data-id="${p.id}">
      <span class="dot"></span>
      <span class="pname">${esc(p.name || "Untitled")}</span>
      <span class="pmeta">${p.dpiStages[p.dpiIndex]}</span>
    </button>`;
  });
  $("#profile-list").innerHTML = list.join("");
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("selected", b.dataset.page === view.page));
}

function renderDevice() {
  const d = S.device;
  let dot = "", title, sub;
  if (d.connected) {
    dot = "on";
    title = d.name || "Mouse";
    sub = [d.dpi && `${d.dpi} DPI`, d.rate && `${d.rate} Hz`].filter(Boolean).join(" · ");
  } else if (d.present) {
    dot = "sleep";
    title = d.name || "Mouse asleep";
    sub = "Asleep — move the mouse to wake it";
  } else {
    title = "Receiver not found";
    sub = "Plug in the receiver and make sure G HUB is closed";
  }
  let battery = "";
  if (d.battery != null) {
    const lvl = d.battery <= 15 ? "low" : d.battery <= 35 ? "mid" : "";
    battery = `<div class="battery"><div class="battery-bar"><div class="battery-fill ${lvl}" style="width:${d.battery}%"></div></div>
      <span>${d.battery}%${d.charging ? " ⚡" : ""}</span></div>`;
  }
  $("#device").innerHTML = `<div class="device-top"><span class="status-dot ${dot}"></span>${esc(title)}</div>
    <div class="device-sub">${esc(sub)}</div>${battery}`;
  // The live DPI badge on stage chips depends on the device.
  document.querySelectorAll(".stage[data-i]").forEach((el) => {
    const p = profile();
    const i = Number(el.dataset.i);
    el.classList.toggle("live", p.id === cfg().active && d.connected && d.dpi === p.dpiStages[i]);
  });
}

function renderErrors() {
  const box = $("#hotkey-errors");
  if (!box) return;
  const errs = S.hotkeyErrors || [];
  box.innerHTML = errs.map((e) => `<div class="error">${esc(e)}</div>`).join("");
}

// ---------- pages ----------

function render() {
  renderSidebar();
  renderDevice();
  const main = $("#main");
  if (view.page === "macros") main.innerHTML = macrosPage();
  else if (view.page === "settings") main.innerHTML = settingsPage();
  else main.innerHTML = profilePage();
  renderDevice();
  renderErrors();
}

function hotkeyField(target, value) {
  const listening = hotkeyCapture === target;
  const inner = listening ? "Press a shortcut… (Esc to cancel)" : value ? hotkeyHtml(value) : "Click to set a shortcut";
  const clear = value && !listening ? `<button class="btn ghost small" data-act="hotkey-clear" data-target="${target}">Clear</button>` : "";
  return `<div class="hotkey-field"><button class="capture ${listening ? "listening" : ""}" data-act="hotkey-set" data-target="${target}">${inner}</button>${clear}</div>`;
}

function profilePage() {
  const p = profile();
  const isActive = p.id === cfg().active;
  const only = cfg().profiles.length === 1;
  const stages = p.dpiStages
    .map(
      (dpi, i) => `<div class="stage ${i === p.dpiIndex ? "default" : ""}" data-act="stage-default" data-i="${i}">
        <span class="stage-num">${i === p.dpiIndex ? "DEFAULT" : `STAGE ${i + 1}`}</span>
        <input type="number" min="100" max="25600" step="50" value="${dpi}" data-field="stage" data-i="${i}" />
        <span class="unit">DPI</span>
        ${p.dpiStages.length > 1 ? `<button class="x" data-act="stage-remove" data-i="${i}" title="Remove">×</button>` : ""}
      </div>`,
    )
    .join("");
  const addStage = p.dpiStages.length < MAX_STAGES ? `<button class="stage add" data-act="stage-add">+ Add stage</button>` : "";
  const deleting = confirmDelete === p.id;

  return `<div class="page">
    <div class="page-head">
      <input class="title-input" value="${esc(p.name)}" data-field="profile-name" spellcheck="false" />
      <div class="head-actions">
        ${isActive ? `<span class="badge">Active</span>` : `<button class="btn primary" data-act="activate">Activate</button>`}
        <button class="btn ghost" data-act="profile-duplicate" title="Duplicate">${icons.copy}Duplicate</button>
        <button class="btn ${deleting ? "confirm" : "ghost danger"}" data-act="profile-delete" ${only ? "disabled" : ""}>
          ${icons.trash}${deleting ? "Click to confirm" : "Delete"}</button>
      </div>
    </div>

    <section class="card">
      <div class="card-head"><div><h3>DPI stages</h3>
        <p class="hint">Click a stage to make it the default for this profile. A side button can cycle through them.</p></div></div>
      <div class="stages">${stages}${addStage}</div>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Polling rate</h3><p class="hint">How often the mouse reports its position.</p></div></div>
      <div class="segmented">${RATES.map((r) => `<button class="${p.reportRate === r ? "on" : ""}" data-act="rate" data-v="${r}">${r} Hz</button>`).join("")}</div>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Side buttons</h3><p class="hint">Left, right and middle click always behave normally.</p></div></div>
      ${bindRow(p, "back", "Back", "Rear side button", "4")}
      ${bindRow(p, "forward", "Forward", "Front side button", "5")}
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Profile shortcut</h3><p class="hint">Switch to this profile from anywhere, even in games.</p></div></div>
      ${hotkeyField("profile", p.hotkey)}
      <div id="hotkey-errors"></div>
    </section>
  </div>`;
}

function bindRow(p, side, name, sub, num) {
  const a = p[side];
  const options = ACTION_TYPES.map(([v, label]) => {
    const text = v === "default" ? `Default (${name})` : label;
    return `<option value="${v}" ${a.type === v ? "selected" : ""}>${text}</option>`;
  }).join("");

  let extra = "";
  switch (a.type) {
    case "keys": {
      const listening = keyCapture && keyCapture.kind === side;
      const inner = listening ? "Press a key combination…" : a.keys.length ? keysHtml(a.keys) : "Click to set keys";
      extra = `<button class="capture ${listening ? "listening" : ""}" data-act="keys-capture" data-side="${side}">${inner}</button>`;
      break;
    }
    case "macro": {
      if (!cfg().macros.length) {
        extra = `<span class="muted">No macros yet. <button class="link" data-act="page" data-page="macros">Create one</button></span>`;
      } else {
        const opts = cfg().macros.map((m) => `<option value="${m.id}" ${a.id === m.id ? "selected" : ""}>${esc(m.name)}</option>`);
        const missing = !cfg().macros.some((m) => m.id === a.id) ? `<option value="" selected>Choose a macro…</option>` : "";
        extra = `<select data-field="bind-macro" data-side="${side}">${missing}${opts.join("")}</select>`;
      }
      break;
    }
    case "dpiShift":
      extra = `<div class="inline"><input class="input num" type="number" min="100" max="25600" step="50" value="${a.dpi}" data-field="bind-dpi" data-side="${side}" /> DPI while held</div>`;
      break;
    case "profile": {
      const opts = cfg().profiles.map((q) => `<option value="${q.id}" ${a.id === q.id ? "selected" : ""}>${esc(q.name)}</option>`);
      extra = `<select data-field="bind-profile" data-side="${side}">${opts.join("")}</select>`;
      break;
    }
    case "dpiCycle":
      extra = `<span class="muted">Steps through this profile's DPI stages.</span>`;
      break;
    case "nextProfile":
      extra = `<span class="muted">Cycles through your profiles in order.</span>`;
      break;
    case "disabled":
      extra = `<span class="muted">The button does nothing.</span>`;
      break;
    default:
      extra = `<span class="muted">Works as ${name.toLowerCase()} in browsers and apps.</span>`;
  }
  return `<div class="bind-row">
    <div><div class="bind-name">${name} <span class="btn-chip">M${num}</span></div><div class="bind-sub">${sub}</div></div>
    <select data-field="bind-type" data-side="${side}">${options}</select>
    <div>${extra}</div>
  </div>`;
}

function macrosPage() {
  const macros = cfg().macros;
  if (!view.macroId && macros.length) view.macroId = macros[0].id;
  const list = macros
    .map(
      (m) => `<button class="macro-item ${m.id === view.macroId ? "selected" : ""}" data-act="macro-open" data-id="${m.id}">
        <span>${esc(m.name || "Untitled")}</span>
        <span class="mmeta">${m.steps.filter((s) => s.type !== "delay").length} actions · ${modeLabel(m.mode)}</span>
      </button>`,
    )
    .join("");
  const m = currentMacro();
  const editor = m
    ? macroEditor(m)
    : `<div class="card empty"><div class="big">No macro selected</div>Create a macro, record it, then bind it to a side button in a profile.</div>`;
  return `<div class="split">
    <div class="card macro-list">
      <div class="list-head"><h3>Macros</h3><button class="icon-btn" data-act="macro-new" title="New macro">+</button></div>
      ${list || `<div class="muted" style="padding:8px 6px">No macros yet.</div>`}
    </div>
    <div class="page" style="margin:0;max-width:none">${editor}</div>
  </div>`;
}

function macroEditor(m) {
  const deleting = confirmDelete === m.id;
  const usedBy = [];
  for (const p of cfg().profiles) {
    for (const [side, label] of [["back", "Back"], ["forward", "Forward"]]) {
      if (p[side].type === "macro" && p[side].id === m.id) usedBy.push(`${p.name} · ${label}`);
    }
  }
  const recBar = recording
    ? `<div class="rec-bar"><span class="rec-dot"></span><span class="rec-time" id="rec-time">0.0s</span>
        <span class="grow">Recording keys and clicks. Clicks inside this window are ignored.</span>
        <button class="btn small" data-act="rec-stop">${icons.stop}Stop</button></div>`
    : "";
  const addKeyListening = keyCapture && keyCapture.kind === "step";

  return `<div class="page-head">
      <input class="title-input" value="${esc(m.name)}" data-field="macro-name" spellcheck="false" />
      <div class="head-actions">
        <button class="btn" data-act="macro-test" ${m.steps.length && !recording ? "" : "disabled"} title="Play once in 2 seconds">${icons.play}Test</button>
        <button class="btn ${deleting ? "confirm" : "ghost danger"}" data-act="macro-delete">${icons.trash}${deleting ? "Click to confirm" : "Delete"}</button>
      </div>
    </div>

    <section class="card">
      <div class="card-head"><div><h3>Playback</h3><p class="hint">${
        m.mode === "once" ? "Plays each time the button is pressed." : m.mode === "whileHeld" ? "Loops for as long as the button is held." : "First press starts looping, second press stops."
      }</p></div></div>
      <div class="row" style="justify-content:flex-start;gap:16px">
        <div class="segmented">${MODES.map(([v, l]) => `<button class="${m.mode === v ? "on" : ""}" data-act="macro-mode" data-v="${v}">${l}</button>`).join("")}</div>
        ${m.mode === "once" ? `<div class="inline">Repeat <input class="input num" type="number" min="1" max="1000" value="${m.repeat}" data-field="macro-repeat" /> times</div>` : ""}
      </div>
      <div class="used-by">${usedBy.length ? usedBy.map((u) => `<span class="chip">${esc(u)}</span>`).join("") : `<span class="muted">Not bound to any button yet.</span>`}</div>
    </section>

    <section class="card">
      <div class="card-head">
        <div><h3>Steps</h3><p class="hint">${m.steps.length ? "Hover a step to reorder or remove it." : "Record your keys and clicks, or add steps by hand."}</p></div>
        ${recording ? "" : `<button class="btn record" data-act="rec-start">${icons.rec}${m.steps.length ? "Re-record" : "Record"}</button>`}
      </div>
      ${recBar}
      <div class="tools">
        <button class="btn small" data-act="step-add-key">${icons.key}${addKeyListening ? "Press a key…" : "Add key press"}</button>
        <button class="btn small" data-act="step-add-delay">${icons.clock}Add delay</button>
        <span class="sep"></span>
        <div class="inline">Set all delays to <input class="input num" type="number" min="0" value="50" id="all-delays" style="height:28px" /> ms
          <button class="btn small" data-act="delays-set">Apply</button></div>
        <button class="btn small ghost" data-act="delays-clear">Remove delays</button>
      </div>
      <div class="steps">${m.steps.map(stepHtml).join("") || `<div class="empty">No steps yet.</div>`}</div>
    </section>`;
}

function stepHtml(s, i) {
  let body;
  if (s.type === "delay") {
    body = `${icons.clock}<span>Wait</span><input class="input num" type="number" min="0" value="${s.ms}" data-field="step-ms" data-i="${i}" /><span>ms</span>`;
  } else if (s.type === "key") {
    body = `<span class="arrow ${s.down ? "down" : "up"}">${s.down ? "↓" : "↑"}</span><kbd>${esc(s.key.name)}</kbd><span class="muted">${s.down ? "press" : "release"}</span>`;
  } else {
    body = `<span class="arrow ${s.down ? "down" : "up"}">${s.down ? "↓" : "↑"}</span>${icons.mouse}<span>${MOUSE_NAMES[s.button]}</span><span class="muted">${s.down ? "press" : "release"}</span>`;
  }
  return `<div class="step ${s.type}">
    <span class="step-idx">${i + 1}</span>
    <span class="step-kind">${body}</span>
    <div class="step-tools">
      <button data-act="step-up" data-i="${i}" title="Move up">${icons.up}</button>
      <button data-act="step-down" data-i="${i}" title="Move down">${icons.down}</button>
      <button class="del" data-act="step-del" data-i="${i}" title="Remove">${icons.x}</button>
    </div>
  </div>`;
}

function settingsPage() {
  const d = S.device;
  return `<div class="page">
    <div class="page-head"><h1 class="page-title">Settings</h1></div>

    <section class="card">
      <div class="row">
        <div><h3>Launch at startup</h3><p class="hint">Start lightswitch in the tray when you sign in to Windows.</p></div>
        <label class="switch"><input type="checkbox" data-field="autostart" ${autostart ? "checked" : ""} /><span></span></label>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Next-profile shortcut</h3><p class="hint">Cycle through all profiles with one shortcut.</p></div></div>
      ${hotkeyField("next", cfg().settings.nextProfileHotkey)}
      <div id="hotkey-errors"></div>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>Device</h3></div></div>
      <dl class="kv">
        <dt>Mouse</dt><dd>${esc(d.name || "—")}</dd>
        <dt>Status</dt><dd>${d.connected ? "Connected" : d.present ? "Asleep" : "Not found"}</dd>
        <dt>Battery</dt><dd>${d.battery != null ? `${d.battery}%${d.charging ? " (charging)" : ""}` : "—"}</dd>
        <dt>Current DPI</dt><dd>${d.dpi ?? "—"}</dd>
        <dt>Polling rate</dt><dd>${d.rate ? `${d.rate} Hz` : "—"}</dd>
      </dl>
    </section>

    <section class="card">
      <div class="card-head"><div><h3>About</h3><p class="hint">Closing this window keeps lightswitch running in the tray. Use Quit from the tray menu to exit. G HUB must stay closed.</p></div></div>
      <dl class="kv"><dt>Config file</dt><dd class="path">${esc(S.configPath)}</dd></dl>
    </section>
  </div>`;
}

// ---------- actions ----------

function defaultAction(type, side) {
  switch (type) {
    case "keys": return { type, keys: [] };
    case "macro": return { type, id: cfg().macros[0]?.id || "" };
    case "dpiShift": return { type, dpi: 400 };
    case "profile": return { type, id: (cfg().profiles.find((q) => q.id !== profile().id) || profile()).id };
    default: return { type };
  }
}

async function activate(id) {
  S = await invoke("activate_profile", { id });
  render();
}

async function captureKeys(kind) {
  if (keyCapture) {
    await invoke("cancel_capture");
    return;
  }
  keyCapture = { kind };
  render();
  const keys = await invoke("capture_keys");
  keyCapture = null;
  if (keys && keys.length) {
    if (kind === "step") {
      const m = currentMacro();
      for (const key of keys) m.steps.push({ type: "key", key, down: true });
      for (const key of [...keys].reverse()) m.steps.push({ type: "key", key, down: false });
    } else {
      profile()[kind] = { type: "keys", keys };
    }
    save(0);
  }
  render();
}

async function startRecording() {
  await invoke("start_recording");
  recording = { start: performance.now() };
  recording.timer = setInterval(() => {
    const el = $("#rec-time");
    if (el) el.textContent = ((performance.now() - recording.start) / 1000).toFixed(1) + "s";
  }, 100);
  render();
}

async function stopRecording() {
  const steps = await invoke("stop_recording");
  clearInterval(recording.timer);
  recording = null;
  const m = currentMacro();
  if (m) {
    m.steps = steps;
    save(0);
    toast(`Recorded ${steps.filter((s) => s.type !== "delay").length} actions`);
  }
  render();
}

function armDelete(id, onConfirm) {
  if (confirmDelete === id) {
    confirmDelete = null;
    onConfirm();
  } else {
    confirmDelete = id;
    setTimeout(() => {
      if (confirmDelete === id) {
        confirmDelete = null;
        render();
      }
    }, 3000);
  }
  render();
}

const handlers = {
  page(el) {
    view.page = el.dataset.page;
    render();
  },
  "profile-open"(el) {
    view.page = "profile";
    view.profileId = el.dataset.id;
    render();
  },
  "profile-new"() {
    const p = { id: newId(), name: `Profile ${cfg().profiles.length + 1}`, dpiStages: [400, 800, 1600], dpiIndex: 1, reportRate: 1000, back: { type: "default" }, forward: { type: "default" }, hotkey: null };
    cfg().profiles.push(p);
    view.page = "profile";
    view.profileId = p.id;
    save(0);
    render();
    const input = $(".title-input");
    input?.focus();
    input?.select();
  },
  "profile-duplicate"() {
    const p = structuredClone(profile());
    p.id = newId();
    p.name = `${p.name} copy`;
    p.hotkey = null;
    cfg().profiles.splice(cfg().profiles.indexOf(profile()) + 1, 0, p);
    view.profileId = p.id;
    save(0);
    render();
  },
  "profile-delete"() {
    const p = profile();
    armDelete(p.id, () => {
      cfg().profiles = cfg().profiles.filter((q) => q.id !== p.id);
      if (cfg().active === p.id) cfg().active = cfg().profiles[0].id;
      view.profileId = cfg().profiles[0].id;
      save(0);
      toast(`Deleted "${p.name}"`);
    });
  },
  activate() {
    activate(profile().id);
  },
  "stage-default"(el, e) {
    if (e.target.closest("input, .x")) return;
    profile().dpiIndex = Number(el.dataset.i);
    save(0);
    render();
  },
  "stage-remove"(el) {
    const p = profile();
    const i = Number(el.dataset.i);
    p.dpiStages.splice(i, 1);
    if (p.dpiIndex >= i && p.dpiIndex > 0) p.dpiIndex--;
    save(0);
    render();
  },
  "stage-add"() {
    const p = profile();
    const last = p.dpiStages[p.dpiStages.length - 1];
    p.dpiStages.push(clampDpi(last * 2));
    save(0);
    render();
    document.querySelector(`.stage input[data-i="${p.dpiStages.length - 1}"]`)?.select();
  },
  rate(el) {
    profile().reportRate = Number(el.dataset.v);
    save(0);
    render();
  },
  "keys-capture"(el) {
    captureKeys(el.dataset.side);
  },
  "hotkey-set"(el) {
    hotkeyCapture = hotkeyCapture === el.dataset.target ? null : el.dataset.target;
    render();
  },
  "hotkey-clear"(el) {
    setHotkey(el.dataset.target, null);
  },
  "macro-new"() {
    const m = { id: newId(), name: `Macro ${cfg().macros.length + 1}`, mode: "once", repeat: 1, steps: [] };
    cfg().macros.push(m);
    view.macroId = m.id;
    save(0);
    render();
    const input = $(".title-input");
    input?.focus();
    input?.select();
  },
  "macro-open"(el) {
    view.macroId = el.dataset.id;
    render();
  },
  "macro-delete"() {
    const m = currentMacro();
    armDelete(m.id, () => {
      cfg().macros = cfg().macros.filter((x) => x.id !== m.id);
      for (const p of cfg().profiles) {
        for (const side of ["back", "forward"]) if (p[side].type === "macro" && p[side].id === m.id) p[side] = { type: "default" };
      }
      view.macroId = cfg().macros[0]?.id || null;
      save(0);
      toast(`Deleted "${m.name}"`);
    });
  },
  "macro-mode"(el) {
    currentMacro().mode = el.dataset.v;
    save(0);
    render();
  },
  "macro-test"(el) {
    // Drop focus so a Space/Enter inside the macro can't re-click this button.
    el.blur();
    // Delay so the user can focus the window the macro should type into.
    const id = currentMacro().id;
    toast("Playing in 2 seconds…");
    setTimeout(() => invoke("test_macro", { id }), 2000);
  },
  "rec-start"() {
    startRecording();
  },
  "rec-stop"() {
    stopRecording();
  },
  "step-add-key"() {
    captureKeys("step");
  },
  "step-add-delay"() {
    currentMacro().steps.push({ type: "delay", ms: 50 });
    save(0);
    render();
  },
  "step-up"(el) {
    moveStep(Number(el.dataset.i), -1);
  },
  "step-down"(el) {
    moveStep(Number(el.dataset.i), 1);
  },
  "step-del"(el) {
    currentMacro().steps.splice(Number(el.dataset.i), 1);
    save(0);
    render();
  },
  "delays-set"() {
    const ms = Math.max(0, Number($("#all-delays").value) || 0);
    const m = currentMacro();
    // Normalise: one delay between every pair of actions.
    const actions = m.steps.filter((s) => s.type !== "delay");
    m.steps = actions.flatMap((s, i) => (i && ms ? [{ type: "delay", ms }, s] : [s]));
    save(0);
    render();
  },
  "delays-clear"() {
    const m = currentMacro();
    m.steps = m.steps.filter((s) => s.type !== "delay");
    save(0);
    render();
  },
};

function moveStep(i, dir) {
  const steps = currentMacro().steps;
  const j = i + dir;
  if (j < 0 || j >= steps.length) return;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  save(0);
  render();
}

function setHotkey(target, value) {
  if (target === "next") cfg().settings.nextProfileHotkey = value;
  else profile().hotkey = value;
  hotkeyCapture = null;
  save(0);
  render();
}

// ---------- events ----------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const fn = handlers[el.dataset.act];
  if (fn) fn(el, e);
});

document.addEventListener("input", (e) => {
  const el = e.target;
  const f = el.dataset.field;
  if (!f) return;
  if (f === "profile-name") {
    profile().name = el.value;
    save();
    renderSidebar();
  } else if (f === "macro-name") {
    currentMacro().name = el.value;
    save();
    const item = document.querySelector(`.macro-item[data-id="${currentMacro().id}"] span`);
    if (item) item.textContent = el.value || "Untitled";
  } else if (f === "step-ms") {
    currentMacro().steps[Number(el.dataset.i)].ms = Math.max(0, Number(el.value) || 0);
    save();
  } else if (f === "macro-repeat") {
    currentMacro().repeat = Math.min(1000, Math.max(1, Number(el.value) || 1));
    save();
  }
});

// Numbers that need clamping are committed on change (blur / Enter), not per keystroke.
document.addEventListener("change", async (e) => {
  const el = e.target;
  const f = el.dataset.field;
  const side = el.dataset.side;
  if (f === "stage") {
    const v = clampDpi(el.value);
    el.value = v;
    profile().dpiStages[Number(el.dataset.i)] = v;
    save(0);
    renderSidebar();
  } else if (f === "bind-type") {
    profile()[side] = defaultAction(el.value, side);
    save(0);
    render();
  } else if (f === "bind-macro" || f === "bind-profile") {
    profile()[side].id = el.value;
    save(0);
  } else if (f === "bind-dpi") {
    const v = clampDpi(el.value);
    el.value = v;
    profile()[side].dpi = v;
    save(0);
  } else if (f === "autostart") {
    try {
      autostart = await invoke("set_autostart", { enabled: el.checked });
      toast(autostart ? "lightswitch will start with Windows" : "Startup disabled");
    } catch (err) {
      toast(`Couldn't change startup: ${err}`);
    }
    el.checked = autostart;
  }
});

// Windows doesn't run the global keyboard hook for keys typed into our own
// window, so forward them to the recorder ourselves while it is listening.
function forwardKey(e, down) {
  if (!keyCapture && !recording) return false;
  e.preventDefault();
  if (!e.repeat) invoke("ui_key", { code: e.code, down });
  return true;
}

document.addEventListener("keyup", (e) => forwardKey(e, false));

document.addEventListener("keydown", (e) => {
  if (forwardKey(e, true)) return;
  if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
  if (!hotkeyCapture) return;
  e.preventDefault();
  if (e.key === "Escape") {
    hotkeyCapture = null;
    render();
    return;
  }
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code) || ["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
  // Some synthetic/remapped keyboards leave `code` empty; fall back to `key`.
  let code = e.code;
  if (!code && /^[a-z]$/i.test(e.key)) code = "Key" + e.key.toUpperCase();
  else if (!code && /^[0-9]$/.test(e.key)) code = "Digit" + e.key;
  if (!code) return;
  setHotkey(hotkeyCapture, [...mods, code].join("+"));
});

// ---------- boot ----------

(async () => {
  S = await invoke("get_state");
  autostart = await invoke("get_autostart");
  view.profileId = cfg().active;
  render();

  await listen("state", (e) => {
    S = e.payload;
    if (!cfg().profiles.some((p) => p.id === view.profileId)) view.profileId = cfg().active;
    // Don't yank focus out of a field the user is typing in.
    if (!document.activeElement?.matches("input")) render();
    else renderSidebar();
  });
  await listen("device", (e) => {
    S.device = e.payload;
    renderDevice();
    if (view.page === "settings" && !document.activeElement?.matches("input")) render();
  });
})();
