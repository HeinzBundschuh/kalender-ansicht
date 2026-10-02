"use strict";

const api = browser.calendarView;
const $ = (id) => document.getElementById(id);
let state = null;
let events = [];
let cur = new Date();
cur = new Date(cur.getFullYear(), cur.getMonth(), 1);

// ---------- Helfer ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").classList.toggle("error", isError);
}

// Einfacher Dialog: dialog(titel, text, [{label, value, cls}]) -> Promise<value|null>
function dialog(title, text, buttons) {
  return new Promise((resolve) => {
    $("dlgTitle").textContent = title;
    $("dlgText").textContent = text;
    const box = $("dlgButtons");
    box.textContent = "";
    const close = (v) => { $("dialog").hidden = true; resolve(v); };
    for (const b of buttons) {
      box.append(h("button", { class: b.cls || "", onclick: () => close(b.value) }, b.label));
    }
    box.append(h("button", { onclick: () => close(null) }, t("Abbrechen")));
    $("dialog").hidden = false;
    box.firstChild.focus();
  });
}

const MONTHS = IS_DE
  ? ["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]
  : [...Array(12)].map((_, i) => new Date(2000, i, 1).toLocaleString(LOCALE, { month: "long" }));
const fDay = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "2-digit", month: "2-digit" });
const fTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });

function dayToDate(day) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function evStart(ev) {
  if (!ev.start) return 0;
  return ev.start.allDay ? dayToDate(ev.start.day).getTime() : ev.start.ms;
}
function fmtEv(ev) {
  const s = ev.start, e = ev.end;
  if (!s) return "";
  if (s.allDay) {
    const sd = dayToDate(s.day);
    if (e && e.allDay) {
      const ed = dayToDate(e.day);
      ed.setDate(ed.getDate() - 1); // Ende ist exklusiv
      if (ed > sd) return `${fDay.format(sd)} – ${fDay.format(ed)}`;
    }
    return `${fDay.format(sd)} · ${t("ganztägig")}`;
  }
  const sd = new Date(s.ms);
  if (!e) return `${fDay.format(sd)} ${fTime.format(sd)}`;
  const ed = new Date(e.ms);
  return sd.toDateString() === ed.toDateString()
    ? `${fDay.format(sd)} ${fTime.format(sd)}–${fTime.format(ed)}`
    : `${fDay.format(sd)} ${fTime.format(sd)} – ${fDay.format(ed)}`;
}

// "20261001T090000Z" / "20261001" -> lesbar
function fmtWhen(ical) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(ical || "");
  if (!m) return "";
  const [, y, mo, d, hh, mi, , z] = m;
  if (!hh) return new Date(+y, mo - 1, +d).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
  const date = z ? new Date(Date.UTC(+y, mo - 1, +d, +hh, +mi)) : new Date(+y, mo - 1, +d, +hh, +mi);
  return date.toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ---------- Regeln ----------
const ruleKey = (mode, id, rid) => `${mode}|${id}|${rid || ""}`;

function hiddenRulesFor(ev) {
  return state.rules.filter((r) => r.mode === "hidden" && r.id === ev.id && (!r.rid || r.rid === ev.rid));
}
function isHidden(ev) {
  return hiddenRulesFor(ev).length > 0;
}
function hasCompactRule(ev) {
  return state.rules.some((r) => r.mode === "compact" && r.id === ev.id);
}
function isCompact(ev) {
  return hasCompactRule(ev) || (state.compactAllSeries && !!ev.rid);
}

function addRule(mode, ev, single) {
  const rid = single ? ev.rid : null;
  const key = ruleKey(mode, ev.id, rid);
  if (state.rules.some((r) => r.key === key)) return;
  state.rules.push({
    key, mode, id: ev.id, rid,
    title: ev.title, calendarName: ev.calendarName, recurring: ev.recurring, when: ev.when,
  });
  if (mode === "hidden") state.hideEnabled = true;
  if (mode === "compact") state.compactEnabled = true;
}

async function save() {
  state = await api.setState(state);
  renderAll();
}

