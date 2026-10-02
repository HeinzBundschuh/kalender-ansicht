/* Experiment-API „calendarView“
 * Blendet Termine in der Monats- und Mehrwochenansicht per Stylesheet aus
 * oder zeigt sie als schmalen Balken an. Die Kalenderdaten werden nie verändert.
 *
 * Grundlage (Thunderbird-Quellcode, calendar-month-view.js):
 *   Jeder Termin ist ein <calendar-month-day-box-item> in einem
 *   <li class="calendar-month-day-box-list-item">, mit den Attributen
 *   data-event-id (UID) und – bei Serienvorkommen – data-recurrence-id.
 *
 * Die Regeln (extensions.kalender-ansicht.state) teilt sich dieses Add-on mit
 * dem Add-on „Kalender-Terminplaner“; Änderungen werden über einen
 * Beobachter der Einstellung in beiden Richtungen übernommen.
 */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { cal } = ChromeUtils.importESModule(
  "resource:///modules/calendar/calUtils.sys.mjs"
);
var { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

const PREF = "extensions.kalender-ansicht.state";
const LISTENER_ID = "kalender-ansicht@heinz.at";
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const MENU_IDS = ["kv-sep", "kv-hide", "kv-hide-one", "kv-compact", "kv-export"];

// ---------------- Sprache (Deutsch / Englisch) ----------------
const TR_EN = {
  "Kalender nicht gefunden": "Calendar not found",
  "Kalender nicht gefunden ({0})": "Calendar not found ({0})",
  "„{0}“ ist schreibgeschützt": "“{0}” is read-only",
  "„{0}“ nicht mehr vorhanden": "“{0}” no longer exists",
  "Termin nicht gefunden": "Event not found",
  "Termin nicht mehr vorhanden": "Event no longer exists",
  "Termin nicht mehr vorhanden ({0})": "Event no longer exists ({0})",
  "Hauptfenster nicht gefunden": "Main window not found",
  "Vorkommen von „{0}“ nicht gefunden": "Occurrence of “{0}” not found",
  "„{0}“: {1}": "“{0}”: {1}",
  "„{0}“ in „{1}“: {2}": "“{0}” in “{1}”: {2}",
  "Als ICS exportieren": "Export as ICS",
  "Serie ausblenden": "Hide series",
  "Termin ausblenden": "Hide event",
  "Nur dieses Vorkommen ausblenden": "Hide this occurrence only",
  "Wieder normal anzeigen": "Show normally again",
  "Serie kompakt anzeigen": "Show series compactly",
  "Termin kompakt anzeigen": "Show event compactly",
  "Kalender-Ansicht": "Calendar Hide & Compact",
  "Termin exportiert:": "Event exported:",
  "Export fehlgeschlagen:": "Export failed:",
};
function tr(de, ...args) {
  let s = de;
  try {
    if (!/^de\b/i.test(Services.locale.appLocaleAsBCP47)) s = TR_EN[de] ?? de;
  } catch (e) {}
  return s.replace(/\{(\d+)\}/g, (_, i) => String(args[+i] ?? ""));
}

// ---------------- Kalenderdaten: Liste, Export, Löschen ----------------
function pad(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
function dt(d) {
  if (!d) return null;
  return {
    ms: Math.round(d.nativeTime / 1000),
    allDay: !!d.isDate,
    day: `${d.year}-${pad(d.month + 1)}-${pad(d.day)}`,
  };
}

// Vorkommen (Serien aufgelöst) im Bereich [from, to) als Array
async function occurrencesIn(calendar, fromYmd, toYmd) {
  const filter =
    Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;
  const start = cal.createDateTime(fromYmd);
  const end = cal.createDateTime(toYmd);
  if (typeof calendar.getItemsAsArray === "function") {
    return calendar.getItemsAsArray(filter, 0, start, end);
  }
  const out = [];
  const reader = calendar.getItems(filter, 0, start, end).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(...value);
  }
  return out;
}

// Farbe der ersten Kategorie mit hinterlegter Farbe (wie Thunderbird selbst)
function categoryColor(occ) {
  try {
    for (const c of occ.getCategories()) {
      const col = Services.prefs.getStringPref(
        "calendar.category.color." + cal.view.formatStringForCSSRule(c),
        ""
      );
      if (col) return col;
    }
  } catch (e) {}
  return "";
}

function occToJson(occ) {
  const calendar = occ.calendar;
  const parent = occ.parentItem || occ;
  return {
    categoryColor: categoryColor(occ),
    id: occ.id,
    rid: occ.recurrenceId ? String(occ.recurrenceId.nativeTime) : null,
    title: occ.title || "",
    location: occ.getProperty("LOCATION") || "",
    calendarId: calendar.id,
    calendarName: calendar.name,
    color: calendar.getProperty("color") || "",
    readOnly: !!calendar.readOnly,
    recurring: !!parent.recurrenceInfo,
    when: occ.startDate ? occ.startDate.icalString : "",
    start: dt(occ.startDate),
    end: dt(occ.endDate),
  };
}

// Vorkommen anhand von UID + recurrence-id wiederfinden (Suche rund um den Tag)
async function findOccurrence(calendar, ref) {
  if (!ref.rid) {
    return null;
  }
  const base = ref.start ? new Date(ref.start.ms) : new Date();
  const from = new Date(base);
  from.setDate(from.getDate() - 2);
  const to = new Date(base);
  to.setDate(to.getDate() + 3);
  const occs = await occurrencesIn(calendar, ymd(from), ymd(to));
  return (
    occs.find(
      (o) => o.id === ref.id && o.recurrenceId && String(o.recurrenceId.nativeTime) === ref.rid
    ) || null
  );
}

function serialize(items) {
  const ser = Cc["@mozilla.org/calendar/ics-serializer;1"].createInstance(Ci.calIIcsSerializer);
  ser.addItems(items);
  return ser.serializeToString();
}

function safeName(s) {
  return (s || "termin").replace(/[^\wäöüÄÖÜß-]+/g, "_").replace(/^_+|_+$/g, "").substring(0, 40) || "termin";
}

async function writeToDownloads(baseName, text) {
  const { Downloads } = ChromeUtils.importESModule("resource://gre/modules/Downloads.sys.mjs");


  const dir = await Downloads.getPreferredDownloadsDirectory();
  let path = PathUtils.join(dir, `${baseName}.ics`);
  for (let i = 2; await IOUtils.exists(path); i++) {
    path = PathUtils.join(dir, `${baseName}-${i}.ics`);
  }
  await IOUtils.writeUTF8(path, text);
  return path;
}

function stamp() {
  const n = new Date();
  return `${ymd(n)}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
}

// Master-Einträge (ganze Serien) zu den Referenzen holen, doppelte zusammenfassen
async function mastersFor(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = ref.calendarId + "\u0000" + ref.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const calendar = cal.manager.getCalendarById(ref.calendarId);
    const item = calendar ? await calendar.getItem(ref.id) : null;
    if (item) out.push({ calendar, item });
  }
  return out;
}

async function exportRefs(refs) {
  const masters = await mastersFor(refs);
  if (!masters.length) {
    throw new Error(tr("Termin nicht gefunden"));
  }
  const name = masters.length === 1 ? safeName(masters[0].item.title) : `termine-${stamp()}`;
  return writeToDownloads(name, serialize(masters.map((m) => m.item)));
}
const ITEM = "calendar-month-day-box-item";

const DEFAULT_STATE = {
  hideEnabled: true,       // Ausblenden aktiv
  compactEnabled: true,    // Kompaktmodus aktiv
  compactAllSeries: false, // alle Serientermine kompakt
  rules: [],               // [{key, mode:"hidden"|"compact", id, rid, title, calendarName, recurring, when}]
};

// ---------------- Zustand ----------------
function loadState() {
  try {
    const s = JSON.parse(Services.prefs.getStringPref(PREF, "{}"));
    return { ...DEFAULT_STATE, ...s, rules: Array.isArray(s.rules) ? s.rules : [] };
  } catch (e) {
    return { ...DEFAULT_STATE, rules: [] };
  }
}
function saveState(state) {
  Services.prefs.setStringPref(PREF, JSON.stringify(state));
}

// ---------------- CSS ----------------
function cssStr(s) {
  return String(s).replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ");
}
function selectorFor(rule) {
  let sel = `${ITEM}[data-event-id="${cssStr(rule.id)}"]`;
  if (rule.rid) {
    sel += `[data-recurrence-id="${cssStr(rule.rid)}"]`;
  }
  return sel;
}

function buildCss(state) {
  const parts = [];

  if (state.hideEnabled) {
    const sels = state.rules.filter((r) => r.mode === "hidden").map(selectorFor);
    if (sels.length) {
      parts.push(
        sels.map((s) => `.calendar-month-day-box-list-item:has(> ${s})`).join(",\n") +
          " { display: none !important; }"
      );
    }
  }

  if (state.compactEnabled) {
    const sels = state.rules.filter((r) => r.mode === "compact").map(selectorFor);
    if (state.compactAllSeries) {
      sels.push(`${ITEM}[data-recurrence-id]`);
    }
    if (sels.length) {
      const list = sels.join(",\n");
      parts.push(
        `${list} {
  min-height: 0 !important; height: 5px !important; max-height: 5px !important;
  padding: 0 !important; overflow: hidden !important; border-radius: 2px !important;
}`,
        sels.map((s) => `${s} > *`).join(",\n") + " { display: none !important; }",
        sels.map((s) => `.calendar-month-day-box-list-item:has(> ${s})`).join(",\n") +
          " { margin-block: 1px !important; }"
      );
    }
  }
  return parts.join("\n\n");
}

// ---------------- Kontextmenü: Termin unter dem Mauszeiger ----------------
function occurrenceFromPopup(win, popup) {
  const node = popup.triggerNode;
  const box = node && node.closest ? node.closest(ITEM) : null;
  if (box && box.occurrence) {
    return box.occurrence;
  }
  try {
    const sel = win.currentView().getSelectedItems();
    return sel && sel.length ? sel[0] : null;
  } catch (e) {
    return null;
  }
}

function describe(occ) {
  const parent = occ.parentItem || occ;
  let when = "";
  try {
    when = occ.startDate ? occ.startDate.icalString : "";
  } catch (e) {}
  return {
    id: occ.id,
    rid: occ.recurrenceId ? String(occ.recurrenceId.nativeTime) : null,
    title: occ.title || "",
    calendarName: occ.calendar ? occ.calendar.name : "",
    recurring: !!parent.recurrenceInfo,
    when,
  };
}

var calendarView = class extends ExtensionCommon.ExtensionAPI {
  constructor(extension) {
    super(extension);
    this.windows = new Map(); // window -> { sheetURI, cleanup }
    this.changeListeners = new Set();
    this.itemListeners = new Set();
    this.started = false;

    // Kalenderänderungen (neu/geändert/gelöscht/neu geladen) gebündelt melden
    let timer = null;
    const notify = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        for (const fire of this.itemListeners) fire.async();
      }, 400);
    };
    this.calObserver = {
      QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
      onStartBatch() {},
      onEndBatch: notify,
      onLoad: notify,
      onAddItem: notify,
      onModifyItem: notify,
      onDeleteItem: notify,
      onError() {},
      onPropertyChanged: notify,
      onPropertyDeleting() {},
    };
    // Regeln geändert – hier oder im Add-on Kalender-Terminplaner (gemeinsame Einstellung)
    this.prefObserver = { observe: () => this.changed() };
  }

  // ----- Anwenden -----
  applyToWindow(win) {
    const info = this.windows.get(win);
    if (!info) {
      return;
    }
    const utils = win.windowUtils;
    if (info.sheetURI) {
      try {
        utils.removeSheetUsingURIString(info.sheetURI, utils.AUTHOR_SHEET);
      } catch (e) {}
      info.sheetURI = null;
    }
    const css = buildCss(loadState());
    if (css) {
      info.sheetURI = "data:text/css;charset=utf-8," + encodeURIComponent(css);
      utils.loadSheetUsingURIString(info.sheetURI, utils.AUTHOR_SHEET);
    }
  }
  applyAll() {
    for (const win of this.windows.keys()) {
      this.applyToWindow(win);
    }
  }
  changed() {
    this.applyAll();
    for (const fire of this.changeListeners) {
      fire.async();
    }
  }

  // ----- Regeln ändern (aus dem Kontextmenü) -----
  toggleRule(mode, occ, single) {
    const state = loadState();
    const d = describe(occ);
    const rid = single ? d.rid : null;
    const key = `${mode}|${d.id}|${rid || ""}`;
    const idx = state.rules.findIndex((r) => r.key === key);
    if (idx >= 0) {
      state.rules.splice(idx, 1);
    } else {
      state.rules.push({ key, mode, ...d, rid });
      // Ausblenden-Regeln sollen auch wirken, wenn der Schalter aus war
      if (mode === "hidden") state.hideEnabled = true;
      if (mode === "compact") state.compactEnabled = true;
    }
    saveState(state); // Beobachter der Einstellung wendet die Änderung an
  }

  hasRule(mode, id, rid) {
    return loadState().rules.some((r) => r.mode === mode && r.id === id && (r.rid || null) === (rid || null));
  }

  // ----- Fenster einrichten -----
  setupWindow(win) {
    if (this.windows.has(win)) {
      return;
    }
    const doc = win.document;
    const popup = doc.getElementById("calendar-item-context-menu");
    const info = { sheetURI: null, cleanup: null };
    this.windows.set(win, info);
    this.applyToWindow(win);
    if (!popup) {
      return;
    }

    const mk = (id, tag = "menuitem") => {
      const el = doc.createElementNS(XUL_NS, tag);
      el.id = id;
      popup.appendChild(el);
      return el;
    };
    const sep = mk("kv-sep", "menuseparator");
    const miHide = mk("kv-hide");
    const miHideOne = mk("kv-hide-one");
    const miCompact = mk("kv-compact");
    const miExport = mk("kv-export");
    miExport.label = "📤 " + tr("Als ICS exportieren");
    let current = null;

    const onShowing = (event) => {
      if (event.target !== popup) {
        return;
      }
      let type = "";
      try {
        type = win.currentView().type;
      } catch (e) {}
      current = occurrenceFromPopup(win, popup);
      const show = !!current && (type === "month" || type === "multiweek");
      for (const el of [sep, miHide, miHideOne, miCompact]) {
        el.hidden = !show;
      }
      // Export funktioniert in allen Ansichten
      miExport.hidden = !current;
      if (!show) {
        sep.hidden = !current;
        return;
      }
      const d = describe(current);
      miHide.label = "🙈 " + (d.recurring ? tr("Serie ausblenden") : tr("Termin ausblenden"));
      miHideOne.hidden = !d.recurring || !d.rid;
      miHideOne.label = "🙈 " + tr("Nur dieses Vorkommen ausblenden");
      const isCompact = this.hasRule("compact", d.id, null);
      miCompact.label = isCompact
        ? "↕ " + tr("Wieder normal anzeigen")
        : "▬ " + (d.recurring ? tr("Serie kompakt anzeigen") : tr("Termin kompakt anzeigen"));
    };

    const onCommand = (event) => {
      if (!current) return;
      if (event.target === miHide) this.toggleRule("hidden", current, false);
      else if (event.target === miHideOne) this.toggleRule("hidden", current, true);
      else if (event.target === miCompact) this.toggleRule("compact", current, false);
      else if (event.target === miExport) {
        const occ = current;
        exportRefs([{ calendarId: occ.calendar.id, id: occ.id }]).then(
          (path) => Services.prompt.alert(win, tr("Kalender-Ansicht"), tr("Termin exportiert:") + "\n" + path),
          (e) => Services.prompt.alert(win, tr("Kalender-Ansicht"), tr("Export fehlgeschlagen:") + "\n" + (e.message || e))
        );
      }
    };

    popup.addEventListener("popupshowing", onShowing);
    popup.addEventListener("command", onCommand);

    info.cleanup = () => {
      popup.removeEventListener("popupshowing", onShowing);
      popup.removeEventListener("command", onCommand);
      for (const id of MENU_IDS) {
        const el = doc.getElementById(id);
        if (el) el.remove();
      }
    };
  }

  teardownWindow(win) {
    const info = this.windows.get(win);
    if (!info) {
      return;
    }
    if (info.sheetURI) {
      try {
        win.windowUtils.removeSheetUsingURIString(info.sheetURI, win.windowUtils.AUTHOR_SHEET);
      } catch (e) {}
    }
    if (info.cleanup) {
      try {
        info.cleanup();
      } catch (e) {}
    }
    this.windows.delete(win);
  }

  onStartup() {
    if (this.started) {
      return;
    }
    this.started = true;
    try {
      cal.manager.addCalendarObserver(this.calObserver);
    } catch (e) {
      console.error("Kalender-Ansicht: Beobachter nicht registriert", e);
    }
    Services.prefs.addObserver(PREF, this.prefObserver);
    ExtensionSupport.registerWindowListener(LISTENER_ID, {
      chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
      onLoadWindow: (win) => this.setupWindow(win),
      onUnloadWindow: (win) => this.windows.delete(win),
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    ExtensionSupport.unregisterWindowListener(LISTENER_ID);
    Services.prefs.removeObserver(PREF, this.prefObserver);
    try {
      cal.manager.removeCalendarObserver(this.calObserver);
    } catch (e) {}
    for (const win of [...this.windows.keys()]) {
      this.teardownWindow(win);
    }
    this.started = false;
  }

  getAPI(context) {
    const self = this;
    self.onStartup();
    return {
      calendarView: {
        async getState() {
          return loadState();
        },
        async setState(state) {
          const clean = {
            hideEnabled: !!state.hideEnabled,
            compactEnabled: !!state.compactEnabled,
            compactAllSeries: !!state.compactAllSeries,
            rules: Array.isArray(state.rules) ? state.rules : [],
          };
          saveState(clean); // Beobachter der Einstellung wendet die Änderung an
          return clean;
        },

        async getMonthEvents(year, month) {
          // month: 1–12
          const from = `${year}${pad(month)}01`;
          const next = new Date(year, month, 1);
          const to = ymd(next);
          const result = [];
          for (const calendar of cal.manager.getCalendars()) {
            if (calendar.getProperty("disabled")) continue;
            try {
              const occs = await occurrencesIn(calendar, from, to);
              for (const occ of occs) result.push(occToJson(occ));
            } catch (e) {
              console.error(`Kalender-Ansicht: ${calendar.name} nicht lesbar`, e);
            }
          }
          return result;
        },

        async exportEvents(refs) {
          return exportRefs(refs);
        },

        async getRangeEvents(fromYmd, toYmd) {
          // Bereich [from, to) im Format JJJJMMTT, alle aktiven Kalender
          const result = [];
          for (const calendar of cal.manager.getCalendars()) {
            if (calendar.getProperty("disabled")) continue;
            try {
              const occs = await occurrencesIn(calendar, fromYmd, toYmd);
              for (const occ of occs) result.push(occToJson(occ));
            } catch (e) {
              console.error(`Kalender-Ansicht: ${calendar.name} nicht lesbar`, e);
            }
          }
          return result;
        },

        async openEvent(ref) {
          const win = Services.wm.getMostRecentWindow("mail:3pane");
          const calendar = cal.manager.getCalendarById(ref.calendarId);
          if (!win || !calendar) throw new Error(tr("Kalender nicht gefunden"));
          let item = null;
          if (ref.rid) item = await findOccurrence(calendar, ref);
          if (!item) item = await calendar.getItem(ref.id);
          if (!item) throw new Error(tr("Termin nicht mehr vorhanden"));
          // Bei Serien fragt Thunderbird selbst: dieses Vorkommen oder ganze Serie
          win.modifyEventWithDialog(item, true);
        },

        async newEvent(dayYmd) {
          const win = Services.wm.getMostRecentWindow("mail:3pane");
          if (!win) throw new Error(tr("Hauptfenster nicht gefunden"));
          const start = cal.createDateTime(`${dayYmd}T090000`);
          start.timezone = cal.dtz.defaultTimezone;
          win.createEventWithDialog(null, start, null);
        },

        onItemsChanged: new ExtensionCommon.EventManager({
          context,
          name: "calendarView.onItemsChanged",
          register(fire) {
            self.itemListeners.add(fire);
            return () => self.itemListeners.delete(fire);
          },
        }).api(),

        async deleteEvents(refs, scope) {
          // scope: "series" = ganze Serie/Termin, "occurrence" = nur dieses Vorkommen
          const errors = [];
          const jobs = [];
          const backup = [];
          for (const ref of refs) {
            const calendar = cal.manager.getCalendarById(ref.calendarId);
            if (!calendar) {
              errors.push(tr("Kalender nicht gefunden"));
              continue;
            }
            if (calendar.readOnly) {
              errors.push(tr("„{0}“ ist schreibgeschützt", calendar.name));
              continue;
            }
            const master = await calendar.getItem(ref.id);
            if (!master) {
              errors.push(tr("„{0}“ nicht mehr vorhanden", ref.title || ref.id));
              continue;
            }
            if (scope === "occurrence" && ref.rid && master.recurrenceInfo) {
              const occ = await findOccurrence(calendar, ref);
              if (!occ) {
                errors.push(tr("Vorkommen von „{0}“ nicht gefunden", master.title));
                continue;
              }
              jobs.push({ calendar, master, rid: occ.recurrenceId });
            } else {
              jobs.push({ calendar, master, rid: null });
            }
            backup.push(master);
          }

          // Backup zuerst – ohne Backup wird nichts gelöscht
          let backupPath = "";
          if (backup.length) {
            backupPath = await writeToDownloads(
              `kalender-ansicht-backup-${stamp()}`,
              serialize(backup)
            );
          }

          let deleted = 0;
          const state = loadState();
          for (const job of jobs) {
            try {
              if (job.rid) {
                const changedItem = job.master.clone();
                changedItem.recurrenceInfo.removeOccurrenceAt(job.rid);
                await job.calendar.modifyItem(changedItem, job.master);
                const r = String(job.rid.nativeTime);
                state.rules = state.rules.filter((x) => !(x.id === job.master.id && x.rid === r));
              } else {
                await job.calendar.deleteItem(job.master);
                state.rules = state.rules.filter((x) => x.id !== job.master.id);
              }
              deleted++;
            } catch (e) {
              errors.push(tr("„{0}“: {1}", job.master.title, e.message || e));
            }
          }
          saveState(state); // Regeln zu gelöschten Terminen aufräumen
          return { deleted, backupPath, errors };
        },
        onChanged: new ExtensionCommon.EventManager({
          context,
          name: "calendarView.onChanged",
          register(fire) {
            self.changeListeners.add(fire);
            return () => self.changeListeners.delete(fire);
          },
        }).api(),
      },
    };
  }
};