// ---------- Aktionen je Termin (wie im Endless Calendar: 🙈 📤 🗑) ----------
async function toggleHide(ev) {
  if (isHidden(ev)) {
    const keys = new Set(hiddenRulesFor(ev).map((r) => r.key));
    state.rules = state.rules.filter((r) => !keys.has(r.key));
    return save();
  }
  if (ev.recurring && ev.rid) {
    const choice = await dialog(t("„{0}“ ausblenden", ev.title), t("Das ist ein Serientermin. Was soll ausgeblendet werden?"), [
      { label: t("Ganze Serie"), value: "series" },
      { label: t("Nur dieses Vorkommen"), value: "one" },
    ]);
    if (!choice) return;
    addRule("hidden", ev, choice === "one");
  } else {
    addRule("hidden", ev, false);
  }
  return save();
}

function toggleCompact(ev) {
  if (hasCompactRule(ev)) {
    state.rules = state.rules.filter((r) => !(r.mode === "compact" && r.id === ev.id));
  } else {
    addRule("compact", ev, false);
  }
  return save();
}

async function exportEv(ev) {
  try {
    const path = await api.exportEvents([{ calendarId: ev.calendarId, id: ev.id }]);
    setStatus("📤 " + t(ev.recurring ? "„{0}“ exportiert (ganze Serie):" : "„{0}“ exportiert:", ev.title) + "\n" + path);
  } catch (e) {
    setStatus(t("Export fehlgeschlagen: {0}", e.message || e), true);
  }
}

async function deleteEv(ev) {
  let scope;
  if (ev.recurring && ev.rid) {
    scope = await dialog(t("„{0}“ löschen", ev.title), t("Serientermin am {0}.", fmtEv(ev)) + "\n" + t("Vorher wird ein ICS-Backup im Download-Ordner gespeichert."), [
      { label: t("Nur dieses Vorkommen"), value: "occurrence", cls: "danger" },
      { label: t("Ganze Serie"), value: "series", cls: "danger" },
    ]);
  } else {
    scope = await dialog(t("„{0}“ löschen", ev.title), `${fmtEv(ev)} · ${ev.calendarName}\n` + t("Vorher wird ein ICS-Backup im Download-Ordner gespeichert."), [
      { label: t("Löschen"), value: "series", cls: "danger" },
    ]);
  }
  if (!scope) return;
  try {
    const res = await api.deleteEvents([ev], scope);
    let text = res.deleted ? "🗑 " + t(scope === "occurrence" ? "„{0}“ gelöscht (nur dieses Vorkommen)." : "„{0}“ gelöscht.", ev.title) : t("Nichts gelöscht.");
    if (res.backupPath) text += "\n" + t("Backup: {0}", res.backupPath);
    if (res.errors.length) text += "\n" + res.errors.join("\n");
    await loadMonth();
    setStatus(text, res.errors.length > 0);
  } catch (e) {
    setStatus(t("Löschen fehlgeschlagen: {0}", e.message || e), true);
  }
}

// ---------- Anzeige ----------
function renderEvents() {
  $("monthTitle").textContent = `${MONTHS[cur.getMonth()]} ${cur.getFullYear()}`;
  const list = $("eventList");
  list.textContent = "";
  const showOff = $("showOff").checked;
  const rows = events.filter((ev) => showOff || !isHidden(ev));
  if (!rows.length) {
    list.append(h("div", { class: "empty" }, events.length ? t("Alle Termine dieses Monats sind ausgeblendet.") : t("Keine Termine in diesem Monat.")));
    return;
  }
  for (const ev of rows) {
    const hidden = isHidden(ev);
    const compact = isCompact(ev);
    const notes = [ev.calendarName];
    if (ev.recurring) notes.push("🔁 " + t("Serie"));
    if (ev.location) notes.push(ev.location);
    if (hidden) notes.push(hiddenRulesFor(ev).some((r) => r.rid) ? t("ausgeblendet (dieses Vorkommen)") : t("ausgeblendet"));
    if (compact) notes.push(t("kompakt"));

    list.append(
      h("div", { class: "ev" + (hidden ? " off" : "") },
        h("span", { class: "date" }, fmtEv(ev)),
        h("span", { class: "dot", style: ev.color ? `background:${ev.color}` : "" }),
        h("div", { class: "main" },
          h("div", { class: "title", title: ev.title }, ev.title || t("(ohne Titel)")),
          h("div", { class: "meta" }, notes.join(" · "))
        ),
        h("div", { class: "actions" },
          h("button", { title: hidden ? t("Wieder anzeigen") : t("Ausblenden"), onclick: () => toggleHide(ev) }, hidden ? "👁" : "🙈"),
          h("button", { title: hasCompactRule(ev) ? t("Wieder normal anzeigen") : t("Kompakt anzeigen"), onclick: () => toggleCompact(ev) }, hasCompactRule(ev) ? "↕" : "▬"),
          h("button", { title: ev.recurring ? t("Ganze Serie als ICS exportieren") : t("Als ICS exportieren"), onclick: () => exportEv(ev) }, "📤"),
          h("button", { title: ev.readOnly ? t("Kalender ist schreibgeschützt") : t("Löschen"), disabled: ev.readOnly, onclick: () => deleteEv(ev) }, "🗑")
        )
      )
    );
  }
}

function ruleRow(rule, buttonLabel) {
  const scope = rule.rid
    ? h("span", { class: "tag" }, t("einzelnes Vorkommen {0}", fmtWhen(rule.when)))
    : rule.recurring ? h("span", { class: "tag" }, t("ganze Serie")) : null;
  return h("div", { class: "row" },
    h("div", { class: "main" },
      h("div", { class: "title", title: rule.title }, rule.title || t("(ohne Titel)"), scope),
      h("div", { class: "meta" }, rule.calendarName, !rule.recurring && rule.when ? " · " + fmtWhen(rule.when) : "")
    ),
    h("button", { onclick: () => { state.rules = state.rules.filter((r) => r.key !== rule.key); save(); } }, buttonLabel)
  );
}

function renderList(el, rules, label) {
  el.textContent = "";
  if (!rules.length) {
    el.append(h("div", { class: "empty" }, t("Keine Einträge.")));
    return;
  }
  for (const r of [...rules].sort((a, b) => a.title.localeCompare(b.title, LOCALE))) el.append(ruleRow(r, label));
}

function renderAll() {
  $("hideEnabled").checked = state.hideEnabled;
  $("compactEnabled").checked = state.compactEnabled;
  $("compactAllSeries").checked = state.compactAllSeries;
  $("compactAllSeries").disabled = !state.compactEnabled;
  const hidden = state.rules.filter((r) => r.mode === "hidden");
  const compact = state.rules.filter((r) => r.mode === "compact");
  $("hiddenCount").textContent = `(${hidden.length})`;
  $("compactCount").textContent = `(${compact.length})`;
  $("showAll").disabled = !hidden.length;
  $("normalAll").disabled = !compact.length;
  renderList($("hiddenList"), hidden, t("👁 Einblenden"));
  renderList($("compactList"), compact, t("Normal anzeigen"));
  renderEvents();
}

// ---------- Laden ----------
async function loadMonth() {
  setStatus(t("Termine werden geladen …"));
  try {
    events = await api.getMonthEvents(cur.getFullYear(), cur.getMonth() + 1);
    events.sort((a, b) => evStart(a) - evStart(b) || a.title.localeCompare(b.title, LOCALE));
    setStatus("");
  } catch (e) {
    events = [];
    setStatus(t("Termine konnten nicht geladen werden: {0}", e.message || e), true);
  }
  renderEvents();
}

async function reloadState() {
  state = await api.getState();
  renderAll();
}

// ---------- Ereignisse ----------
for (const id of ["hideEnabled", "compactEnabled", "compactAllSeries"]) {
  $(id).addEventListener("change", (e) => { state[id] = e.target.checked; save(); });
}
$("showAll").addEventListener("click", () => { state.rules = state.rules.filter((r) => r.mode !== "hidden"); save(); });
$("normalAll").addEventListener("click", () => {
  state.rules = state.rules.filter((r) => r.mode !== "compact");
  state.compactAllSeries = false;
  save();
});
$("showOff").addEventListener("change", renderEvents);
$("prev").addEventListener("click", () => { cur = new Date(cur.getFullYear(), cur.getMonth() - 1, 1); loadMonth(); });
$("next").addEventListener("click", () => { cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1); loadMonth(); });
$("today").addEventListener("click", () => { const n = new Date(); cur = new Date(n.getFullYear(), n.getMonth(), 1); loadMonth(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("dialog").hidden) $("dlgButtons").lastChild.click();
});

translatePage();
api.onChanged.addListener(reloadState);
reloadState().then(loadMonth);
