/* LifeWorld Capture: a menu bar icon, an optional system-wide shortcut and a
 * small capture box for Obsidian, a computer-only companion to LifeWorld.
 *
 * Hand-written CommonJS, no build step beyond the bundled font at the end.
 *
 * Electron: Obsidian's plugin API has no menu bar or system-wide shortcut API,
 * so this uses require('electron').remote (Tray, Menu, globalShortcut,
 * BrowserWindow). When that bridge is missing the plugin stays off quietly
 * with one notice. Desktop only (manifest isDesktopOnly + a Platform.isMobile
 * guard). Everything system-wide (icon, shortcut, capture box) is torn down on
 * unload AND on window reload (beforeunload), so nothing leaks.
 *
 * What it writes:
 *  - Daily Note: '- HH:MM  text' under a heading ('Quick notes') in the day's
 *    note from Obsidian's Daily notes settings. With LifeWorld's Today page
 *    running and default settings it calls Today's own functions, so both
 *    write the same line.
 *  - Inbox: a new note in the inbox folder, titled from the first line
 *    (created, captured and any properties set in Settings, through
 *    processFrontMatter).
 *  - Task: with LifeWorld, a real task note through LifeWorld's task engine
 *    (its quick add words: "call Ana friday 3pm"), then planned_half /
 *    planned_order the way LifeWorld's Planner writes them. Without LifeWorld,
 *    a '- [ ]' line in one task list note (Tasks plugin format).
 *  - Your own destinations: a new note in a folder, or a line under a heading
 *    in the daily note.
 * The capture box is a local page with no links and no remote content; it only
 * sends the user's own typed text and picked or pasted pictures.
 */
'use strict';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- main.js ships as written, with no build step, so CommonJS require is how it loads Obsidian's API.
const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Platform } = obsidian;
// Node and Electron modules (computers only; no build step). null where one is missing.
function nodeModule(name) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- no build step; this one guarded loader returns null where Node is missing (phones).
  try { return require(name) || null; } catch { return null; }
}

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const PLUGIN_ID = 'lifeworld-capture';
const IPC = 'lwc'; // the capture page (PANEL_JS) uses the same name
const TRAY_GUID = '518f84e4-9730-47c5-aebe-ed65da0b381c';
const DEFAULT_SHORTCUT = ''; // none: the community directory asks plugins not to set keys for people
const TODAY_PLUGIN = 'a4-today';
const TODAY_COMMAND = 'a4-today:open';
const TODAY_VIEW = 'a4-today';
// A LifeWorld part (Today, Planner, Projects), found under its id inside the running LifeWorld.
function partOf(app, id) {
  const pl = app && app.plugins && app.plugins.plugins;
  if (!pl) return null;
  return pl[id] || (pl.lifeworld && pl.lifeworld.running && pl.lifeworld.running[id]) || null;
}
const PLANNER_COMMAND = 'a4-planner:open'; // LifeWorld's Planner (its parts keep these ids)
const CLOSED_PROJECT = ['done', 'failed', 'dropped', 'idea', 'cold-storage', 'backlog']; // LifeWorld's task-card picker leaves these out
const CAPTURE_MAX_CHARS = 2000; // same cap as LifeWorld Today's capture box
const NOTE_MAX_CHARS = 20000;
const TITLE_MAX = 60;
const PANEL_W = 532;
const ACCENT = { light: '#d43f16', dark: '#ff5a2d' }; // the mockup's orange (LifeWorld Today "Orange")
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg'];

/* ========================================================================== *
 * Pure logic (no Obsidian objects; tested in tests/test-capture.js)
 * ========================================================================== */

/* ---- SHARED date helpers: verbatim copies of LifeWorld Projects' SHARED functions
 * of the same names (the quick add below needs them; the tests compare each
 * one character for character) --------------------------------------------- */

function pad2(n) { return String(n).padStart(2, '0'); }
function dayOf(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isDayStr(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function toDayStr(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : dayOf(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
function utcOf(day) { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function fromUtc(ms) { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function addDays(day, n) { return fromUtc(utcOf(day) + n * 86400000); }
function daysBetween(a, b) { return Math.round((utcOf(b) - utcOf(a)) / 86400000); }
function weekdayOf(day) { return new Date(utcOf(day)).getUTCDay(); } // 0 = Sunday
function partsOf(day) { const [y, m, d] = day.split('-').map(Number); return { y, m, d }; }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
function parseRRule(raw, fallbackStart) {
  if (!raw || typeof raw !== 'string') return null;
  const out = { interval: 1, byday: null, bymonthday: null, bymonth: null, bysetpos: null, count: null, until: null, wkst: 1, exdates: [] };
  let text = raw.replace(/\r/g, '');
  // DTSTART may carry parameters (DTSTART;TZID=...:20260904T090000); read it
  // whole before splitting the rest on ';'. Only the calendar date matters.
  const ds = /DTSTART(?:;[^:\n]*)?[:=](\d{4})(\d{2})(\d{2})[^;\n]*/i.exec(text);
  if (ds) { out.dtstart = `${ds[1]}-${ds[2]}-${ds[3]}`; text = text.replace(ds[0], ''); }
  const ex = /EXDATE(?:;[^:\n]*)?[:=]([0-9TZ,]+)/gi;
  let em;
  while ((em = ex.exec(text))) {
    em[1].split(',').forEach((x) => { const m = /(\d{4})(\d{2})(\d{2})/.exec(x); if (m) out.exdates.push(`${m[1]}-${m[2]}-${m[3]}`); });
  }
  text = text.replace(ex, '');
  const parts = text.split(/[;\n]/).map((p) => p.trim().replace(/^RRULE:/i, '')).filter(Boolean);
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    const k = p.slice(0, i).trim().toUpperCase();
    const val = p.slice(i + 1).trim();
    if (k === 'FREQ') out.freq = val.toUpperCase();
    else if (k === 'INTERVAL') out.interval = Math.max(1, parseInt(val, 10) || 1);
    else if (k === 'COUNT') out.count = Math.max(0, parseInt(val, 10) || 0);
    else if (k === 'UNTIL') { const m = /(\d{4})(\d{2})(\d{2})/.exec(val); if (m) out.until = `${m[1]}-${m[2]}-${m[3]}`; }
    else if (k === 'WKST') { if (WD[val.toUpperCase()] != null) out.wkst = WD[val.toUpperCase()]; }
    else if (k === 'BYDAY') {
      out.byday = val.split(',').map((t) => {
        const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(t.trim());
        return m ? { n: m[1] ? parseInt(m[1], 10) : 0, wd: WD[m[2].toUpperCase()] } : null;
      }).filter(Boolean);
      if (!out.byday.length) return null;
    } else if (k === 'BYMONTHDAY') out.bymonthday = val.split(',').map((x) => parseInt(x, 10)).filter((x) => x && Math.abs(x) <= 31);
    else if (k === 'BYMONTH') out.bymonth = val.split(',').map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 12);
    else if (k === 'BYSETPOS') out.bysetpos = val.split(',').map((x) => parseInt(x, 10)).filter((x) => x);
  }
  if (!out.dtstart) out.dtstart = toDayStr(fallbackStart);
  if (!out.dtstart || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(out.freq)) return null;
  return out;
}
function monthDaysByDay(byday, y, m) {
  const dim = daysInMonth(y, m);
  const out = new Set();
  for (const { n, wd } of byday) {
    const hits = [];
    for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() === wd) hits.push(d);
    if (!n) hits.forEach((d) => out.add(d));
    else { const d = n > 0 ? hits[n - 1] : hits[hits.length + n]; if (d) out.add(d); }
  }
  return out;
}
function monthDaysByMonthDay(list, y, m) {
  const dim = daysInMonth(y, m);
  const out = new Set();
  for (const x of list) { const d = x > 0 ? x : dim + 1 + x; if (d >= 1 && d <= dim) out.add(d); }
  return out;
}
function applySetPos(set, pos) {
  if (!pos) return set;
  const sorted = [...set].sort((a, b) => a - b);
  const out = new Set();
  for (const p of pos) { const v = p > 0 ? sorted[p - 1] : sorted[sorted.length + p]; if (v != null) out.add(v); }
  return out;
}
function matchesPattern(r, day) {
  const s = r.dtstart;
  if (day < s) return false;
  const { y, m, d } = partsOf(day);
  const st = partsOf(s);
  const wd = weekdayOf(day);
  if (r.bymonth && !r.bymonth.includes(m)) return false;
  if (r.freq === 'DAILY') {
    if (daysBetween(s, day) % r.interval !== 0) return false;
    if (r.bymonthday && !monthDaysByMonthDay(r.bymonthday, y, m).has(d)) return false;
    if (r.byday && !r.byday.some((b) => b.wd === wd)) return false;
    return true;
  }
  if (r.freq === 'WEEKLY') {
    const startOfWeek = (x) => addDays(x, -((weekdayOf(x) - r.wkst + 7) % 7));
    const weeks = daysBetween(startOfWeek(s), startOfWeek(day)) / 7;
    if (weeks % r.interval !== 0) return false;
    const days = r.byday ? r.byday.map((b) => b.wd) : [weekdayOf(s)];
    return days.includes(wd);
  }
  if (r.freq === 'MONTHLY') {
    const months = (y - st.y) * 12 + (m - st.m);
    if (months % r.interval !== 0) return false;
    let set;
    if (r.bymonthday && r.byday) {
      const a = monthDaysByMonthDay(r.bymonthday, y, m); const b = monthDaysByDay(r.byday, y, m);
      set = new Set([...a].filter((x) => b.has(x)));
    } else if (r.bymonthday) set = monthDaysByMonthDay(r.bymonthday, y, m);
    else if (r.byday) set = monthDaysByDay(r.byday, y, m);
    else set = new Set(st.d <= daysInMonth(y, m) ? [st.d] : []); // RFC: months without that day are skipped
    return applySetPos(set, r.bysetpos).has(d);
  }
  if (r.freq === 'YEARLY') {
    if ((y - st.y) % r.interval !== 0) return false;
    const months = r.bymonth || [st.m];
    if (!months.includes(m)) return false;
    let set;
    if (r.bymonthday) set = monthDaysByMonthDay(r.bymonthday, y, m);
    else if (r.byday) set = monthDaysByDay(r.byday, y, m);
    else set = new Set(st.d <= daysInMonth(y, m) ? [st.d] : []);
    return applySetPos(set, r.bysetpos).has(d);
  }
  return false;
}
function occursOn(rule, day) {
  if (!rule || !isDayStr(day) || day < rule.dtstart) return false;
  if (rule.until && day > rule.until) return false;
  if (!matchesPattern(rule, day)) return false;
  if (rule.exdates.includes(day)) return false;
  if (rule.count) {
    // RFC 5545: COUNT counts pattern hits from DTSTART (EXDATE still uses a slot).
    let n = 0;
    for (let x = rule.dtstart; x <= day; x = addDays(x, 1)) {
      if (matchesPattern(rule, x)) n++;
      if (n > rule.count) return false;
    }
  }
  return true;
}
function halfOfTime(t) { return t ? (t < '13:00' ? 'am' : 'pm') : null; }
function timeText(t, short) {
  if (!t) return '';
  const [h, mi] = t.split(':').map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${short && !mi ? hh : `${hh}:${pad2(mi)}`} ${h < 12 ? 'AM' : 'PM'}`;
}

/* ---- end of SHARED date helpers ------------------------------------------- */

/* ========================================================================== *
 * SHARED quick add with LifeWorld's Planner and Projects (verbatim copies;
 * do not edit here without editing both the same way; the tests compare them
 * character for character). Plain words -> a new task: "call Ana friday 3pm
 * !high". Uses the SHARED date helpers above.
 * ========================================================================== */

const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DOW_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MON_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dowIndex(w) { const x = String(w).toLowerCase(); if (x.length < 3) return -1; return DOW_NAMES.findIndex((d) => d.startsWith(x) || (x.startsWith(d.slice(0, 3)) && d.startsWith(x.replace(/s$/, '')))); }
function nextDow(today, idx, skipToday) { let n = (idx - weekdayOf(today) + 7) % 7; if (n === 0 && skipToday) n = 7; return addDays(today, n); }
function validDay(y, m, d) { const s = `${y}-${pad2(m)}-${pad2(d)}`; return isDayStr(s) && toDayStr(fromUtc(utcOf(s))) === s ? s : null; }

// A typed day -> 'YYYY-MM-DD' or null.
function parseDayWord(w, today) {
  const x = String(w || '').trim().toLowerCase().replace(/^on /, '').replace(/[.,]+$/, '');
  if (!x) return null;
  if (x === 'today' || x === 'tonight') return today;
  if (x === 'tomorrow' || x === 'tmrw') return addDays(today, 1);
  if (x === 'yesterday') return addDays(today, -1);
  if (x === 'next week') return addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
  let m = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(x);
  if (m) return addDays(today, Number(m[1]) * (m[2].startsWith('week') ? 7 : 1));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(x);
  if (m) return validDay(Number(m[1]), Number(m[2]), Number(m[3]));
  // A weekday name is its next
  // one (a week ahead when it is today); "next <weekday>" adds a week.
  m = /^(next |this )?([a-z]+)$/.exec(x);
  if (m && dowIndex(m[2]) >= 0) { const base = nextDow(today, dowIndex(m[2]), true); return m[1] === 'next ' && base !== addDays(today, 7) ? addDays(base, 7) : base; }
  const year = Number(today.slice(0, 4));
  const ahead = (mo, d) => { const s = validDay(year, mo, d); if (!s) return null; return s < today ? validDay(year + 1, mo, d) : s; };
  m = /^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?$/.exec(x) || /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*$/.exec(x);
  if (m) { const mon = MON_NAMES.indexOf(isNaN(m[1]) ? m[1] : m[2]); const d = Number(isNaN(m[1]) ? m[2] : m[1]); if (mon >= 0) return ahead(mon + 1, d); }
  m = /^(\d{1,2})\/(\d{1,2})$/.exec(x);
  if (m) return ahead(Number(m[1]), Number(m[2]));
  return null;
}

const DAY_RE = '(today|tonight|tomorrow|tmrw|next week|in \\d{1,3} (?:days?|weeks?)|\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}/\\d{1,2}|(?:next |this )?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \\d{1,2}(?:st|nd|rd|th)?|\\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)';

// "every ..." words -> RRULE body (no DTSTART) or null.
function repeatRule(words) {
  const w = String(words || '').trim().toLowerCase().replace(/^every /, '');
  if (!w) return null;
  if (w === 'day' || w === 'daily') return 'FREQ=DAILY';
  if (w === 'other day') return 'FREQ=DAILY;INTERVAL=2';
  if (w === 'weekday' || w === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  if (w === 'week' || w === 'weekly') return 'FREQ=WEEKLY';
  if (w === 'other week') return 'FREQ=WEEKLY;INTERVAL=2';
  if (w === 'month' || w === 'monthly') return 'FREQ=MONTHLY';
  if (w === 'other month') return 'FREQ=MONTHLY;INTERVAL=2';
  if (w === 'year' || w === 'yearly') return 'FREQ=YEARLY';
  let m = /^(\d{1,3}) (day|days|week|weeks|month|months|year|years)$/.exec(w);
  if (m) { const f = { d: 'DAILY', w: 'WEEKLY', m: 'MONTHLY', y: 'YEARLY' }[m[2][0]]; return Number(m[1]) > 1 ? `FREQ=${f};INTERVAL=${Number(m[1])}` : `FREQ=${f}`; }
  m = /^(other |2nd |second )?(.+)$/.exec(w);
  const parts = m[2].split(/\s*(?:,|and|&)\s*/).filter(Boolean);
  const idx = parts.map(dowIndex);
  if (parts.length && idx.every((i) => i >= 0)) {
    const days = [...new Set(idx)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((i) => DOW_CODES[i]);
    return `FREQ=WEEKLY;${m[1] ? 'INTERVAL=2;' : ''}BYDAY=${days.join(',')}`;
  }
  return null;
}
const REPEAT_RE = /\severy (other day|other week|other month|day|daily|weekdays?|week|weekly|month|monthly|year|yearly|\d{1,3} (?:days?|weeks?|months?|years?)|(?:other |2nd |second )?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s*(?:,|and|&)\s*(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)*)\b/i;

// -> { title, priority, due, start, plannedDay, plannedHalf, recurrence, repeatText, time, startTime }
// (time: the due time, or a repeating task's start time; startTime: a one-off start's)
function understand(text, today) {
  let s = ` ${String(text || '')} `;
  const r = { priority: null };
  // Takes the first match the reader accepts (fn returns true) and cuts
  // only that one out of the title; a match it can't read stays in the text.
  const cut = (re, fn) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m;
    while ((m = g.exec(s))) { if (fn(m)) { s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); return; } g.lastIndex = m.index + 1; }
  };
  cut(/\s!(high|low|none|normal)\b/i, (m) => { r.priority = m[1].toLowerCase(); return true; });
  cut(/\s(p1|p2|p3|p4)\b/i, (m) => { r.priority = { p1: 'high', p2: 'normal', p3: 'low', p4: 'none' }[m[1].toLowerCase()]; return true; });
  cut(REPEAT_RE, (m) => { const rule = repeatRule(m[1]); if (!rule) return false; r.recurrence = rule; r.repeatText = m[1].toLowerCase(); return true; });
  cut(new RegExp(`\\s(?:starts?|start on|starting|from) ${DAY_RE}\\b`, 'i'), (m) => { const d = parseDayWord(m[1], today); if (!d) return false; r.start = d; return true; });
  cut(new RegExp(`\\s(?:due|by) ${DAY_RE}\\b`, 'i'), (m) => { const d = parseDayWord(m[1], today); if (!d) return false; r.due = d; return true; });
  // A clock time: "3pm", "at 9:30am", "4 p.m.", or "at 15:30" / "at noon" (a bare
  // colon time needs "at" here, so "Read Luke 3:16" stays a title).
  cut(/\s(?:at\s)?(\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.))(?=\s)/i, (m) => { const tm = parseClock(m[1]); if (!tm) return false; r.time = tm; return true; });
  if (!r.time) cut(/\sat\s(\d{1,2}:\d{2}|noon|midnight)(?=\s)/i, (m) => { const tm = parseClock(m[1]); if (!tm) return false; r.time = tm; return true; });
  cut(/\s(?:in the |this )?(morning|afternoon|evening|tonight)\b/i, (m) => { r.plannedHalf = m[1].toLowerCase() === 'morning' ? 'am' : 'pm'; if (m[1].toLowerCase() === 'tonight') r.plannedDay = today; return true; });
  cut(new RegExp(`\\s(?:on )?${DAY_RE}\\b`, 'i'), (m) => { const d = parseDayWord(m[1], today); if (!d) return false; r.plannedDay = d; return true; });
  // "starts monday 9am" with no other day: the time goes with the start.
  if (r.time && !r.recurrence && r.start && !r.due && !r.plannedDay && !r.plannedHalf) { r.startTime = r.time; delete r.time; }
  if (r.time) r.plannedHalf = halfOfTime(r.time);    // a clock time picks the half (before 1 PM is Morning)
  if (r.time && !r.due && !r.recurrence) { r.due = r.plannedDay || today; delete r.plannedDay; } // and lives on Due
  if (r.plannedHalf && !r.plannedDay && !r.due && !r.recurrence) r.plannedDay = today;
  if (r.due && r.plannedDay) delete r.plannedDay;     // due always wins
  if (r.recurrence) { delete r.plannedDay; delete r.due; }
  r.title = s.replace(/\s+/g, ' ').trim();
  if (r.title) r.title = r.title[0].toUpperCase() + r.title.slice(1);
  return r;
}

// A typed clock time -> 'HH:MM' or null. Needs am/pm or a colon ("4pm",
// "4 p.m.", "9:30am", "15:30"), or is "noon" / "midnight". A bare "9" is not
// a time: it could be either half of the day, so it is never guessed.
function parseClock(s) {
  const x = String(s || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  if (x === 'noon') return '12:00';
  if (x === 'midnight') return '00:00';
  let m = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(x);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2] || 0);
    if (h < 1 || h > 12 || mi > 59) return null;
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    return `${pad2(h)}:${pad2(mi)}`;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(x);
  if (m) { const h = Number(m[1]); const mi = Number(m[2]); return h <= 23 && mi <= 59 ? `${pad2(h)}:${pad2(mi)}` : null; }
  return null;
}

// The value written: 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' (TaskNotes' format).
function whenValue(day, time) { return day ? (time ? `${day}T${time}` : day) : null; }

// First occurrence of a new rule on or after `from` (for DTSTART/scheduled).
function firstOccurrence(rule, from) {
  const r = parseRRule(`DTSTART:${from.replace(/-/g, '')};${rule}`);
  if (!r) return from;
  for (let d = from, i = 0; i < 800; d = addDays(d, 1), i++) if (occursOn(r, d)) return d;
  return from;
}

// RRULE -> plain words ("Every Monday and Thursday").
const DOW_LONG = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
function joinWords(list) { return list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`; }
function ordinal(n) { const v = n % 100; return `${n}${v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`; }
function repeatWords(raw) {
  if (!raw) return "Doesn't repeat";
  const r = parseRRule(raw, '2000-01-01');
  if (!r) return 'Repeats (custom rule)';
  const n = r.interval;
  const days = r.byday ? r.byday.filter((b) => !b.n).map((b) => DOW_CODES[b.wd]) : null;
  if (r.freq === 'DAILY') return n === 1 ? 'Every day' : `Every ${n} days`;
  if (r.freq === 'WEEKLY') {
    if (days && days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d)) && n === 1) return 'Every weekday (Mon to Fri)';
    const on = days && days.length ? joinWords(days.map((d) => DOW_LONG[d])) : DOW_LONG[DOW_CODES[weekdayOf(r.dtstart)]];
    return n === 1 ? `Every ${on}` : `Every ${n} weeks on ${on}`;
  }
  if (r.freq === 'MONTHLY') {
    const day = r.bymonthday && r.bymonthday.length === 1 ? r.bymonthday[0] : (r.byday ? null : partsOf(r.dtstart).d);
    const what = day ? `on the ${day < 0 ? 'last day' : ordinal(day)}` : 'on a set weekday';
    return n === 1 ? `Every month ${what}` : `Every ${n} months ${what}`;
  }
  if (r.freq === 'YEARLY') return n === 1 ? 'Every year' : `Every ${n} years`;
  return 'Repeats (custom rule)';
}

// Days and halves as the quick add line shows them.
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function shortDay(day, today) {
  if (day === today) return 'today';
  if (day === addDays(today, 1)) return 'tomorrow';
  if (day === addDays(today, -1)) return 'yesterday';
  const { m, d, y } = partsOf(day);
  return `${WEEKDAYS_SHORT[weekdayOf(day)]}, ${MONTHS_SHORT[m - 1]} ${d}${y !== Number(today.slice(0, 4)) ? ` ${y}` : ''}`;
}
function halfWord(h) { return h === 'am' ? 'morning' : h === 'pm' ? 'afternoon' : ''; }

// The orange "what will be saved" line under a quick add box, as chip texts:
// the title, the project (when given), the day, Due, Starts, the repeat, and a
// priority that isn't the default one.
function quickAddChips(r, today, project, defaultPriority) {
  const out = [r.title || '…'];
  if (project) out.push(project);
  if (r.plannedDay) out.push(`On ${shortDay(r.plannedDay, today)}${r.plannedHalf ? `, ${halfWord(r.plannedHalf)}` : ''}`);
  else if (r.plannedHalf && !r.recurrence && !r.time) out.push(halfWord(r.plannedHalf));
  if (r.due) out.push(`Due ${shortDay(r.due, today)}${r.time ? `, ${timeText(r.time)}` : ''}`);
  if (r.start) out.push(`Starts ${shortDay(r.start, today)}${r.startTime ? `, ${timeText(r.startTime)}` : ''}`);
  if (r.recurrence) out.push(`${repeatWords(`DTSTART:${firstOccurrence(r.recurrence, today).replace(/-/g, '')};${r.recurrence}`)}${r.time ? `, ${timeText(r.time)}` : (r.plannedHalf ? `, ${halfWord(r.plannedHalf)}` : '')}`);
  if (r.priority && r.priority !== defaultPriority) out.push(r.priority[0].toUpperCase() + r.priority.slice(1));
  return out;
}

// What a quick add saves: TaskNotes' own fields (a time written as TaskNotes
// writes it, 'YYYY-MM-DDTHH:MM') plus LifeWorld's planned_* fields. `lane` is the
// day and half the task joins ({ day, half }, or null): the caller adds
// planned_order at the end of that lane. -> { input, lane }
function quickAddPlan(r, today) {
  const input = { title: r.title, customFrontmatter: {} };
  const cf = input.customFrontmatter;
  if (r.priority) input.priority = r.priority;
  if (r.due) input.due = whenValue(r.due, r.time);
  if (r.start) input.scheduled = whenValue(r.start, r.startTime);
  let lane = null;
  if (r.recurrence) { const first = firstOccurrence(r.recurrence, r.start || today); input.recurrence = r.recurrence; input.scheduled = whenValue(first, r.time); if (r.plannedHalf) cf.planned_half = r.plannedHalf; }
  else if (r.plannedDay || r.due) {
    lane = { day: r.due || r.plannedDay, half: r.plannedHalf || null };
    if (!r.due) cf.planned_day = r.plannedDay;
    if (lane.half) cf.planned_half = lane.half;
  }
  return { input, lane };
}
/* ---- end of SHARED quick add ---------------------------------------------- */

// The given calendar day at the given clock time (local), DST-safe.
function atDay(dayStr, clock) {
  if (!isDayStr(dayStr)) return new Date(clock.getTime());
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(y, m - 1, d, clock.getHours(), clock.getMinutes(), clock.getSeconds());
}
function addDaysStr(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

// Same as LifeWorld Today's cleanCapture: one line, trimmed, capped.
function cleanCapture(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, CAPTURE_MAX_CHARS);
}
function captureLine(d, text, timestamp) {
  return timestamp === false ? `- ${text}` : `- ${pad2(d.getHours())}:${pad2(d.getMinutes())}  ${text}`;
}

// Minimal moment-style formatter (Obsidian's moment is used when present).
function formatDateTokens(d, fmt) {
  const map = { YYYY: String(d.getFullYear()), YY: String(d.getFullYear()).slice(-2), MM: pad2(d.getMonth() + 1), M: String(d.getMonth() + 1), DD: pad2(d.getDate()), D: String(d.getDate()), HH: pad2(d.getHours()), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()) };
  return String(fmt).replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g, (t) => map[t]);
}
function joinPath(folder, name) {
  const f = String(folder || '').replace(/^\/+|\/+$/g, '');
  return f ? `${f}/${name}` : name;
}
function dailyPath(folder, format, d, fmt) {
  const f = fmt || formatDateTokens;
  return joinPath(folder, `${f(d, format || 'YYYY-MM-DD')}.md`);
}
// LifeWorld Today's renderTemplate, with {{title}} = the new note's name.
function renderTemplate(tpl, d, fmt, title) {
  const f = fmt || ((date, pattern) => formatDateTokens(date, pattern));
  const t = title != null ? title : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${d.getFullYear()}`;
  return String(tpl)
    .replace(/\{\{\s*date\s*:\s*([^}]+?)\s*\}\}/g, (_, p) => f(d, p))
    .replace(/\{\{\s*time\s*:\s*([^}]+?)\s*\}\}/g, (_, p) => f(d, p))
    .replace(/\{\{\s*date\s*\}\}/g, f(d, 'YYYY-MM-DD'))
    .replace(/\{\{\s*time\s*\}\}/g, f(d, 'HH:mm'))
    .replace(/\{\{\s*title\s*\}\}/g, t);
}

function headingName(h) { return String(h == null ? '' : h).replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim() || 'Quick notes'; }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// LifeWorld Today's insertQuickNote, generalised: any '## <heading>', and optionally
// newest on top. With heading 'Quick notes' and newestOnTop false the output is
// byte-identical to Today's (checked by the logic tests). Never writes inside
// the frontmatter or between another section's lines.
function insertUnderHeading(text, heading, line, newestOnTop) {
  const name = headingName(heading);
  const headingLine = `## ${name}`;
  const re = new RegExp(`^## ${escapeRe(name)}[ \\t]*$`);
  text = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const fmEnd = (() => {
    if (!text.startsWith('---\n')) return 0;
    const i = text.indexOf('\n---', 4);
    if (i < 0) return 0;
    const nl = text.indexOf('\n', i + 4);
    return nl < 0 ? text.length : nl + 1;
  })();
  const lines = text.split('\n');
  let offset = 0; let startLine = 0;
  for (let i = 0; i < lines.length; i++) { if (offset >= fmEnd) { startLine = i; break; } offset += lines[i].length + 1; startLine = i + 1; }
  let h = -1;
  for (let i = startLine; i < lines.length; i++) if (re.test(lines[i])) { h = i; break; }
  if (h === -1) {
    // 'Quick notes' opens at the TOP of the body, under the frontmatter
    // (same as LifeWorld Today); any other heading is
    // still added at the end of the note.
    if (name === 'Quick notes') {
      const head = text.slice(0, fmEnd);
      const rest = text.slice(fmEnd).replace(/^(?:[ \t]*\n)+/, '');
      const lead = head ? '\n' : '';
      if (!rest.trim()) return `${head}${lead}${headingLine}\n\n${line}\n`;
      return `${head}${lead}${headingLine}\n\n${line}\n\n${rest.endsWith('\n') ? rest : `${rest}\n`}`;
    }
    const body = text.replace(/\s+$/, '');
    const sep = body.length ? '\n\n' : '';
    return `${body}${sep}${headingLine}\n\n${line}\n`;
  }
  let i = h + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const first = i;
  let last = -1;
  while (i < lines.length && (/^\s*[-*+] /.test(lines[i]) || (last !== -1 && /^\s{2,}\S/.test(lines[i])))) { last = i; i++; }
  if (last === -1) {
    const out = lines.slice(0, h + 1).concat(['', line]);
    const rest = lines.slice(h + 1);
    while (rest.length && rest[0].trim() === '') rest.shift();
    if (rest.length) out.push('', ...rest);
    let s = out.join('\n'); if (!s.endsWith('\n')) s += '\n';
    return s;
  }
  if (newestOnTop) return lines.slice(0, first).concat([line], lines.slice(first)).join('\n');
  return lines.slice(0, last + 1).concat([line], lines.slice(last + 1)).join('\n');
}

// File name from the first line. Keeps the words; drops characters a file
// name can't hold (and Obsidian's link characters).
function sanitizeTitle(s) {
  return String(s == null ? '' : s)
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|>\s+|\d+[.)]\s+)/, '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    // eslint-disable-next-line no-control-regex -- strips control characters on purpose (they break file names and titles).
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '');
}
function truncateTitle(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[.\s,;-]+$/, '');
}
// -> { title, body }: the first non-empty line names the note; whatever the
// title couldn't hold verbatim stays in the body, so no words are lost.
function noteParts(raw, now) {
  const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n').slice(0, NOTE_MAX_CHARS);
  const lines = text.split('\n');
  let k = 0; while (k < lines.length && !lines[k].trim()) k++;
  const firstLine = k < lines.length ? lines[k].trim() : '';
  const rest = lines.slice(k + 1).join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
  let title = truncateTitle(sanitizeTitle(firstLine), TITLE_MAX);
  if (!title) title = `Capture ${dayOf(now)} ${pad2(now.getHours())}-${pad2(now.getMinutes())}`;
  const keepFirst = !!firstLine && title !== firstLine;
  const body = [keepFirst ? firstLine : '', rest].filter(Boolean).join('\n\n');
  return { title, body };
}
function uniquePath(exists, folder, base, ext) {
  let p = joinPath(folder, `${base}.${ext}`);
  for (let n = 2; exists(p) && n < 1000; n++) p = joinPath(folder, `${base} ${n}.${ext}`);
  return p;
}
function safeFileName(name, fallbackExt) {
  const s = String(name || '').split(/[\\/]/).pop();
  const m = /^(.*?)(?:\.([A-Za-z0-9]{1,6}))?$/.exec(s);
  const base = sanitizeTitle(m[1]).slice(0, 80) || 'Pasted image';
  const ext = (m[2] || fallbackExt || 'png').toLowerCase();
  return { base, ext };
}
function normTag(tag) {
  const t = String(tag == null ? '' : tag).trim().replace(/^#+/, '').replace(/\s+/g, '-');
  return t && /^[^\s#,]+$/.test(t) ? t : '';
}

/* ---- shortcuts ------------------------------------------------------------- */

const MODS = [['Control', '⌃'], ['Alt', '⌥'], ['Shift', '⇧'], ['Command', '⌘']];
const MOD_ALIASES = { control: 'Control', ctrl: 'Control', alt: 'Alt', option: 'Alt', shift: 'Shift', command: 'Command', cmd: 'Command', super: 'Command', meta: 'Command', commandorcontrol: 'Command', cmdorctrl: 'Command' };
const CODE_KEYS = { Space: 'Space', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=', Enter: 'Return', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const KEY_SYMBOL = { Space: 'Space', Return: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Up: '↑', Down: '↓', Left: '←', Right: '→' };

// Canonical 'Control+Alt+Shift+Command+Key' or '' when invalid.
function normalizeAccel(accel) {
  if (!accel || typeof accel !== 'string') return '';
  const parts = accel.split('+').map((p) => p.trim()).filter(Boolean);
  if (accel.trim().endsWith('++')) parts.push('Plus');
  const mods = new Set(); let key = '';
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m) mods.add(m); else if (key) return ''; else key = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
  }
  if (!key) return '';
  return [...MODS.map(([m]) => m).filter((m) => mods.has(m)), key].join('+');
}
function accelSymbols(accel) {
  const a = normalizeAccel(accel);
  if (!a) return '';
  const parts = a.split('+'); const key = parts.pop();
  return MODS.filter(([m]) => parts.includes(m)).map(([, s]) => s).join('') + (KEY_SYMBOL[key] || key);
}
// From a KeyboardEvent-like object; null while only modifiers are down.
function accelFromEvent(e) {
  const code = String(e.code || '');
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  if (!key) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Control'); if (e.altKey) mods.push('Alt'); if (e.shiftKey) mods.push('Shift'); if (e.metaKey) mods.push('Command');
  return normalizeAccel([...mods, key].join('+'));
}
// -> { ok, reason }: the shape only. Whether another app holds it is asked of
// macOS itself (globalShortcut.register), never a fixed list. '' is allowed.
function checkAccel(accel) {
  if (accel === '' || accel == null) return { ok: true, reason: '' };
  const a = normalizeAccel(accel);
  if (!a) return { ok: false, reason: 'That is not a key combination.' };
  const parts = a.split('+'); const key = parts.pop();
  const strong = parts.filter((m) => m !== 'Shift').length;
  if (!/^F\d{1,2}$/.test(key) && (strong < 1 || parts.length < 2)) return { ok: false, reason: 'Use at least two of ⌃ ⌥ ⇧ ⌘ (one of them ⌃, ⌥ or ⌘), so it never takes a key other apps need.' };
  return { ok: true, reason: '' };
}

/* ---- in-panel destination keys ('⌘M') ------------------------------------- */

function normDestKey(k) {
  const s = String(k == null ? '' : k).trim();
  if (!s) return '';
  const m = /^(?:⌘|cmd\+?|command\+?)?\s*([A-Za-z0-9])$/i.exec(s);
  return m ? `⌘${m[1].toUpperCase()}` : null;
}

/* ---- settings and destinations -------------------------------------------- */

const DEFAULT_SETTINGS = {
  showIcon: true,
  shortcut: DEFAULT_SHORTCUT,
  rememberLast: true,
  lastDest: 'daily',
  inboxFolder: 'Inbox',
  inboxProps: '', // extra properties for a new inbox note, as YAML ('type: capture')
  dailyFolder: '', dailyFormat: '', dailyTemplate: '', // blank = Obsidian's Daily notes settings
  heading: 'Quick notes',
  timestamp: true,
  newestOnTop: false,
  custom: [],
  taskMode: 'tasknotes', // or 'list' (one note, Tasks plugin format)
  taskListNote: 'Tasks.md',
  taskWhen: 'today', // today | tomorrow | none
  taskHalf: 'auto',  // auto (morning before 1 PM) | am | pm
  taskProject: '',
  attachFolder: 'Inbox',
  attachLink: true,
};
const TAKEN_MSG = 'Another app is using this shortcut right now. Quit it or change its shortcut, then try again.';
const BUILTIN_KEYS = { daily: '⌘0', inbox: '⌘I', task: '⌘T' };

function normalizeCustom(list) {
  const out = []; const ids = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== 'object') continue;
    const kind = c.kind === 'heading' ? 'heading' : 'folder';
    const target = String(c.target || '').trim().replace(/^\/+|\/+$/g, '');
    const name = String(c.name || '').trim();
    if (!name || !target) continue;
    let id = String(c.id || '').trim() || `c${out.length + 1}`;
    while (ids.has(id) || ['daily', 'inbox', 'task'].includes(id)) id += 'x';
    ids.add(id);
    const key = normDestKey(c.key);
    out.push({ id, icon: String(c.icon || '').trim().slice(0, 8) || '📝', name: name.slice(0, 60), kind, target: kind === 'heading' ? headingName(target) : target, tag: normTag(c.tag), key: key || '', template: String(c.template || '') });
  }
  return out;
}
function normalizeSettings(saved) {
  const s = Object.assign({}, DEFAULT_SETTINGS, saved && typeof saved === 'object' ? saved : {});
  s.showIcon = s.showIcon !== false;
  s.shortcut = s.shortcut ? (normalizeAccel(s.shortcut) || '') : DEFAULT_SHORTCUT;
  if (s.shortcut && !checkAccel(s.shortcut).ok) s.shortcut = '';
  s.rememberLast = s.rememberLast !== false;
  s.timestamp = s.timestamp !== false;
  s.newestOnTop = s.newestOnTop === true;
  s.attachLink = s.attachLink !== false;
  s.heading = headingName(s.heading);
  for (const k of ['inboxFolder', 'attachFolder']) s[k] = String(s[k] == null ? '' : s[k]).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_SETTINGS[k];
  for (const k of ['dailyFolder', 'dailyFormat', 'dailyTemplate', 'taskProject']) s[k] = String(s[k] == null ? '' : s[k]).trim();
  s.dailyFolder = s.dailyFolder.replace(/^\/+|\/+$/g, '');
  s.inboxProps = String(s.inboxProps == null ? '' : s.inboxProps).trim();
  s.taskMode = s.taskMode === 'list' ? 'list' : 'tasknotes';
  s.taskListNote = String(s.taskListNote || '').trim() || DEFAULT_SETTINGS.taskListNote;
  if (!/\.md$/i.test(s.taskListNote)) s.taskListNote += '.md';
  s.taskWhen = ['today', 'tomorrow', 'none'].includes(s.taskWhen) ? s.taskWhen : 'today';
  s.taskHalf = ['auto', 'am', 'pm'].includes(s.taskHalf) ? s.taskHalf : 'auto';
  s.custom = normalizeCustom(s.custom);
  if (typeof s.lastDest !== 'string') s.lastDest = 'daily';
  return s;
}
// Picker order, as drawn: Daily Note, your own types, Inbox, Task.
function destinations(s) {
  const daily = { id: 'daily', icon: '📄', name: `Daily Note · ${s.heading}`, kind: 'daily', key: BUILTIN_KEYS.daily, builtin: true, ph: "What's on your mind?" };
  const inbox = { id: 'inbox', icon: '📥', name: 'Inbox · new note', kind: 'inbox', target: s.inboxFolder, key: BUILTIN_KEYS.inbox, builtin: true, ph: 'First line becomes the title' };
  const task = { id: 'task', icon: '☑️', name: s.taskMode === 'list' ? 'Task · task list' : 'Task', kind: 'task', key: BUILTIN_KEYS.task, builtin: true, ph: 'What needs doing?' };
  const own = s.custom.map((c) => Object.assign({}, c, { builtin: false, ph: c.kind === 'heading' ? "What's on your mind?" : 'First line becomes the title' }));
  return [daily, ...own, inbox, task];
}
function startDest(s) {
  const ids = destinations(s).map((d) => d.id);
  return s.rememberLast && ids.includes(s.lastDest) ? s.lastDest : 'daily';
}
function whereText(d) {
  if (d.kind === 'daily') return `Daily note · ${d.name.replace(/^Daily Note · /, '')}`;
  if (d.kind === 'heading') return `Heading in daily note: ${d.target}`;
  if (d.kind === 'task') return d.name === 'Task · task list' ? 'Task list note' : 'Task note';
  return `New note in ${d.target}`;
}
// Custom-destination form check -> '' or the problem in plain words.
function checkCustom(c, others) {
  if (!String(c.name || '').trim()) return 'Give it a name.';
  if (!String(c.target || '').trim()) return c.kind === 'heading' ? 'Say which heading in the daily note.' : 'Say which folder the new note goes in.';
  const k = normDestKey(c.key);
  if (k === null) return 'The shortcut is ⌘ plus one letter or digit, like ⌘M.';
  if (k) {
    const builtin = Object.entries(BUILTIN_KEYS).find(([, v]) => v === k);
    if (builtin) return `${k} is already used by ${{ daily: 'Daily Note', inbox: 'Inbox', task: 'Task' }[builtin[0]]}.`;
    const other = (others || []).find((o) => o.id !== c.id && o.key === k);
    if (other) return `${k} is already used by ${other.name}.`;
  }
  return '';
}
function moveCustom(list, id, delta) {
  const i = list.findIndex((c) => c.id === id); const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return list.slice();
  const out = list.slice(); const [x] = out.splice(i, 1); out.splice(j, 0, x);
  return out;
}

/* ---- tasks ---------------------------------------------------------------- */

// -> { due: 'YYYY-MM-DD' | null, half: 'am' | 'pm' | null }
function taskPlan(opts, now) {
  const today = dayOf(now);
  let due = null;
  if (opts && isDayStr(opts.day)) due = opts.day;
  else if (opts && opts.when === 'tomorrow') due = addDaysStr(today, 1);
  else if (opts && opts.when === 'none') due = null;
  else due = today;
  if (!due) return { due: null, half: null };
  let half = opts && (opts.half === 'am' || opts.half === 'pm') ? opts.half : null;
  if (!half) half = due === today && now.getHours() >= 13 ? 'pm' : 'am';
  return { due, half };
}
// The Task box text -> { title, rest }: the first non-empty line, cleaned, and
// whatever follows it (the task's details).
function taskText(raw) {
  const lines = String(raw || '').replace(/\r\n/g, '\n').split('\n');
  let k = 0; while (k < lines.length && !lines[k].trim()) k++;
  return { title: cleanCapture(lines[k] || ''), rest: lines.slice(k + 1).join('\n').trim() };
}
// The first line through the shared quick add parser. Typed dates, times,
// half-days or repeats win; with none typed the buttons (and a picked day)
// apply, as before 1.0.6. -> { r, typed, today }
function taskWords(raw, opts, now) {
  const today = dayOf(now);
  const r = understand(taskText(raw).title, today);
  const typed = !!(r.due || r.plannedDay || r.start || r.recurrence);
  if (!typed) { const plan = taskPlan(opts, now); if (plan.due) { r.due = plan.due; r.plannedHalf = plan.half; } }
  return { r, typed, today };
}
// End of the lane, the same numbers the Planner's orderForInsert gives at the end.
function nextOrder(orders) {
  const xs = (orders || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  return xs.length ? xs[xs.length - 1] + 10 : 10;
}
// A refusal the user should read (not a bug): shown in the panel, not logged as an error.
function userError(msg) { const e = new Error(msg); e.user = true; return e; }
// Properties typed as YAML (a destination's template, the inbox's properties) -> an object.
function parseProps(text, name, where) {
  let y = null;
  try { y = obsidian.parseYaml(String(text).replace(/^---\s*\n/, '').replace(/\n---\s*$/, '')); } catch { y = null; }
  if (!y || typeof y !== 'object' || Array.isArray(y)) throw userError(`The properties for "${name}" aren't valid. Fix them in ${where}.`);
  return y;
}
function taskListLine(text, due) { return `- [ ] ${text}${due ? ` 📅 ${due}` : ''}`; }
function halfDefault(setting, now) { return setting === 'am' || setting === 'pm' ? setting : (now.getHours() >= 13 ? 'pm' : 'am'); }

/* ---- bridge --------------------------------------------------------------- */

// The Electron 'remote' bridge, or null. Checked member by member.
function getBridge(req) {
  let remote = null;
  try { const el = req('electron'); remote = el && el.remote; } catch { remote = null; }
  if (!remote) { try { remote = req('@electron/remote'); } catch { remote = null; } }
  if (!remote) return null;
  try {
    for (const k of ['Tray', 'globalShortcut', 'BrowserWindow', 'Menu', 'nativeImage', 'screen', 'app']) if (!remote[k]) return null;
  } catch { return null; }
  return remote;
}

const logic = {
  partOf,
  pad2, dayOf, isDayStr, atDay, addDaysStr, cleanCapture, captureLine, formatDateTokens, joinPath, dailyPath, renderTemplate,
  headingName, insertUnderHeading, sanitizeTitle, truncateTitle, noteParts, uniquePath, safeFileName, normTag,
  normalizeAccel, accelSymbols, accelFromEvent, checkAccel, normDestKey, normalizeSettings, normalizeCustom, destinations,
  startDest, whereText, checkCustom, moveCustom, taskPlan, taskText, taskWords, understand, quickAddChips, quickAddPlan, nextOrder, taskListLine, halfDefault, getBridge,
  DEFAULT_SETTINGS, DEFAULT_SHORTCUT, TAKEN_MSG, BUILTIN_KEYS,
};

/* ========================================================================== *
 * Plugin
 * ========================================================================== */

class LifeWorldCapturePlugin extends Plugin {
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.bridge = null; this.tray = null; this.trayMenu = null; this.panel = null;
    this.registeredAccel = ''; this.shortcutState = 'off';
    this.panelOpen = false; this.dialogOpen = false; this.unfocused = []; this.prevApp = null;
    this.saving = false;
    if (Platform.isMobile || !Platform.isDesktopApp) return; // never on phones
    this.addSettingTab(new MenubarSettingTab(this.app, this));
    this.bridge = getBridge((m) => { const x = nodeModule(m); if (!x) throw new Error(`no ${m}`); return x; });
    if (!this.bridge) {
      this.bridgeMissing = true;
      new Notice('LifeWorld Capture: this Obsidian has no access to the menu bar, so the icon and the shortcut stay off. Nothing else is affected.', 8000);
      return;
    }
    this.addCommand({ id: 'open-panel', name: 'Open the capture panel', callback: () => this.openPanel() });
    this._onBeforeUnload = () => this.teardown();
    window.addEventListener('beforeunload', this._onBeforeUnload);
    // The panel page loads in the background (~1.5 s) so the first open is instant
    // and no early keystrokes are lost.
    this.app.workspace.onLayoutReady(() => { if (this.bridge) { this.applyIcon(); this.applyShortcut(); try { this.ensurePanel(); } catch { /* opened later */ } } });
  }

  onunload() {
    this.teardown();
    if (this._onBeforeUnload) window.removeEventListener('beforeunload', this._onBeforeUnload);
  }

  // Everything system-wide goes away: shortcut, icon, panel. Safe to call twice.
  teardown() {
    const R = this.bridge;
    if (!R) return;
    try { if (this.registeredAccel) R.globalShortcut.unregister(this.registeredAccel); } catch { /* gone */ }
    this.registeredAccel = '';
    try { window.localStorage.removeItem(`${PLUGIN_ID}:accel`); } catch { /* ignore */ }
    try { if (this.tray && !this.tray.isDestroyed()) this.tray.destroy(); } catch { /* gone */ }
    this.tray = null; this.trayMenu = null;
    this.restoreFocusable();
    try { if (this.panel && !this.panel.isDestroyed()) this.panel.destroy(); } catch { /* gone */ }
    this.panel = null; this.panelOpen = false; this.panelReady = false; this.pendingOpen = false;
  }

  // Normalise IN PLACE: the open settings page holds a reference to this object,
  // so replacing it would make every later change in that page go nowhere.
  async saveSettings() {
    const n = normalizeSettings(this.settings);
    for (const k of Object.keys(this.settings)) if (!(k in n)) delete this.settings[k];
    Object.assign(this.settings, n);
    await this.saveData(this.settings);
  }
  async onExternalSettingsChange() {
    Object.assign(this.settings, normalizeSettings(await this.loadData()));
    if (this.bridge) { this.applyIcon(); this.applyShortcut(); this.pushState(); }
  }

  /* ---- menu bar icon ------------------------------------------------------ */

  // The icon as files named "...Template.png" / "...Template@2x.png": a
  // NativeImage built here is a renderer-side copy whose template flag is lost
  // when the bridge hands it to the menu bar (it came out dark on a dark menu
  // bar). A path is loaded in the main process, where macOS sees the Template
  // name and tints it like every other menu bar icon.
  trayImagePath() {
    const fs = nodeModule('fs'); const os = nodeModule('os'); const path = nodeModule('path');
    const draw = (px) => {
      const c = document.createElement('canvas'); c.width = px; c.height = px;
      const g = c.getContext('2d'); g.scale(px / 24, px / 24);
      g.lineWidth = 2; g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#000';
      g.stroke(new Path2D('M12 20h9')); g.stroke(new Path2D('M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z'));
      return Buffer.from(c.toDataURL('image/png').split(',')[1], 'base64');
    };
    const dir = path.join(os.tmpdir(), PLUGIN_ID);
    fs.mkdirSync(dir, { recursive: true });
    const one = path.join(dir, 'lwcPenTemplate.png');
    fs.writeFileSync(one, draw(18));
    fs.writeFileSync(path.join(dir, 'lwcPenTemplate@2x.png'), draw(36));
    return one;
  }
  tooltip() {
    const k = this.registeredAccel ? ` · ${accelSymbols(this.registeredAccel)}` : '';
    return `LifeWorld Capture${k}`;
  }
  applyIcon() {
    const R = this.bridge;
    if (!R) return;
    if (!this.settings.showIcon) {
      try { if (this.tray && !this.tray.isDestroyed()) this.tray.destroy(); } catch { /* gone */ }
      this.tray = null; this.trayMenu = null;
      return;
    }
    if (!this.tray || this.tray.isDestroyed()) {
      const img = this.trayImagePath();
      // A fixed id keeps the icon's identity and place between launches (Electron: Tray guid, macOS).
      try { this.tray = new R.Tray(img, TRAY_GUID); } catch { this.tray = new R.Tray(img); }
      this.tray.on('click', () => this.togglePanel());
      this.tray.on('right-click', () => this.popMenu());
    }
    this.trayMenu = null; // rebuilt on next right-click with current labels
    this.tray.setToolTip(this.tooltip());
  }
  menuTemplate() {
    const has = (id) => !!(this.app.commands && this.app.commands.commands && this.app.commands.commands[id]);
    const acc = this.settings.shortcut || undefined;
    return [
      { label: 'Quick Capture', accelerator: acc, registerAccelerator: false, click: () => this.openPanel() },
      { label: 'Open Today', visible: has(TODAY_COMMAND), click: () => this.openInObsidian(TODAY_COMMAND) },
      { label: 'Open Planner', visible: !!this.plannerCommand(), click: () => this.openInObsidian(this.plannerCommand()) },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'Command+,', registerAccelerator: false, click: () => this.openSettings() },
      { type: 'separator' },
      { label: 'Quit Obsidian', accelerator: 'Command+Q', registerAccelerator: false, click: () => { try { this.bridge.app.quit(); } catch { /* ignore */ } } },
    ];
  }
  plannerCommand() {
    const cmds = (this.app.commands && this.app.commands.commands) || {};
    return partOf(this.app, 'a4-planner') && cmds[PLANNER_COMMAND] ? PLANNER_COMMAND : null;
  }
  buildMenu() { return this.bridge.Menu.buildFromTemplate(this.menuTemplate()); }
  popMenu() {
    if (!this.tray || this.tray.isDestroyed()) return;
    if (this.panelOpen) this.hidePanel(false);
    if (!this.trayMenu) this.trayMenu = this.buildMenu();
    this.tray.popUpContextMenu(this.trayMenu);
  }

  /* ---- global shortcut ---------------------------------------------------- */

  applyShortcut() {
    const R = this.bridge;
    if (!R) return;
    const gs = R.globalShortcut;
    try { if (this.registeredAccel) gs.unregister(this.registeredAccel); } catch { /* ignore */ }
    this.registeredAccel = '';
    // A window reload that skipped beforeunload can leave our old one behind.
    try {
      const stale = window.localStorage.getItem(`${PLUGIN_ID}:accel`);
      if (stale) { gs.unregister(stale); window.localStorage.removeItem(`${PLUGIN_ID}:accel`); }
    } catch { /* ignore */ }
    const accel = this.settings.shortcut;
    if (!accel) { this.shortcutState = 'off'; this.refreshTrayLabels(); return; }
    if (!checkAccel(accel).ok) { this.shortcutState = 'invalid'; this.refreshTrayLabels(); return; }
    let ok = false;
    try { ok = !gs.isRegistered(accel) && gs.register(accel, () => this.togglePanel()); } catch { ok = false; }
    if (ok) {
      this.registeredAccel = accel; this.shortcutState = 'ok';
      try { window.localStorage.setItem(`${PLUGIN_ID}:accel`, accel); } catch { /* ignore */ }
    } else this.shortcutState = 'taken';
    this.refreshTrayLabels();
  }
  refreshTrayLabels() {
    this.trayMenu = null;
    try { if (this.tray && !this.tray.isDestroyed()) this.tray.setToolTip(this.tooltip()); } catch { /* ignore */ }
  }

  /* ---- Obsidian side ------------------------------------------------------ */

  bringObsidianForward() {
    const R = this.bridge;
    try {
      const w = R.getCurrentWindow();
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
      R.app.focus({ steal: true });
    } catch { /* ignore */ }
  }
  openInObsidian(commandId) {
    if (this.panelOpen) this.hidePanel(false);
    this.bringObsidianForward();
    this.app.commands.executeCommandById(commandId);
    if (commandId === TODAY_COMMAND) {
      window.setTimeout(() => {
        const leaf = this.app.workspace.getLeavesOfType(TODAY_VIEW)[0];
        if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }, 150);
    }
  }
  openSettings(tab) {
    if (this.panelOpen) this.hidePanel(false);
    this.bringObsidianForward();
    if (tab) this.settingsTab = tab;
    try { this.app.setting.open(); this.app.setting.openTabById(PLUGIN_ID); } catch { /* ignore */ }
  }

  /* ---- daily note --------------------------------------------------------- */

  dailyConfig() {
    let o = {};
    try { const dn = this.app.internalPlugins.getPluginById('daily-notes'); o = (dn && dn.instance && dn.instance.options) || {}; } catch { o = {}; }
    const s = this.settings;
    return {
      folder: s.dailyFolder || String(o.folder || '').replace(/^\/+|\/+$/g, ''),
      format: s.dailyFormat || o.format || 'YYYY-MM-DD',
      template: s.dailyTemplate || o.template || '',
    };
  }
  fmt() { return obsidian.moment ? (d, p) => obsidian.moment(d).format(p) : null; }
  // LifeWorld Today's own functions, when this capture would write exactly what Today writes
  // (Today reads Obsidian's Daily notes settings, so the override fields must be empty).
  todayLogic() {
    const t = partOf(this.app, TODAY_PLUGIN);
    const L = t && t.constructor && t.constructor.logic;
    if (!L || typeof L.insertQuickNote !== 'function' || typeof L.captureLine !== 'function' || typeof L.scratchPathFor !== 'function' || typeof t.newScratchpadContent !== 'function') return null;
    const s = this.settings;
    if (s.heading !== 'Quick notes' || !s.timestamp || s.newestOnTop || s.dailyFolder || s.dailyFormat || s.dailyTemplate) return null;
    return { L, plugin: t };
  }
  async newDailyContent(d, name) {
    const c = this.dailyConfig();
    if (c.template) {
      const p = /\.md$/.test(c.template) ? c.template : `${c.template}.md`;
      const tpl = this.app.vault.getAbstractFileByPath(p);
      if (tpl instanceof TFile) {
        try { return renderTemplate(await this.app.vault.read(tpl), d, this.fmt(), name); } catch { /* fall through */ }
      }
    }
    return ''; // no template: an empty note, as Obsidian's Daily notes makes it
  }
  async ensureFolder(folder) {
    if (!folder) return;
    const parts = folder.split('/'); let cur = '';
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      const f = this.app.vault.getAbstractFileByPath(cur);
      if (!f) { try { await this.app.vault.createFolder(cur); } catch (e) { if (!this.app.vault.getAbstractFileByPath(cur)) throw e; } }
    }
  }
  // Appends one line under a heading of the given day's daily note.
  async writeDailyLine(text, dayStr, heading) {
    const now = new Date();
    const d = isDayStr(dayStr) ? atDay(dayStr, now) : now;
    const useToday = (!heading || headingName(heading) === 'Quick notes') ? this.todayLogic() : null;
    let path; let line; let insert; let make;
    if (useToday) {
      const { L, plugin } = useToday;
      path = L.scratchPathFor(d, this.dailyConfig(), this.fmt()); line = L.captureLine(d, text);
      insert = (t) => L.insertQuickNote(t, line);
      make = () => plugin.newScratchpadContent(d);
    } else {
      const c = this.dailyConfig();
      path = dailyPath(c.folder, c.format, d, this.fmt());
      line = captureLine(d, text, this.settings.timestamp);
      const h = heading || this.settings.heading; const top = this.settings.newestOnTop;
      insert = (t) => insertUnderHeading(t, h, line, top);
      make = () => this.newDailyContent(d, path.split('/').pop().replace(/\.md$/, ''));
    }
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const content = insert(await make());
      try {
        await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
        await this.app.vault.create(path, content);
        return path;
      } catch (e) {
        file = this.app.vault.getAbstractFileByPath(path); // made meanwhile (Daily notes, Sync)
        if (!(file instanceof TFile)) throw e;
      }
    }
    await this.app.vault.process(file, (t) => insert(t));
    return path;
  }

  /* ---- attachments -------------------------------------------------------- */

  // files: [{ name, b64 } | { name, path }] -> saved TFiles
  async saveAttachments(files, folder) {
    const out = [];
    if (!files || !files.length) return out;
    await this.ensureFolder(folder);
    for (const f of files) {
      let bytes;
      if (f.b64) bytes = Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0));
      else if (f.path) bytes = new Uint8Array(nodeModule('fs').readFileSync(f.path));
      else continue;
      const now = new Date();
      const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
      const { base, ext } = safeFileName(f.name || `Pasted image ${stamp}`, (f.type || '').split('/')[1]);
      const p = uniquePath((x) => !!this.app.vault.getAbstractFileByPath(x), folder, base, ext);
      out.push(await this.app.vault.createBinary(p, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    }
    return out;
  }
  embedLinks(files, sourcePath) {
    if (!this.settings.attachLink) return [];
    return files.map((f) => `!${this.app.fileManager.generateMarkdownLink(f, sourcePath)}`);
  }

  /* ---- new notes (Inbox and your own folder types) -------------------------- */

  async writeFolderNote(dest, raw, files) {
    const now = new Date();
    const folder = dest.kind === 'inbox' ? this.settings.inboxFolder : dest.target;
    const { title, body } = noteParts(raw, now);
    await this.ensureFolder(folder);
    const path = uniquePath((x) => !!this.app.vault.getAbstractFileByPath(x), folder, title, 'md');
    const saved = await this.saveAttachments(files, folder);
    const links = this.embedLinks(saved, path);
    let fmExtra = {}; let start = '';
    if (dest.kind === 'inbox' && this.settings.inboxProps) fmExtra = parseProps(this.settings.inboxProps, 'Inbox', 'Settings › General');
    else if (dest.kind !== 'inbox' && dest.template && dest.template.trim()) {
      const t = dest.template.trim();
      const tplFile = !t.includes('\n') ? (this.app.vault.getAbstractFileByPath(/\.md$/i.test(t) ? t : `${t}.md`)) : null;
      if (tplFile instanceof TFile) start = renderTemplate(await this.app.vault.read(tplFile), now, this.fmt(), title);
      else {
        fmExtra = parseProps(t, dest.name, 'Settings › Destinations');
      }
    }
    const text = [body, links.join('\n')].filter(Boolean).join('\n\n');
    let content;
    if (start) content = `${start.replace(/\s+$/, '')}${text ? `\n\n${text}` : ''}\n`;
    else content = text ? `${text}\n` : '';
    const file = await this.app.vault.create(path, content);
    const created = dayOf(now);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (dest.kind === 'inbox') {
        for (const [k, v] of Object.entries(fmExtra)) if (!(k in fm)) fm[k] = v;
        fm.created = created;
        fm.captured = `${created}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      } else {
        for (const [k, v] of Object.entries(fmExtra)) if (!(k in fm)) fm[k] = v;
        if (!('created' in fm)) fm.created = created;
        if (dest.tag) {
          const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : (fm.tags ? [String(fm.tags)] : []);
          if (!tags.includes(dest.tag)) tags.push(dest.tag);
          fm.tags = tags;
        }
      }
    });
    return path;
  }

  /* ---- tasks ---------------------------------------------------------------- */

  // LifeWorld Projects' built-in task engine, when it is the chosen task source
  // (Settings › LifeWorld Projects). Same hook as LifeWorld Today and LifeWorld Planner.
  ownTaskEngine() {
    const own = partOf(this.app, 'a4-projects');
    return own && typeof own.taskApi === 'function' ? own : null;
  }
  tasksApi() {
    const own = this.ownTaskEngine();
    return own ? own.taskApi() : null;
  }
  tasksFolder() {
    const own = this.ownTaskEngine();
    if (own && own.taskApi()) { try { return own.engine.cfg().tasksFolder; } catch { /* fall through */ } }
    return '';
  }
  // Same choices as LifeWorld's task-card picker, read from LifeWorld's own projects folder:
  // every area, then open projects (not done/failed/dropped/idea/cold-storage/backlog); each group A to Z.
  projectChoices() {
    const own = this.ownTaskEngine();
    let n = null;
    try { n = own && own.engine && typeof own.engine.collectNotes === 'function' ? own.engine.collectNotes() : null; } catch { n = null; }
    if (!n) return [];
    const out = (n.areas || []).map((a) => ({ path: a.path, name: a.name, area: true }))
      .concat((n.projects || []).filter((p) => !CLOSED_PROJECT.includes(p.status)).map((p) => ({ path: p.path, name: p.name, area: false })));
    return out.sort((a, b) => b.area - a.area || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  // 'tasknotes' while LifeWorld is on (its engine may still be starting: saving then says so, and
  // the text stays); the task list note when LifeWorld is off or missing, or picked in Settings.
  // LifeWorld switched on with a task part on, or Obsidian still opening (plugins not all loaded yet).
  lifeWorldOn() {
    const p = this.app.plugins;
    if (!(p && p.enabledPlugins && p.enabledPlugins.has('lifeworld'))) return false;
    const lw = p.plugins && p.plugins.lifeworld;
    // Loaded: its task engine runs while Today, the Planner or Projects is on (LifeWorld's own wanted()).
    if (lw) return typeof lw.wanted === 'function' ? !!lw.wanted('a4-projects') : true;
    return !(this.app.workspace && this.app.workspace.layoutReady);
  }
  taskMode() { return this.settings.taskMode === 'tasknotes' && (this.tasksApi() || this.lifeWorldOn()) ? 'tasknotes' : 'list'; }
  live() { return Object.assign({}, this.settings, { taskMode: this.taskMode() }); }
  // The priority a task gets when none is typed (the "Adds:" line leaves it
  // out): LifeWorld Projects' engine setting when it is the task source.
  defaultPriority() {
    const own = this.ownTaskEngine();
    try { if (own && own.taskApi()) return own.engine.cfg().defaultPriority || 'normal'; } catch { /* fall through */ }
    return 'normal';
  }
  // The orange "Adds:" line for the panel (Task, task notes mode only).
  taskPreview(m) {
    if (this.taskMode() !== 'tasknotes' || !taskText(m.text).title) return null;
    const { r, typed, today } = taskWords(m.text, Object.assign({}, m.task || {}, { day: m.day }), new Date());
    const p = m.task && m.task.project ? String(m.task.project).replace(/\.md$/, '').split('/').pop() : null;
    return { chips: quickAddChips(r, today, p, this.defaultPriority()), typed };
  }
  // planned_order values already in a day's half (same reading as Today/Planner).
  // half null: tasks with no half; timed tasks (a time on Due) are left out, as in LifeWorld Projects.
  laneOrders(day, half) {
    const folder = this.tasksFolder();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (folder && !f.path.startsWith(`${folder}/`)) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
      if (!fm) continue;
      const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
      if (!tags.includes('task') || fm.recurrence) continue;
      const due = fm.due ? String(fm.due).slice(0, 10) : '';
      const pd = due || (fm.planned_day ? String(fm.planned_day).slice(0, 10) : '');
      if (half === null && (fm.planned_half === 'am' || fm.planned_half === 'pm' || /T\d{2}:\d{2}/.test(String(fm.due || '')))) continue;
      const h = fm.planned_half === 'pm' ? 'pm' : 'am';
      if (pd === day && (half === null || h === half) && Number.isFinite(Number(fm.planned_order))) out.push(Number(fm.planned_order));
    }
    return out;
  }
  async writeTask(raw, opts, files) {
    const now = new Date();
    const { title, rest } = taskText(raw);
    if (!title) throw userError('Type what needs doing first.');
    const plan = taskPlan(opts, now);
    if (this.taskMode() === 'list') {
      const p = this.settings.taskListNote;
      const saved = await this.saveAttachments(files, this.settings.attachFolder);
      const extra = [rest ? cleanCapture(rest) : '', ...this.embedLinks(saved, p)].filter(Boolean).join(' ');
      const line = taskListLine(extra ? `${title} ${extra}` : title, plan.due);
      let f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) { await this.ensureFolder(p.split('/').slice(0, -1).join('/')); f = await this.app.vault.create(p, `${line}\n`); return p; }
      await this.app.vault.process(f, (t) => `${t.replace(/\s+$/, '')}${t.trim() ? '\n' : ''}${line}\n`);
      return p;
    }
    const api = this.tasksApi();
    if (!api) throw userError('LifeWorld is still starting. Try again in a moment; your text is still here.');
    // Same fields as LifeWorld Projects' quick add (quickAddPlan): typed words, or the buttons.
    const { r, today } = taskWords(raw, opts, now);
    if (!r.title) throw userError('Type what needs doing, not only when.');
    const { input, lane } = quickAddPlan(r, today);
    const cf = input.customFrontmatter; delete input.customFrontmatter;
    if (lane) cf.planned_order = nextOrder(this.laneOrders(lane.day, lane.half));
    const saved = await this.saveAttachments(files, this.settings.attachFolder);
    const details = [rest, ...this.embedLinks(saved, `${this.tasksFolder()}/${input.title}.md`)].filter(Boolean).join('\n\n');
    const project = opts && opts.project ? String(opts.project).replace(/\.md$/, '') : '';
    if (project) input.projects = [`[[${project}]]`];
    if (details) input.details = details;
    const info = await api.tasks.create(input, { source: PLUGIN_ID });
    const path = info && (info.path || info.id);
    const file = path && this.app.vault.getAbstractFileByPath(path);
    if (Object.keys(cf).length && file instanceof TFile) await this.app.fileManager.processFrontMatter(file, (fm) => { Object.assign(fm, cf); });
    return path;
  }

  /* ---- saving --------------------------------------------------------------- */

  // msg: { text, dest, day, task: { when, half, project }, files }
  async save(msg) {
    const dests = destinations(this.live());
    const dest = dests.find((d) => d.id === msg.dest) || dests[0];
    const raw = String(msg.text || '');
    const files = Array.isArray(msg.files) ? msg.files : [];
    if (!raw.trim() && !files.length) throw userError('Nothing to save yet.');
    let path;
    if (dest.kind === 'daily' || dest.kind === 'heading') {
      const saved = await this.saveAttachments(files, this.settings.attachFolder);
      const c = this.dailyConfig();
      const notePath = dailyPath(c.folder, c.format, isDayStr(msg.day) ? atDay(msg.day, new Date()) : new Date(), this.fmt());
      const tag = dest.kind === 'heading' && dest.tag ? ` #${dest.tag}` : '';
      const text = [cleanCapture(raw) + tag, ...this.embedLinks(saved, notePath)].filter(Boolean).join(' ').trim();
      path = await this.writeDailyLine(text, msg.day, dest.kind === 'heading' ? dest.target : null);
    } else if (dest.kind === 'task') {
      path = await this.writeTask(raw, Object.assign({}, msg.task || {}, { day: msg.day }), files);
    } else {
      path = await this.writeFolderNote(dest, raw, files);
    }
    if (this.settings.rememberLast && this.settings.lastDest !== dest.id) { this.settings.lastDest = dest.id; await this.saveSettings(); }
    return { path, label: dest.kind === 'task' ? 'task added' : 'saved' };
  }

  /* ---- the capture panel ---------------------------------------------------- */

  panelState() {
    const s = this.live();
    const now = new Date();
    return {
      dests: destinations(s).map((d) => ({ id: d.id, icon: d.icon, name: d.name, kind: d.kind, key: d.key, builtin: d.builtin, ph: d.ph })),
      cur: this.curDest || startDest(s),
      remember: s.rememberLast,
      today: dayOf(now),
      accent: ACCENT,
      task: { when: s.taskWhen, half: halfDefault(s.taskHalf, now), project: s.taskProject, mode: s.taskMode, projects: s.taskMode === 'tasknotes' ? this.projectChoices() : [], ok: s.taskMode === 'list' || !!this.tasksApi() },
    };
  }
  pushState() {
    if (this.panel && !this.panel.isDestroyed() && this.panelReady) this.panel.webContents.send(IPC, JSON.stringify({ t: 'state', state: this.panelState() }));
  }
  ensurePanel() {
    const R = this.bridge;
    if (this.panel && !this.panel.isDestroyed()) return this.panel;
    const mac = process.platform === 'darwin';
    const opts = {
      width: PANEL_W, height: 240, show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, transparent: true, hasShadow: false, backgroundColor: '#00000000',
      title: 'LifeWorld Capture', acceptFirstMouse: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, spellcheck: true },
    };
    if (mac) opts.type = 'panel'; // NSPanel: can take typing on top of other apps, even full-screen ones
    const w = new R.BrowserWindow(opts);
    // skipTransformProcessType: without it Electron turns the WHOLE Obsidian app
    // into a background-style app (no menu bar, no Dock icon) to do this, and on
    // one Mac it never turned back (found 2026-10-04). The NSPanel type is
    // what lets the box show over full-screen apps.
    try { if (mac) w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* ignore */ }
    this.keepRegularApp();
    this.panel = w; this.panelReady = false;
    w.webContents.on('ipc-message', (_e, ch, data) => { if (ch === IPC) this.onPanelMessage(data); });
    w.on('closed', () => { if (this.panel === w) { this.panel = null; this.panelOpen = false; this.panelReady = false; this.restoreFocusable(); } });
    w.loadURL(`data:text/html;charset=utf-8;base64,${btoa(unescape(encodeURIComponent(panelHtml())))}`);
    return w;
  }
  // Obsidian must stay a normal app (menu bar + Dock). If anything left it as a
  // background-style app, put it back.
  keepRegularApp() {
    if (process.platform !== 'darwin') return;
    try {
      const A = this.bridge.app;
      if (A.dock && !A.dock.isVisible()) { A.setActivationPolicy('regular'); A.dock.show(); }
    } catch { /* ignore */ }
  }
  positionPanel() {
    const R = this.bridge; const w = this.panel;
    let b = null;
    try { const raw = this.tray && !this.tray.isDestroyed() ? this.tray.getBounds() : null; if (raw && raw.width > 0 && raw.x >= 0 && raw.y >= 0 && raw.y < 80) b = raw; } catch { b = null; }
    let disp;
    try { disp = b ? R.screen.getDisplayNearestPoint({ x: b.x, y: b.y }) : R.screen.getDisplayNearestPoint(R.screen.getCursorScreenPoint()); } catch { disp = R.screen.getPrimaryDisplay(); }
    const wa = disp.workArea;
    let x = b ? Math.round(b.x + b.width / 2 - PANEL_W / 2) : wa.x + wa.width - PANEL_W - 12;
    x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - PANEL_W - 8));
    const y = b ? b.y + b.height + 2 : wa.y + 4;
    w.setPosition(x, y, false);
  }
  togglePanel() {
    if (this.panelOpen) { this.hidePanel(true); return; }
    if (this.pendingOpen) return;
    if (Date.now() - (this.lastHideAt || 0) < 300) return; // the click on the icon itself just closed it
    this.openPanel();
  }
  openPanel() {
    if (!this.bridge) return;
    const w = this.ensurePanel();
    // Never show before the page is ready: keys typed into an unloaded page are lost.
    if (!this.panelReady) { this.pendingOpen = true; return; }
    this.pendingOpen = false;
    this.curDest = this.curDest || startDest(this.settings);
    if (!this.panelOpen && !this.settings.rememberLast) this.curDest = 'daily';
    this.pushState();
    this.positionPanel();
    this.prevApp = this.frontApp();
    this.panelOpen = true; this.openedAt = Date.now();
    w.show(); w.focus(); w.webContents.focus();
    if (this.panelReady) w.webContents.send(IPC, JSON.stringify({ t: 'shown' }));
    // Activation settles late (and later from a full-screen Space): re-claim
    // the keyboard a few times, the way Lifeworld's panel does. If the panel
    // can't become the key window on its own, fall back to Lifeworld's way:
    // make Obsidian's own windows unfocusable for the moment and activate.
    this.focusTimers = [60, 200, 400, 650, 900].map((ms) => window.setTimeout(() => {
      if (!this.panelOpen || !this.panel || this.panel.isDestroyed()) return;
      if (!this.panel.isFocused()) {
        if (ms >= 200 && !this.unfocused.length) this.lockObsidianWindows();
        this.panel.focus(); this.panel.webContents.focus();
      }
    }, ms));
  }
  lockObsidianWindows() {
    const R = this.bridge;
    try {
      for (const bw of R.BrowserWindow.getAllWindows()) {
        if (this.panel && bw.id === this.panel.id) continue;
        if (bw.isFocusable()) { bw.setFocusable(false); this.unfocused.push(bw); }
      }
      R.app.focus({ steal: true });
    } catch { /* ignore */ }
  }
  restoreFocusable() {
    for (const bw of this.unfocused || []) { try { if (!bw.isDestroyed()) bw.setFocusable(true); } catch { /* gone */ } }
    this.unfocused = [];
  }
  hidePanel(restoreApp) {
    (this.focusTimers || []).forEach((t) => window.clearTimeout(t)); this.focusTimers = [];
    const back = restoreApp && this.unfocused.length ? this.prevApp : null;
    if (this.panelOpen) this.lastHideAt = Date.now();
    this.panelOpen = false;
    try { if (this.panel && !this.panel.isDestroyed()) this.panel.hide(); } catch { /* ignore */ }
    this.restoreFocusable();
    this.prevApp = null;
    if (back) { try { nodeModule('child_process').execFile('open', ['-b', back], () => {}); } catch { /* ignore */ } }
  }
  // The app the user is in (Mac), so focus can go back to it.
  frontApp() {
    if (process.platform !== 'darwin') return null;
    try {
      const cp = nodeModule('child_process');
      const asn = cp.execFileSync('lsappinfo', ['front'], { timeout: 500 }).toString().trim();
      const m = /bundleID="([^"]+)"/.exec(cp.execFileSync('lsappinfo', ['info', '-only', 'bundleid', asn], { timeout: 500 }).toString());
      return m && m[1] !== 'md.obsidian' ? m[1] : null;
    } catch { return null; }
  }
  async onPanelMessage(data) {
    let m; try { m = JSON.parse(String(data)); } catch { return; }
    const w = this.panel;
    const reply = (o) => { if (w && !w.isDestroyed()) w.webContents.send(IPC, JSON.stringify(o)); };
    switch (m.t) {
      case 'ready': this.panelReady = true; this.pushState(); if (this.pendingOpen) this.openPanel(); else if (this.panelOpen) reply({ t: 'shown' }); break;
      case 'size': if (w && !w.isDestroyed()) { const h = Math.max(120, Math.min(900, Math.round(Number(m.h) || 240))); const [cw, ch] = w.getSize(); if (ch !== h || cw !== PANEL_W) w.setSize(PANEL_W, h, false); } break;
      case 'dest': this.curDest = String(m.id || 'daily'); if (this.settings.rememberLast && this.settings.lastDest !== this.curDest) { this.settings.lastDest = this.curDest; await this.saveSettings(); } break;
      case 'remember': this.settings.rememberLast = !!m.on; if (m.on) this.settings.lastDest = this.curDest || 'daily'; await this.saveSettings(); this.pushState(); break;
      case 'close': this.hidePanel(true); break;
      case 'blur': if (!this.dialogOpen && this.panelOpen && Date.now() - (this.openedAt || 0) > 700) this.hidePanel(false); break;
      case 'edit-dests': this.openSettings('dests'); break;
      case 'pick-files': await this.pickFiles(reply); break;
      case 'preview': { let p = null; try { p = this.taskPreview(m); } catch (e) { console.error('[lifeworld-capture] preview failed', e); } reply({ t: 'preview', seq: m.seq, pv: p }); break; }
      case 'save': {
        if (this.saving) return;
        this.saving = true;
        try { const r = await this.save(m); reply({ t: 'saved', ok: true, label: r.label, path: r.path, seq: m.seq }); }
        catch (e) { if (!(e && e.user)) console.error('[lifeworld-capture] save failed', e); reply({ t: 'saved', ok: false, msg: (e && e.message) || 'Could not save. Nothing was lost; try again.', seq: m.seq }); }
        finally { this.saving = false; }
        break;
      }
      default: break;
    }
  }
  async pickFiles(reply) {
    const R = this.bridge;
    if (!R.dialog) return;
    this.dialogOpen = true;
    try {
      const r = await R.dialog.showOpenDialog(this.panel, { title: 'Attach a picture', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Pictures', extensions: IMAGE_EXT }, { name: 'All files', extensions: ['*'] }] });
      if (r && !r.canceled && r.filePaths && r.filePaths.length) reply({ t: 'files', files: r.filePaths.map((p) => ({ name: p.split(/[\\/]/).pop(), path: p })) });
    } catch { /* ignore */ }
    finally {
      this.dialogOpen = false;
      if (this.panel && !this.panel.isDestroyed() && this.panelOpen) { this.panel.focus(); this.panel.webContents.focus(); }
    }
  }
}

/* ========================================================================== *
 * Settings: General, Daily Note, Destinations, Tasks, Attachments
 * ========================================================================== */

const TABS = [['general', 'General'], ['daily', 'Daily Note'], ['dests', 'Destinations'], ['tasks', 'Tasks'], ['attach', 'Attachments']];

class MenubarSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this.editing = null; this.recording = false; }
  // Empty list = Obsidian keeps drawing this tabbed page with display(); declared for the settings-tab check.
  getSettingDefinitions() { return []; }
  hide() { this.stopRecording(); this.editing = null; if (super.hide) super.hide(); }
  async save(redraw) { await this.plugin.saveSettings(); if (redraw !== false) this.display(); }
  display() {
    const { containerEl } = this;
    const tab = this.plugin.settingsTab || 'general';
    containerEl.empty();
    containerEl.addClass('lwc-settings');
    const bar = containerEl.createDiv({ cls: 'lwc-tabs' });
    for (const [id, label] of TABS) {
      const b = bar.createEl('div', { cls: `lwc-tab${id === tab ? ' is-on' : ''}`, text: label, attr: { role: 'tab', tabindex: '0', 'data-tab': id } });
      const go = () => { this.plugin.settingsTab = id; this.editing = null; this.stopRecording(); this.display(); };
      b.addEventListener('click', go);
      b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    }
    const body = containerEl.createDiv({ cls: 'lwc-body', attr: { 'data-tab': tab } });
    if (this.plugin.bridgeMissing) body.createDiv({ cls: 'lwc-warn', text: "This Obsidian has no access to the menu bar, so the icon and the shortcut are off. Settings still save." });
    ({ general: () => this.general(body), daily: () => this.daily(body), dests: () => this.dests(body), tasks: () => this.tasks(body), attach: () => this.attach(body) })[tab]();
  }

  general(el) {
    const s = this.plugin.settings;
    new Setting(el).setName('Show the menu bar icon')
      .setDesc('Computers only. The icon, the shortcut and the capture box work only while Obsidian is open (minimized is fine).')
      .addToggle((t) => t.setValue(s.showIcon).onChange(async (v) => { s.showIcon = v; await this.save(false); this.plugin.applyIcon(); }));
    const sc = new Setting(el).setName('Global shortcut');
    sc.settingEl.addClass('lwc-shortcut');
    const kbd = sc.controlEl.createEl('kbd', { cls: 'lwc-kbd', text: s.shortcut ? accelSymbols(s.shortcut) : 'None' });
    sc.addButton((b) => { this.recBtn = b; b.setButtonText('Record…').onClick(() => (this.recording ? this.stopRecording() : this.startRecording(kbd))); });
    sc.addExtraButton((b) => b.setIcon('x').setTooltip('No shortcut').onClick(async () => { s.shortcut = ''; await this.save(false); this.plugin.applyShortcut(); this.display(); }));
    this.statusEl = sc.descEl.createDiv({ cls: 'lwc-status' });
    this.renderShortcutStatus();
    new Setting(el).setName('Capture panel').setDesc('Remember last used destination. When off, it always opens on the Daily Note.')
      .addToggle((t) => t.setValue(s.rememberLast).onChange(async (v) => { s.rememberLast = v; if (!v) this.plugin.curDest = 'daily'; await this.save(false); this.plugin.pushState(); }));
    new Setting(el).setName('Inbox folder (⌘I)').setDesc('A new note per capture; the first line becomes the title. The folder is made on the first capture.')
      .addText((t) => t.setValue(s.inboxFolder).onChange(async (v) => { s.inboxFolder = v; await this.save(false); }));
    new Setting(el).setName('Properties for a new inbox note').setDesc('Optional, one per line, like type: capture. Created and captured are always added.')
      .addTextArea((t) => { t.inputEl.rows = 2; t.setPlaceholder('type: capture').setValue(s.inboxProps).onChange(async (v) => { s.inboxProps = v; await this.save(false); }); });
  }
  renderShortcutStatus(msg, bad) {
    const el = this.statusEl; if (!el) return;
    el.empty(); el.removeClass('is-ok', 'is-bad');
    const p = this.plugin; const s = p.settings;
    let text; let ok = false;
    if (msg) text = msg;
    else if (p.bridgeMissing) text = 'Not available in this Obsidian.';
    else if (!s.shortcut) text = 'No shortcut. The menu bar icon still opens the capture box.';
    else if (p.shortcutState === 'ok') { ok = true; text = 'Works from any app.'; }
    else if (p.shortcutState === 'taken') text = `${accelSymbols(s.shortcut)}: ${TAKEN_MSG} The menu bar icon still works meanwhile.`;
    else text = 'Starts when Obsidian has finished opening.';
    el.setText(text); el.addClass(ok && !bad ? 'is-ok' : (bad || p.shortcutState === 'taken' ? 'is-bad' : 'is-plain'));
  }
  startRecording(kbd) {
    this.recording = true; this.kbdEl = kbd;
    kbd.setText('Press keys…'); kbd.addClass('is-rec');
    if (this.recBtn) this.recBtn.setButtonText('Cancel');
    this._rec = async (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { this.stopRecording(); return; }
      const a = accelFromEvent(e);
      const chk = checkAccel(a || 'x');
      if (!a || !chk.ok) { this.renderShortcutStatus(chk.reason || 'That key can’t be used.', true); return; }
      this.stopRecording();
      // Ask macOS: keep the new one only if it can really be registered.
      const prev = this.plugin.settings.shortcut;
      this.plugin.settings.shortcut = a;
      this.plugin.applyShortcut();
      if (this.plugin.bridge && this.plugin.shortcutState !== 'ok') {
        this.plugin.settings.shortcut = prev;
        this.plugin.applyShortcut();
        if (this.kbdEl) this.kbdEl.setText(prev ? accelSymbols(prev) : 'None');
        this.renderShortcutStatus(`${accelSymbols(a)}: ${TAKEN_MSG}`, true);
        return;
      }
      await this.save(false);
      if (this.kbdEl) this.kbdEl.setText(accelSymbols(a));
      this.renderShortcutStatus();
    };
    window.addEventListener('keydown', this._rec, true);
  }
  stopRecording() {
    if (this._rec) window.removeEventListener('keydown', this._rec, true);
    this._rec = null;
    if (this.recording && this.kbdEl) { const s = this.plugin.settings; this.kbdEl.setText(s.shortcut ? accelSymbols(s.shortcut) : 'None'); this.kbdEl.removeClass('is-rec'); }
    if (this.recBtn) this.recBtn.setButtonText('Record…');
    this.recording = false;
  }

  daily(el) {
    const s = this.plugin.settings; const c = this.plugin.dailyConfig();
    let dn = {}; try { dn = this.app.internalPlugins.getPluginById('daily-notes').instance.options || {}; } catch { dn = {}; }
    const set = new Setting(el).setName('Daily notes').setDesc("Read from Obsidian's daily notes settings; change only to override.");
    set.addText((t) => { t.inputEl.addClass('lwc-folder'); t.setPlaceholder(dn.folder || '(vault root)').setValue(s.dailyFolder).onChange(async (v) => { s.dailyFolder = v; await this.save(false); }); });
    set.addText((t) => { t.inputEl.addClass('lwc-format'); t.setPlaceholder(dn.format || 'YYYY-MM-DD').setValue(s.dailyFormat).onChange(async (v) => { s.dailyFormat = v; await this.save(false); }); });
    set.controlEl.prepend(createSpan({ cls: 'lwc-lbl', text: 'Folder' }));
    set.controlEl.insertBefore(createSpan({ cls: 'lwc-lbl', text: 'Name' }), set.controlEl.lastElementChild);
    new Setting(el).setName('Template for a new day').setDesc(`Used when the day's note doesn't exist yet. Now: ${c.template || 'none'}.`)
      .addText((t) => { t.inputEl.addClass('lwc-wide'); t.setPlaceholder(dn.template || '').setValue(s.dailyTemplate).onChange(async (v) => { s.dailyTemplate = v; await this.save(false); }); });
    new Setting(el).setName('Heading in the daily note').setDesc("Where Daily Note captures go. Same as the Today page's capture box.")
      .addText((t) => t.setValue(s.heading).onChange(async (v) => { s.heading = v; await this.save(false); this.plugin.pushState(); }));
    new Setting(el).setName('Time stamp (HH:MM)').addToggle((t) => t.setValue(s.timestamp).onChange(async (v) => { s.timestamp = v; await this.save(false); }));
    new Setting(el).setName('Newest on top').addToggle((t) => t.setValue(s.newestOnTop).onChange(async (v) => { s.newestOnTop = v; await this.save(false); }));
  }

  dests(el) {
    const p = this.plugin; const s = p.settings;
    const intro = new Setting(el).setName('Destinations in the capture box')
      .setDesc("Daily Note, Inbox and Task are built in (Daily Note's heading is set in the Daily Note tab). Add your own note types: each makes a new note in its folder, or adds a line under a heading in the daily note. The order here is the order in the picker.");
    intro.settingEl.addClass('lwc-intro');
    const table = el.createEl('table', { cls: 'lwc-dtab' });
    const hr = table.createEl('tr');
    ['', '', 'Name', 'Where it goes', 'Key', ''].forEach((h) => hr.createEl('th', { text: h }));
    for (const d of destinations(s)) {
      const tr = table.createEl('tr', { attr: { 'data-id': d.id } });
      const mv = tr.createEl('td', { cls: 'lwc-mvcell' });
      if (d.builtin) mv.createSpan({ cls: 'lwc-lock', text: '🔒', attr: { title: 'Built in' } });
      else {
        const up = mv.createEl('span', { cls: 'lwc-mv', text: '▲', attr: { role: 'button', tabindex: '0', title: 'Move up', 'data-mv': '-1' } });
        const dn = mv.createEl('span', { cls: 'lwc-mv', text: '▼', attr: { role: 'button', tabindex: '0', title: 'Move down', 'data-mv': '1' } });
        for (const [b, delta] of [[up, -1], [dn, 1]]) b.addEventListener('click', async () => { s.custom = moveCustom(s.custom, d.id, delta); await this.save(); p.pushState(); });
      }
      tr.createEl('td', { text: d.icon });
      tr.createEl('td').createEl('b', { text: d.name });
      tr.createEl('td', { text: whereText(d) + (d.tag ? ` · #${d.tag}` : '') });
      tr.createEl('td', { text: d.key || '' });
      const act = tr.createEl('td', { cls: 'lwc-act' });
      if (!d.builtin) {
        const eb = act.createEl('button', { text: 'Edit', cls: 'lwc-ed' });
        eb.addEventListener('click', () => { this.editing = d.id; this.display(); });
        const db = act.createEl('button', { text: 'Delete', cls: 'lwc-del' });
        db.addEventListener('click', async () => { s.custom = s.custom.filter((c) => c.id !== d.id); if (p.curDest === d.id) p.curDest = 'daily'; if (s.lastDest === d.id) s.lastDest = 'daily'; this.editing = null; await this.save(); p.pushState(); });
      }
    }
    const add = el.createDiv({ cls: 'lwc-addrow' }).createEl('button', { text: '+ Add destination', cls: 'lwc-add' });
    add.addEventListener('click', () => { this.editing = 'new'; this.display(); });
    if (this.editing) this.destForm(el);
  }
  destForm(el) {
    const p = this.plugin; const s = p.settings;
    const cur = this.editing === 'new' ? { id: '', icon: '📝', name: '', kind: 'folder', target: '', tag: '', key: '', template: '' } : s.custom.find((c) => c.id === this.editing);
    if (!cur) { this.editing = null; return; }
    const v = Object.assign({}, cur);
    const form = el.createDiv({ cls: 'lwc-edform' });
    form.createDiv({ cls: 'lwc-edtitle', text: this.editing === 'new' ? 'New destination' : `Edit ${cur.name}` });
    const grid = form.createDiv({ cls: 'lwc-grid2' });
    const field = (label, cls) => { const l = grid.createEl('label', { cls }); l.createSpan({ text: label }); return l; };
    const inp = (l, key, ph, w) => { const i = l.createEl('input', { type: 'text', attr: { placeholder: ph, 'data-f': key } }); i.value = v[key] || ''; if (w) i.style.width = w; i.addEventListener('input', () => { v[key] = i.value; }); return i; };
    inp(field('Icon'), 'icon', '📝', '56px');
    inp(field('Name'), 'name', 'e.g. Meeting note');
    const kindL = field('Goes to');
    const sel = kindL.createEl('select', { attr: { 'data-f': 'kind' } });
    sel.createEl('option', { value: 'folder', text: 'A new note in a folder' });
    sel.createEl('option', { value: 'heading', text: 'A heading in the daily note' });
    sel.value = v.kind;
    const tL = field(v.kind === 'heading' ? 'Heading in the daily note' : 'Folder for the new note');
    const tI = inp(tL, 'target', v.kind === 'heading' ? 'e.g. Ideas' : 'e.g. 03 WiP/Meetings');
    sel.addEventListener('change', () => { v.kind = sel.value; tL.firstChild.setText(v.kind === 'heading' ? 'Heading in the daily note' : 'Folder for the new note'); tI.placeholder = v.kind === 'heading' ? 'e.g. Ideas' : 'e.g. 03 WiP/Meetings'; tplL.toggle(v.kind !== 'heading'); });
    inp(field('Tag (optional)'), 'tag', '#idea');
    inp(field('Shortcut'), 'key', '⌘M', '70px');
    const tplL = form.createEl('label', { cls: 'lwc-tpl' });
    tplL.createSpan({ text: 'Template or frontmatter for a new note (optional): a note path, or lines like type: meeting' });
    const ta = tplL.createEl('textarea', { attr: { rows: '3', placeholder: 'type: meeting\nattendees: []', 'data-f': 'template' } });
    ta.value = v.template || ''; ta.addEventListener('input', () => { v.template = ta.value; });
    tplL.toggle(v.kind !== 'heading');
    const err = form.createDiv({ cls: 'lwc-err' });
    const btns = form.createDiv({ cls: 'lwc-btns' });
    btns.createEl('button', { text: 'Cancel', cls: 'lwc-cancel' }).addEventListener('click', () => { this.editing = null; this.display(); });
    const sv = btns.createEl('button', { text: 'Save', cls: 'mod-cta lwc-save' });
    sv.addEventListener('click', async () => {
      const problem = checkCustom(v, s.custom);
      if (problem) { err.setText(problem); return; }
      if (v.kind === 'folder' && v.template && v.template.trim() && v.template.includes(':')) {
        try { const y = obsidian.parseYaml(v.template.replace(/^---\s*\n/, '').replace(/\n---\s*$/, '')); if (!y || typeof y !== 'object' || Array.isArray(y)) throw new Error('x'); }
        catch { err.setText("The frontmatter lines aren't valid (use one 'name: value' per line)."); return; }
      }
      const item = { id: this.editing === 'new' ? `c${Date.now().toString(36)}` : cur.id, icon: v.icon, name: v.name, kind: v.kind, target: v.target, tag: v.tag, key: normDestKey(v.key) || '', template: v.kind === 'heading' ? '' : v.template };
      if (this.editing === 'new') s.custom = s.custom.concat([item]); else s.custom = s.custom.map((c) => (c.id === cur.id ? item : c));
      this.editing = null;
      await this.save();
      p.pushState();
    });
  }

  tasks(el) {
    const p = this.plugin; const s = p.settings;
    const api = p.tasksApi();
    const mode = p.taskMode();
    const w = new Setting(el).setName('Where tasks go')
      .addDropdown((d) => {
        if (api) d.addOption('tasknotes', 'LifeWorld (one note per task)');
        d.addOption('list', 'One task list note (Tasks plugin format)').setValue(mode).onChange(async (v) => { s.taskMode = v; await this.save(); p.pushState(); });
        if (!api) d.setDisabled(true);
      });
    const st = w.descEl.createDiv({ cls: 'lwc-status' });
    if (!api) { st.setText('Install LifeWorld to save each task as its own note that shows on a Today page and in a Planner.'); st.addClass('is-plain'); }
    else if (mode === 'list') { st.setText(`Each task is a '- [ ]' line at the end of ${s.taskListNote}.`); st.addClass('is-plain'); }
    else { st.setText(`LifeWorld found: tasks folder ${p.tasksFolder() || '(vault root)'}. New tasks show on Today and in the Planner.`); st.addClass('is-ok'); }
    if (mode === 'list') new Setting(el).setName('Task list note').addText((t) => t.setValue(s.taskListNote).onChange(async (v) => { s.taskListNote = v; await this.save(false); }));
    const nd = new Setting(el).setName('New task defaults').setDesc('The calendar button in the capture box sets the Due property instead.');
    nd.controlEl.createSpan({ cls: 'lwc-lbl', text: 'When' });
    nd.addDropdown((d) => d.addOption('today', 'Today').addOption('tomorrow', 'Tomorrow').addOption('none', 'No date').setValue(s.taskWhen).onChange(async (v) => { s.taskWhen = v; await this.save(false); p.pushState(); }));
    if (mode === 'tasknotes') nd.controlEl.createSpan({ cls: 'lwc-lbl', text: 'Half' });
    if (mode === 'tasknotes') nd.addDropdown((d) => d.addOption('auto', 'Morning before 1 PM, else afternoon').addOption('am', 'Morning').addOption('pm', 'Afternoon').setValue(s.taskHalf).onChange(async (v) => { s.taskHalf = v; await this.save(false); p.pushState(); }));
    if (mode === 'tasknotes') {
      nd.controlEl.createSpan({ cls: 'lwc-lbl', text: 'Project' });
      nd.addDropdown((d) => { d.addOption('', 'None'); for (const pr of p.projectChoices()) d.addOption(pr.path, pr.name); d.setValue(s.taskProject).onChange(async (v) => { s.taskProject = v; await this.save(false); p.pushState(); }); });
    }
  }

  attach(el) {
    const s = this.plugin.settings;
    new Setting(el).setName('Pictures')
      .setDesc('Paste, drop or click the paperclip. Pictures for the Daily Note, headings and tasks go to this folder; a new note keeps its pictures in its own folder.')
      .addText((t) => t.setValue(s.attachFolder).onChange(async (v) => { s.attachFolder = v; await this.save(false); }));
    new Setting(el).setName('Link the picture in the capture').addToggle((t) => t.setValue(s.attachLink).onChange(async (v) => { s.attachLink = v; await this.save(false); }));
  }
}

/* ========================================================================== *
 * The capture panel page (a local page in its own small window; no links,
 * no remote content). Talks to the plugin over one IPC channel.
 * ========================================================================== */

function panelHtml() {
  const font = typeof LWC_CAVEAT_WOFF2 === 'string' && LWC_CAVEAT_WOFF2 ? `@font-face { font-family: 'LWC Caveat'; src: url(data:font/woff2;base64,${LWC_CAVEAT_WOFF2}) format('woff2'); font-weight: 400 700; }` : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>LifeWorld Capture</title><style>${font}${PANEL_CSS}</style></head><body>${PANEL_BODY}<script>${PANEL_JS}</script></body></html>`;
}

const PANEL_CSS = String.raw`
:root { --acc: #d43f16; --panel: rgba(248,248,248,.97); --text: #1d1d1f; --muted: #6e6e73; --border: rgba(0,0,0,.12); --field: #ffffff; --menu: rgba(240,240,240,.98); --hi: #0a64d8; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --acc: #ff5a2d; --panel: rgba(42,42,44,.97); --text: #f5f5f7; --muted: #a1a1a6; --border: rgba(255,255,255,.14); --field: #1c1c1e; --menu: rgba(44,44,46,.98); --bad: #ff8a80; } }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
html { overflow: hidden; } body { overflow: visible; }
body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--text); padding: 4px 6px 30px; -webkit-user-select: none; user-select: none; }
.panel { position: relative; width: 520px; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: 0 10px 26px rgba(0,0,0,.28); }
.p-body { position: relative; padding: 14px 16px 10px 52px; }
.p-mark { position: absolute; left: 14px; top: 13px; width: 26px; height: 26px; border-radius: 7px; background: var(--acc); color: #fff; display: grid; place-items: center; }
.p-mark svg { width: 15px; height: 15px; }
textarea { width: 100%; height: 108px; resize: none; border: 0; background: transparent; color: var(--text); font: 17px/1.45 -apple-system, system-ui, sans-serif; outline: none; padding: 2px 0; -webkit-user-select: text; user-select: text; }
textarea::placeholder { color: var(--muted); }
.p-tools { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.tool { width: 30px; height: 28px; display: grid; place-items: center; border-radius: 6px; color: var(--muted); cursor: pointer; border: 0; background: transparent; padding: 0; }
.tool:hover, .tool.on { background: rgba(127,127,127,.18); color: var(--text); }
.tool:disabled { opacity: .35; cursor: default; background: transparent; }
.tool svg { width: 17px; height: 17px; }
.chipline { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; border: 1px solid var(--border); border-radius: 999px; padding: 1px 9px; color: var(--muted); }
.chip.acc { color: var(--acc); border-color: var(--acc); }
.pv { align-items: center; }
.pv .hint { font-size: 11.5px; color: var(--muted); }
.chip.got { color: var(--text); border-color: var(--acc); background: color-mix(in srgb, var(--acc) 12%, transparent); }
.mini.off button.on { background: transparent; color: var(--muted); box-shadow: inset 0 0 0 1px var(--border); }
.chip .x { cursor: pointer; opacity: .7; } .chip .x:hover { opacity: 1; }
.p-foot { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-top: 1px solid var(--border); background: rgba(127,127,127,.06); border-radius: 0 0 14px 14px; }
.dest { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; cursor: pointer; padding: 3px 6px; border-radius: 6px; white-space: nowrap; max-width: 250px; overflow: hidden; text-overflow: ellipsis; }
.dest:hover, .dest.on { background: rgba(127,127,127,.15); }
.btn { border: 1px solid var(--border); background: rgba(127,127,127,.15); color: var(--text); border-radius: 999px; padding: 5px 16px; font: 500 13px system-ui; cursor: pointer; }
.btn.primary { background: #3d6a8a; border-color: #3d6a8a; color: #fff; font-weight: 600; }
.btn.primary:disabled { opacity: .45; cursor: default; }
.grow { flex: 1; }
.saved { font: 600 18px 'LWC Caveat', 'Caveat', cursive; color: var(--acc); opacity: 0; transition: opacity .2s; white-space: nowrap; }
.saved.show { opacity: 1; }
.saved.bad { font: 500 12px system-ui; color: var(--bad); white-space: normal; max-width: 220px; line-height: 1.3; }
.picker { position: absolute; top: calc(100% - 8px); left: 10px; width: 280px; z-index: 5; background: var(--menu); border: 1px solid var(--border); border-radius: 9px; padding: 5px; box-shadow: 0 12px 30px rgba(0,0,0,.25); }
.picker .it { display: flex; justify-content: space-between; gap: 10px; padding: 5px 10px; border-radius: 5px; cursor: default; white-space: nowrap; }
.picker .it > span:first-child { overflow: hidden; text-overflow: ellipsis; }
.picker .it:hover, .picker .it.kbd { background: var(--hi); color: #fff; }
.picker .it.cur { font-weight: 700; } .picker .it .kb { color: var(--muted); } .picker .it:hover .kb, .picker .it.kbd .kb { color: #fff; }
.picker .it.dim { color: var(--muted); } .picker .it.dim:hover { color: #fff; }
.picker .sep { height: 1px; background: var(--border); margin: 4px 8px; }
.cal { position: absolute; top: calc(100% - 8px); right: 12px; width: 230px; z-index: 5; background: var(--menu); border: 1px solid var(--border); border-radius: 9px; padding: 8px; box-shadow: 0 12px 30px rgba(0,0,0,.25); font-size: 12px; }
.cal .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-top: 4px; color: var(--muted); }
.cal .nav { cursor: pointer; padding: 0 6px; border-radius: 4px; color: var(--muted); } .cal .nav:hover { background: rgba(127,127,127,.2); color: var(--text); }
.cal .grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; text-align: center; margin-top: 6px; }
.cal .grid span { padding: 4px 0; border-radius: 5px; cursor: pointer; } .cal .grid span:hover { background: rgba(127,127,127,.2); }
.cal .grid .h { color: var(--muted); cursor: default; } .cal .grid .h:hover { background: none; }
.cal .grid .today { outline: 1px solid var(--acc); } .cal .grid .sel { background: var(--acc); color: #fff; } .cal .grid .sel:hover { background: var(--acc); }
.taskopts { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
.taskopts select { font: 12.5px system-ui; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--field); color: var(--text); max-width: 200px; }
.mini { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.mini button { border: 0; background: transparent; color: var(--text); font: 12px system-ui; padding: 3px 9px; cursor: pointer; }
.mini button.on { background: var(--acc); color: #fff; }
.warn { margin-top: 6px; font-size: 12px; color: var(--bad); }
.drop .panel { outline: 2px dashed var(--acc); outline-offset: -4px; }
[hidden] { display: none !important; }
`;

const PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const PANEL_BODY = `
<div class="panel" id="panel">
  <div class="p-body">
    <span class="p-mark">${PEN}</span>
    <textarea id="cap" placeholder="What's on your mind?" spellcheck="true"></textarea>
    <div id="pv" class="chipline pv" hidden></div>
    <div id="extras"></div>
    <div class="p-tools">
      <button class="tool" id="attach" title="Attach a picture (or paste / drop one)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button>
      <button class="tool" id="calbtn" title="File into another day"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg></button>
    </div>
  </div>
  <div class="p-foot">
    <span class="dest" id="dest" role="button" tabindex="0"><span id="destlabel">Daily Note</span> ⌃⌄</span>
    <span class="grow"></span><span class="saved" id="saved">saved</span>
    <button class="btn" id="cancel">Cancel</button><button class="btn primary" id="save" disabled>Save</button>
  </div>
  <div class="picker" id="picker" hidden></div>
  <div class="cal" id="cal" hidden></div>
</div>`;

const PANEL_JS = String.raw`
(() => {
const { ipcRenderer } = require('electron');
let webUtils = null; try { webUtils = require('electron').webUtils; } catch (e) {}
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const send = (o) => ipcRenderer.send('lwc', JSON.stringify(o));
let S = null, dest = 'daily', other = null, files = [], when = 'today', half = 'am', project = '', calMonth = null, seq = 0, busy = false, savedTimer = null, pvSeq = 0, typed = false;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const pad = (n) => String(n).padStart(2, '0');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const D = (id) => (S ? S.dests.find((d) => d.id === id) : null) || (S ? S.dests[0] : { id: 'daily', kind: 'daily', name: 'Daily Note', icon: '📄' });
const shortDay = (s) => { const [y, m, d] = s.split('-').map(Number); return MON[m - 1] + ' ' + d; };
const cap = $('#cap'), save = $('#save');

function setDest(id, quiet) {
  dest = D(id).id; const d = D(dest);
  $('#destlabel').textContent = d.icon + ' ' + d.name;
  cap.placeholder = d.ph || 'Type here';
  $('#calbtn').disabled = d.kind === 'folder' || d.kind === 'inbox';
  $('#calbtn').title = $('#calbtn').disabled ? 'Only for the daily note, headings and tasks' : (d.kind === 'task' ? 'Set the Due property' : 'File into another day');
  if ($('#calbtn').disabled && !$('#cal').hidden) $('#cal').hidden = true;
  renderExtras();
  if (!quiet) send({ t: 'dest', id: dest });
  sizeUp();
}
function renderExtras() {
  const d = D(dest), ex = $('#extras'); let h = '';
  if (d.kind === 'task' && S) {
    const T = S.task;
    if (!T.ok) h += '<div class="warn">LifeWorld is still starting.</div>';
    h += '<div class="taskopts"><span class="mini" id="when">' + [['today','Today'],['tomorrow','Tomorrow'],['none','No date']].map(([k, l]) => '<button data-w="' + k + '" class="' + (!other && when === k ? 'on' : '') + '">' + l + '</button>').join('') + '</span>';
    h += '<span class="mini" id="half">' + [['am','Morning'],['pm','Afternoon']].map(([k, l]) => '<button data-h="' + k + '" class="' + (half === k ? 'on' : '') + '">' + l + '</button>').join('') + '</span>';
    if (T.mode === 'tasknotes') {
      const opts = (ps) => ps.map((p) => '<option value="' + esc(p.path) + '"' + (p.path === project ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('');
      const grp = (label, ps) => ps.length ? '<optgroup label="' + label + '">' + opts(ps) + '</optgroup>' : '';
      h += '<select id="proj"><option value="">No project</option>' + grp('Areas', T.projects.filter((p) => p.area)) + grp('Projects', T.projects.filter((p) => !p.area)) + '</select>';
    }
    h += '</div>';
  }
  const dateChip = other && (d.kind === 'daily' || d.kind === 'heading' || d.kind === 'task');
  if (dateChip || files.length) {
    h += '<div class="chipline">';
    if (dateChip) h += '<span class="chip acc">📅 ' + (d.kind === 'task' ? 'due' : 'into') + ' ' + shortDay(other) + ' <span class="x" data-x="day" title="Back to today">×</span></span>';
    files.forEach((f, i) => { h += '<span class="chip">🖼 ' + esc(f.name) + ' <span class="x" data-x="' + i + '" title="Remove">×</span></span>'; });
    h += '</div>';
  }
  ex.innerHTML = h;
  $$('#when button').forEach((b) => b.addEventListener('click', () => { when = b.dataset.w; other = null; renderCal(); renderExtras(); sizeUp(); cap.focus(); }));
  $$('#half button').forEach((b) => b.addEventListener('click', () => { half = b.dataset.h; renderExtras(); cap.focus(); }));
  const pj = $('#proj'); if (pj) pj.addEventListener('change', () => { project = pj.value; askPreview(); });
  $$('#extras .x').forEach((x) => x.addEventListener('click', () => { if (x.dataset.x === 'day') { other = null; renderCal(); } else files.splice(Number(x.dataset.x), 1); $('#attach').classList.toggle('on', files.length > 0); renderExtras(); refreshSave(); sizeUp(); cap.focus(); }));
  $('#calbtn').classList.toggle('on', !!other);
  markTyped();
  askPreview();
}
// The orange "Adds:" line (Task only): the plugin reads the text with the shared
// quick add parser and answers with what Enter will save.
function askPreview() {
  if (D(dest).kind !== 'task' || !S || S.task.mode !== 'tasknotes') { showPreview(null); return; }
  send({ t: 'preview', seq: ++pvSeq, text: cap.value, day: other, task: { when, half, project } });
}
function showPreview(p) {
  const el = $('#pv'); let h = '';
  if (D(dest).kind === 'task' && S && S.task.mode === 'tasknotes') {
    if (!cap.value.trim()) h = '<span class="hint">Dates, times (friday 3pm), mornings and afternoons, repeats and priority are picked up as you type.</span>';
    else if (p) h = '<span class="hint">Adds:</span>' + p.chips.map((c) => '<span class="chip got">' + esc(c) + '</span>').join('') + '<span class="hint">· Enter</span>';
  }
  typed = !!(p && p.typed && cap.value.trim());
  el.innerHTML = h; el.hidden = !h;
  markTyped(); sizeUp();
}
// Typed words win over the day and half buttons: those then show as not in use.
function markTyped() { ['#when', '#half'].forEach((s) => { const e = $(s); if (e) e.classList.toggle('off', typed); }); }
function renderPicker() {
  const rows = S ? S.dests : [];
  let h = '';
  rows.forEach((d, i) => {
    if (i === 1 || (i > 0 && d.builtin && !rows[i - 1].builtin)) h += '<div class="sep"></div>';
    h += '<div class="it' + (d.id === dest ? ' cur' : '') + '" data-d="' + esc(d.id) + '"><span>' + esc(d.icon + ' ' + d.name) + '</span><span class="kb">' + esc(d.key || '') + '</span></div>';
  });
  h += '<div class="sep"></div><div class="it dim" id="pk-rem"><span>' + (S && S.remember ? '✓ ' : '&nbsp;&nbsp;&nbsp;') + 'Remember last destination</span></div><div class="it dim" id="pk-edit"><span>Edit destinations…</span></div>';
  $('#picker').innerHTML = h;
  $$('#picker .it[data-d]').forEach((it) => it.addEventListener('click', () => { setDest(it.dataset.d); closePops(); cap.focus(); }));
  $('#pk-rem').addEventListener('click', () => { S.remember = !S.remember; send({ t: 'remember', on: S.remember }); renderPicker(); });
  $('#pk-edit').addEventListener('click', () => { closePops(); send({ t: 'edit-dests' }); });
}
function renderCal() {
  if (!S) return;
  const today = S.today; const base = calMonth || (other || today).slice(0, 7);
  const [y, m] = base.split('-').map(Number);
  const first = new Date(y, m - 1, 1).getDay(), days = new Date(y, m, 0).getDate();
  let h = '<b>' + (D(dest).kind === 'task' ? 'Due' : 'File into another day') + '</b><div class="head"><span class="nav" id="cprev" title="Previous month">‹</span><span>' + MON[m - 1] + ' ' + y + '</span><span class="nav" id="cnext" title="Next month">›</span></div><div class="grid">';
  h += ['S','M','T','W','T','F','S'].map((x) => '<span class="h">' + x + '</span>').join('') + '<span class="h"></span>'.repeat(first);
  for (let d = 1; d <= days; d++) { const ds = y + '-' + pad(m) + '-' + pad(d); h += '<span data-day="' + ds + '" class="' + (ds === today ? 'today' : '') + (ds === other ? ' sel' : '') + '">' + d + '</span>'; }
  $('#cal').innerHTML = h + '</div>';
  const shift = (n) => { const t = new Date(y, m - 1 + n, 1); calMonth = t.getFullYear() + '-' + pad(t.getMonth() + 1); renderCal(); sizeUp(); };
  $('#cprev').addEventListener('click', () => shift(-1)); $('#cnext').addEventListener('click', () => shift(1));
  $$('#cal [data-day]').forEach((c) => c.addEventListener('click', () => { other = c.dataset.day === S.today && D(dest).kind !== 'task' ? null : c.dataset.day; calMonth = null; renderCal(); renderExtras(); closePops(); sizeUp(); cap.focus(); }));
}
function closePops() { $('#picker').hidden = true; $('#cal').hidden = true; $('#dest').classList.remove('on'); sizeUp(); }
function refreshSave() { save.disabled = busy || !(cap.value.trim() || files.length); }
let lastH = 0;
function sizeUp() {
  requestAnimationFrame(() => {
    let b = $('#panel').getBoundingClientRect().bottom;
    for (const id of ['#picker', '#cal']) { const el = $(id); if (!el.hidden) b = Math.max(b, el.getBoundingClientRect().bottom); }
    const h = Math.ceil(b + 30);
    if (h !== lastH) { lastH = h; send({ t: 'size', h }); }
  });
}
function flash(text, bad) {
  const s = $('#saved'); s.textContent = text; s.classList.toggle('bad', !!bad); s.classList.add('show');
  clearTimeout(savedTimer); savedTimer = setTimeout(() => s.classList.remove('show'), bad ? 6000 : 2200);
}
function doSave() {
  if (busy || !(cap.value.trim() || files.length)) return;
  busy = true; refreshSave();
  const d = D(dest);
  send({ t: 'save', seq: ++seq, text: cap.value, dest, day: other, files: files.map((f) => ({ name: f.name, path: f.path, b64: f.b64, type: f.type })), task: d.kind === 'task' ? { when, half, project } : null });
}
function addFile(f) { files.push(f); $('#attach').classList.add('on'); renderExtras(); refreshSave(); sizeUp(); }
function readFile(file) {
  let p = ''; try { p = webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : ''; } catch (e) { p = ''; }
  if (p) { addFile({ name: file.name, path: p, type: file.type }); return; }
  const r = new FileReader();
  r.onload = () => { const s = String(r.result); addFile({ name: file.name || '', type: file.type, b64: s.slice(s.indexOf(',') + 1) }); };
  r.readAsDataURL(file);
}
function resetAfterSave() { cap.value = ''; files = []; other = null; $('#attach').classList.remove('on'); renderCal(); renderExtras(); refreshSave(); sizeUp(); }

ipcRenderer.on('lwc', (_e, raw) => {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  if (m.t === 'state') {
    const first = !S; S = m.state;
    document.documentElement.style.setProperty('--acc', matchMedia('(prefers-color-scheme: dark)').matches ? S.accent.dark : S.accent.light);
    if (first || !S.dests.some((d) => d.id === dest)) { when = S.task.when; half = S.task.half; project = S.task.project; }
    setDest(S.dests.some((d) => d.id === dest) && !first ? dest : S.cur, true);
    if (!$('#picker').hidden) renderPicker();
  } else if (m.t === 'shown') {
    if (S) { when = S.task.when; half = S.task.half; if (!project) project = S.task.project; setDest(S.cur, true); }
    closePops(); cap.focus(); refreshSave();
  } else if (m.t === 'saved') {
    busy = false;
    if (m.ok) { resetAfterSave(); flash(m.label || 'saved'); } else { refreshSave(); flash(m.msg || 'Could not save.', true); }
    cap.focus();
  } else if (m.t === 'files') { (m.files || []).forEach(addFile); cap.focus(); }
  else if (m.t === 'preview') { if (m.seq === pvSeq) showPreview(m.pv); }
});
cap.addEventListener('input', () => { refreshSave(); askPreview(); const sv = $('#saved'); if (sv.classList.contains('bad')) { sv.classList.remove('show', 'bad'); } });
cap.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); doSave(); return; }
  if (e.key === 'Escape') { e.preventDefault(); if (!$('#picker').hidden || !$('#cal').hidden) closePops(); else send({ t: 'close' }); return; }
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1 && S) {
    const k = '⌘' + e.key.toUpperCase(); const hit = S.dests.find((d) => d.key === k);
    if (hit) { e.preventDefault(); setDest(hit.id); closePops(); cap.focus(); return; }
  }
  if (e.key === 'Escape' && e.target !== cap) { e.preventDefault(); if (!$('#picker').hidden || !$('#cal').hidden) closePops(); else send({ t: 'close' }); }
});
cap.addEventListener('paste', (e) => {
  const items = [...(e.clipboardData ? e.clipboardData.items : [])].filter((i) => i.kind === 'file');
  if (!items.length) return;
  e.preventDefault(); items.forEach((i) => { const f = i.getAsFile(); if (f) readFile(f); });
});
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drop'); });
document.addEventListener('drop', (e) => { e.preventDefault(); document.body.classList.remove('drop'); [...(e.dataTransfer ? e.dataTransfer.files : [])].forEach(readFile); });
document.addEventListener('click', (e) => { if (!e.target.closest('#picker, #dest, #cal, #calbtn')) { if (!$('#picker').hidden || !$('#cal').hidden) closePops(); } });
$('#dest').addEventListener('click', () => { const open = $('#picker').hidden; closePops(); if (open) { renderPicker(); $('#picker').hidden = false; $('#dest').classList.add('on'); } sizeUp(); });
$('#dest').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#dest').click(); } });
$('#calbtn').addEventListener('click', () => { if ($('#calbtn').disabled) return; const open = $('#cal').hidden; closePops(); if (open) { renderCal(); $('#cal').hidden = false; } sizeUp(); });
$('#attach').addEventListener('click', () => send({ t: 'pick-files' }));
$('#cancel').addEventListener('click', () => send({ t: 'close' }));
save.addEventListener('click', doSave);
window.addEventListener('blur', () => send({ t: 'blur' }));
window.__lwc = { addFile, setDest, state: () => ({ dest, other, files: files.length, when, half, project, S }) };
send({ t: 'ready' }); sizeUp();
})();
`;

LifeWorldCapturePlugin.logic = logic;
module.exports = LifeWorldCapturePlugin;


/* ==== bundled font (SIL Open Font License 1.1, see fonts/OFL-caveat.txt) ====
   Caveat: Copyright 2014 The Caveat Project Authors. Latin subset as served by Google Fonts (woff2). */
var LWC_CAVEAT_WOFF2 = "d09GMgABAAAAAMhgAA8AAAABuvgAAMf+AAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGoEgG4GDfByXOAZgP1NUQVQcAIUMEQgKha0Ug+tuC4VCAAE2AiQDin4EIAWEIAeOI1uMVnGAcXsC3A6Mbr03PwglbFcGem4vAJbWElZwY9w8DoRRTxH8/5+ToIaMAbp72DY1s8qIJEWkSSX10qD3OcaqYXOoWwl6OqVNedmBic3QDASsJezEX/GK2fwiZMsKpy0cbuEOl/uf+1U1e9v7+QTfNHAJBGlY4X+u/HXt+/jfGd1NdkUVZsOIiH8ktbIMKOPWg5GsHFfy5Mvzz/v35Nrn/REVy1UqANVUITuAlVjxDtHc7mvN2Bp6QaSMbWy0aypGtESLUmVQRlNiFKVgIypGAWJEY1QzgIPJPf//zz20fe63WaMDWWulNBYGxVmcQOQRJ5DO+19V8zhdEq2NEihRkUgDIhhTnbpSOkhcmRS/jOnDclntYb1e6FYlR3DrnwTqZKty6vFwVHNWdFJ8IOiSVOOoRVQvpjV7QV/gz6p7+MN0U/cIqv97qgegVf883Pz48pWRkpWSlZSRkJaQlpQ5Hyy9vJbL5ePxCuA/AJScDa0wFmeZTW0aXpmlu+nyan7N/5pqia35tlNy2BRye8lP1967orx7Pf67Dmh/wmCs4a4xA5AYebhrSqQsbc70ur//P1N9392+t7333Qc8WvwDCMACG/n82JZTpdO0riD0iG39WZ1E7bz01traW1ICSUhULIqDCJlMSItMyJTOOH7FgmQu/DfioTBjZsQLuTl/sZ1NIIXOTdpp/fDbPPv9HaUZh8JYBmc3NrG7yfVmqUV4Bl3a90k7aa/d/fdRHXd3Fc1V/6ozrWl1IQEiQUgCYeMJGLBxYr+JE2cS78/sRkYoGwNj8jNH4Z9+v5bfP5idIbSykv5efAWXpplaCEUSQ2JIXmKD53nWnlXn/u+JM4dEc++fGSxTEqeLDfIQkTjgUbxqJ1EypB8S0ohb4oa6oW3ds/D0qWWm/NdbS/JkRzbmU6Qkw43kI2XhbHcBpd66Ysu44ZBnQhkfJACGQQMrH/EuiGSSSP73pvaZPtCssVxjXDYbZNz1Mj5TpCTsPvc1AdzbmA/ch3GvOb843ZwqsjGjxTzwuweucyaUj3calGusBWXny4cKtapcpTj6+tGsoi1lmYIgU6j/f+1bvW/efyOrXxCzEGfVQ+N08orP2vxdx6OKRZMkSd1ShabefwQShEbJ4pEmWqmR0khEMl2Tl0AkROD5//1+1S8bifx1ga7JJBRCI2QSUfQ+7GD+kPQTZkktkiBEGpnmEqJoMsukSRPSpAmpThuo2lYZjuA8iYQtXtxYHWkfnW7oWopRqE3kv8z6L4GjhSeyiISu/ut6ThirM6TBBBNZxrIsCOPmF1+tdWdeRcns533WaC0iopQoEeuWMaWkZ7mxOodW2AkQIrf+a2rN6tT2ZgK9yRJI9/gQPcSVU/mf6J1XkjYCAQK02zJcZp36/4lVqSiB6HZXwKi26qvcJROEqJDvNtksJZ+9E7gpJ9eDl0UqrVbrdPU2mu9Ci2223DXW2mm9ffrmNtryYgITCsmkTIJwERi7OxiMqQFCmfRXYCA7oeCtttlpL9STDj/rFFQoQGvSG9nViUefcYq/gRww+ZFOPSxEuwB6G+h6KXIR4NBASFAHx2sQGQqMFQtGGO4SSmEdCsrnZ3Un1xua5vDFddCze7H7u3ZYQnPg14IA6u4//uBuEIpooFsnLLfQbFOrxhtpsL49h7PxPWfqb/zll7rvfOtzH9a9veSrGwPqeU962FoPucdtT97Q4ubW8Ey7qCqqqPIrs1IQJzLBgyvblOItN5g0S2W+mcXkffzJ2NFGglHoXz/61JueNd7trna+kxgtDj72HAfy+PsLm+uAm+wF5C6X2+pCzFanZk4ZkFMc54irByXGaaP7upPYEr3UMKQOJ9G06Bu5kKyqm6lDObdHnbTU1UJRZjdc6W2IWS4sMQthu6IOYXMdyuHODKKu2ahO08iuebnTCF17wb4OcSA72zjEFnDCgSURjoFZ8bsxEVMxumQcOZr9wtJUpLKbnFLYELtSzo4hysrGBi69P5nZyBZU1dDNmyJdgt3S6+wYQFe1sZvtvNjK3ZzKHKq+T4Q/6WJ1ZTLiym3SVgb4ykmuVzcnYxTT5MhhZXgbRp9MBTxtisicJRo+2662TzGZUpumvIhwPmGFEy5I8WYi/gQSfj8CDjB3tTy9tgkxIXM4ZrpmqdXjI7gEJijBCUloJoERQDmq35wE/5Mc73yvXs/bniyPDvdU+WV5u2xQJnUjSWmSxRJv8UrXZleqy+oJg84Kp/mOmQ7nHXh2a23P2jrY7LLRWZ+08hVWCR2EPMF5wS7+IG8XL52nsbxtMWyRYEEwTzH9YDpqUmZiY7yae5qr4fiyz7JrWGOMQfpqeit9IT2d9oSGM5xrGEN9YXDZYC8lgVRHlBEpBF+8Ancc/YLcRy4i25BOpBVZiKQjcYgnIkJM4LvweXgvvBJugivgVDgS9oYdYAr0ChqHtkELqc0SMGPQZL4kgxgkEYbvQ7FwYcxYIOLhoxAuqRw/b8iZKxoZD2xekhmbpIi3KtVC1S7DTX9fhAazRFpgkRhLNIvXuky00nWbZLW1n0zv1CXVBhul28KVbLj7kM4Vks5sg/5pW7AQFN03tSvTmzRXnbqMmtCNQsHCWASsZPXpQn7Phjb6uuVxuIv+MmSNA6wLy0Yez0jwqpaDjOXZAtoGNsZZjY9iGgjdUAxI/O75JQum6WUBzbU10+VIlS42njELLlXuK0xfM7M6f7R2QGdBPT3x/wlTi6QVK9qn1xHmqfPPWQxVY2laG2hN8mAdWJbU1swaOuliw6Rgw0ygn42qKw2+QTUaLo2nBb6WJ/AJ9GfjLcmYfHkB0m872dnQ4ZCIDnGACVOZ8WtlVLulNjWTgq1fCVUrlU5PakHtYyRLMDkGOYYKnwgdFzLuPHjx5hPf+6cV/8+DgP+PQKAS2tMnijYaWICYWWK7xCkJTprM5EcK7jNVClNEqkh1Vmt6o1/jisa/J95o2H2TrTXbsu0G7Jiz8/83BxzKiM/o3NEcCydyEqdyGmdyjlzLbrR3/n8M7uJeHrgny1z+3IGD1qhTgipT9YaeNWBgZtkMF/+EQMG0dKe6VBRjuFcZqoQRTYkjyZG7KEVFTRsd0XeMMc8atQvGC7mGS/HyenjjywlO71I3bMI+ErsRTyIfMiTZSM43pmTCyJUM95n8wlRmsDO7qz3Zqxxwhww6cdwkp8szrxG5wo3sZm71budOdbe9dx+4Q8Yde2xemafls2NErvAp+5wvva/5Vn1vf9xfzvTJUP9r6kn8PxOzt9OMPJTuDPP6el0CJ8dgFU4v4hhT8h0Yq2X2S/vr7sOrNJGaoKbC0wp7vB5Dnor6SSr9JfVXaAZ6qjR7C8PQS4QlhNLUyUchBVf4SfxlNQucAtNJKEEuUkooPeDPnsqv5jO1UEqTKj6Or8gL2vQ3kb9vBrrnieqM0vWOzi4+E5g6RbhlpsX22dBPzYfYM1/9gPOQUkpxlurdXO91/iDRPBsoTeVT/3lG1O/Bj/qLM5j9LIQIIaAwmIg6KRkNoLNzfQJfJpKIQ0lL2Ym4uFeZdKA6YNYYRUd4zWcdm0aXDemwCW3aZLs2d/NqC+/m3LiWCXZdYx3j2MkxsPByrWtdx9M/rrHWor9eXtYa4zjGtf1YKyzZUApo/vX6kirWcEWzcwJBNOWndkMPfZabcv0gM33zckCNJulOqhavQBMeM6vZIBcKuBqNUyCKQgg8KtzkLhipO/DJoLNB5UrO7KceoB71HFP3IlCkkMrFXL31Mn4lEUzcCmZZ9uL9ZETc7FPD5Mxz1RdSgB54Xd9MeMs7PmktDxfO/owCWXMYmbMOgDbrOeoZZIRqcbY2z1vnI0VpBqrHYaQHWTFqBzSnkL7AUIhmsji5DW82UH6E1XEK9DLJEiT18tfc+srVleQEZ46fExe1hdQqa1lX/uPicO6/8AU5QPjvWnGDKckSTaEEPd8/11XPTFbrTBRCLB6De+cUZRYkTdiclKj2Ce5KUcO5RcBRXqUJMR4MbndM2KPyydAhMCTXPYF8PxFe8b3iqZtdpDVfgUp6j6fT0QioyCRAQgPS+6TdLimqJgRK8KeUapGQa43OjfSyZAVlhL0mozBAJnTFvwUe4b7YN8B45O0JxTr432DvdWX2nKrYJ0bO01LppEsvySndYU4upDWvF/WJUdPm9HyNVFPv5ljFyWr0gD2JBXNmh0hQPEyqpmumllPEufGwhB4Gyy3z3exmX8aj/pLzfN8UG/RRH3Y82j5pHRRppoVLCbiTxiGpAHKjEImnzi4X57zqkkOigwRPfaOJvpxWZCisEOfR1S+xLn2NlLFMbD6zFpglVAxQJaIXU3GsJ2taQRTh4u3EkhutufUmt1l6/hY5iAQJapvLt40RcsA96BupFG96B3yaZr1XAkGECZ2VwlaBm9TcGTTPbZpadcfU0PDr9cfLG0lE+wRdNrXX7czVSGW0jmXGtcEhUsRQndxgLQ7pPj1byeKx9WrmWn8dXeouFTNlUEARH24/V8PU+j7zYfsxBEjFTBwUUHxkrqglS1JkwZjTB82z3oWAKGLQ3b32XJZeIwuYqvZhulUJwfjZjyPDt0c5NsIZjLDE0Mp9hoxmQVkFjn9unTRHfwn//8kEmjrnnLQYNJxYf+zbUKT5q9A4I+MuRHppNYs3PgGGkqQLLL+OAFeSLgMMzlxpYqVJCf8UqEabMyDmRgxpqrViU7xIBdpswUWoLNECIMSTW59L/OqoWWbItlJKy/iNwo0mOme95aN3UBEpdaHUw/QYxTqlfsGoRRO8thSKKp6fQm5dT4MZpRGxJdApLHRPPuxO07IPTBZrfXjcxMQot1BkElm1KJNH/Jj6cB/U93B5tIH5RH9FbgEjkYgg6W1bockAI5EIIEGAYwAjkYgwDECSpSv9OJbRmDk2z/W2vwvf44oxounFYptUlgnc/Zjo+vXNMmZeQSRCc77u0QJtg3YClWtVh36td9BVUBnLvPNri7sF0kpgPTUUVGstZ078Q2NPjdjDEdXZcIyvsG7fggFrOX3RXDRUfbp8oEophb6fBhutcFGPGkXobTABPOlDZSPoAaMAqRMXQYsquNET6x1NxXQJ0IPkmcrigsBYpoSf777eCudppxPJ+36qrarRpMpTwUvnxtSlScdRJlyek382fCbrlKszVdPbrthSTcJyedi4CeaLl7x4ePFwuBw2Dr3wcLhcnojg4ksOlxcPD/Bw46gQDofLcJ8tx2xFZdSk9KoMBihsutQfKGawoOyUcpjyJ/gmQDVHMqLwmFEJA7N+/NgiM6evWtds8EEKdO2WRiX3O8NmAvskuJ7qErI1bdOkLE2w8rSSlNjCzi5HsLKeyv9tc0XGXNb3KVxnpaVKUL/etj7cw3FYrnfHMWME7aI2EHCVzoVx3DPgCNhJ21YXe0ptFgBFxAF39LXSoydqDQpE+LCUcgPDQrVrl3jnvrlQN+e4/s+UIck4xl9JqCEwEDdFwIr3qgD0sSGCxCZpua+tTXhiYkvIs0deCEJ/1QrszXT3mBXpSEBPznWo1Dncvj1BZPYkz7aAJLIiINmI1ODy+vwVTkJj2D/edP3ZC4mNrOQsuAVy0POIESlNMuiOIWW6tP6lfCY4wQ6G6ctIuWD77X7AEkLfzwKxNtVRJBq142KuwO1HsAkVPCKsIo9s0nHVlLGMVjB5H6ybuyBZqibP/hrnwkJbelE2g09/SMxoa9RWnoiwDQbGrq2lJBsD4lM5Qoje/BkjZUCPkbJ+ZVsQB1H6nSqITg4+rLJZb/fmFq6OZ9CUq07hba+p4o0ctAsYpkrO57uBoHqW6ZDy0KVmN7uuQozQpNKoUUqplG47Lap9PaVUSqmUUkqldNs5Uu3rqen/0SiVUkppKo2j9L9e/GnHcXZuTZdWFTLu8FRUxM0GEQNBmlbXWJYC2wr3BtMccKgxv8SyY2HXIlxKa5OyhzQ4PFfUDlPoYk5Le6WMfhUHmFyZfx17tcf7w9oZ5OlXG5l7cVrGGauYbQx0CtZMzLUFumaQ9xAkvP/Mpi1FXzUsc97R42OLpPMsj/Pv76F2HdYp9Q2NQMdJddm1htWpoRNC2kRUgck6840C09ILnjYeo3uylfmTDlfaBA4nsmr+TdD9q3ufgkc8hTeUGR7ofuaK+WD8vc336dMigwY5NJAuXLIQe3uoCefTUrUeM9MzDMMAw7DMcJBlJVyGYZjtjrxqMozIEuDKyJC9u7BhZEJjU+C2d2ePSplUGd2WORLFO1YmkKaJxYaP3pg97YeasZrdL/Mq/E8AXcs5iZBt9mzx2Cc2j3gK8LPEipyAEpbAmLxCBLY01Wb7shME/zPguZKHn1iZaTC6/jizybNVV4UQiJM86rKwZ+36guwrdS8ZqjCPzPoULEdZtcIDjtlcUoYFF/re9s1YaF0bU3NJ4vEjMG8UYtXGMQRxKMgKxg9r9lgeKUfAHkrjGDdmIflTJQz3FT5CELiv6aFpZHPH71cGb1MTbRN/Xye57lnSpFKausI0e5q9rMNc8RPyiti5EGXvy/1aV6J3lWP1+IwT2WO8bLSoKKSUVPZakbxcSMm2+GqoKsf04An081YsU5N5y8Phy5+tax32vxyBRrEMfXinZnUm1538cvf/9tS6V9pL41ErvBiWcDiyDEcOK1cilyGsTP+IUT9mq6Hv6B3HSsiL9ObcLq5Zhyj3s6x2OrqmnL8/BLvARcoYVTn3yuuPz/tmZv+lywb/J/yx+gHU6MAdv0nemPUpkHfoRpId8zJTOWBzXVQMJDzRb6nxcYxYe2NdY4Y3MBJJkBUeTJY1PomtyhdI/9pAewxoJWGkYu2cihWS27AaWa4+1lcyehnvRYzYn8IBPwHVs1xdO9L66vrvcBUk37wN1WpfZbLfBeDhPUh+3FeoTVyi/j6Dp4wP9YJ6GUyjsigRsWvYpsOJRjne1uc5Do/ddTKz86SebPFpvbCItdZDResdb6qS+qOhNHVlOGTHOXJ9mbOH7iZNBNta3arEAXDz1Y4OzZ+E9qtAD9jolQQIgVdSQlZ7puPLPatb2EWc4GEPPCLEinSpsQrGr1zgmkfvxJczgDgMA45onyEg4T6KzRwAJYUAyCy+JJi/YH8+h4qzYtiAZ1d6Rq/ASpsfTaumtEts8POLlr8epLHxPKsf+8HEfn5og7yizHcJmZ/irdT45vKPm53g2VRaz7VZamirRU0i0x9xpYLA0GcdNKLEBI6/uofF97tvLt6RHedigDDbMGRTwzyb9j1HnVQap7YlxYmWpgFckQHvT2TjTAiJvLZPyh6zVNzEvpiNFOO05bV2NAqdPlQGsRouUHDSIY6WWI5NJpMF0q9ysNX9aCxOIz/LrH0VjhXgnQy9DjZoLhHxENROQ1wsQ1v8+mrQbTaAnFnolfra0DnRf5B75EjbZtcu791c8IgYEwxTJXixGk9WF+/7xQAZ+55D/+BdAx0jM9vFg9bw38OvTfG21Fai0C3NV6vZqgS4wRza5eIxGIsQuFem/hajX9vGXn/5GVWpCZE9XnYMtgAG12EN2uu0M6O34A7MGXcjOy9pLmNPiQ6BGoKlWdd1qrHed/lNXl1994H6HyHCsf8gUHAD9LauVc1FPXZNs6KJw6XFPVFotpx4VfJt/6xC+8rZ0LaYRnm8oUX0jZJv/jOIcYtuDpfzX1ORLmL48S1mL4j9d7kzW2uz7Lv4MhuT1tZLuBiRAKRjqgyfQ6SkzQ/ZKqD390AaBBN4qxLI9xyWRMNNV3boYT5E4Mdz5PwnApss13/Y0qysbYiaittWwsXSr/4OeJ5vyl+pBhroS0YzWEyPWFtUIcsSvmejGyKkTbXmDkVkOF/1KNKmh/hnGrhXypI2h43cc70Y4jjj9F0yaVuNV5rMvwKbY35YJKJ8N1uMbcJsg7R6KGTPdAGjbYZOT+q6bh1F5t7UvKBebX+zoz8cb2b66JBCyX9AEJu8zEBbbr7XkY7/BEHnsv83RJfRIw8/6SxOYKcJweGLviWPPRzve/7Ik5gAoTquBHqxNyGMl1+rc612F93xxGkDbL7lYSqUwQTyZccMDQT1XwrNxxr5ly+MCuf3ZeNv/UXin31/AyVggoHkeyP9az8Q3r+6mT9ZMK+8pvF3PjDyDiy7jLIEB05MOF6McNmKFZJeQn28e0OqC8PV8LZACCZNwQSoYcrABWeR85AzK+wJqRix4sRLkChJshSTpEqTLkOmLNly5MqTb7ICU0xV6ISTTjntjLPOOe+Ciy657Iqrrrnuhptuue2Ou+6574Hx4Wjq5uLNh6+JFJRU1DS0dPz4CxAoSLAQocKEixBJL0q0rbbZbsAOg3baZbche+y1z34HHHTIYUcMGzHqqDHHHF9ImjcJmQHDU8hsZhzcE2bO4j+8O+wiHTmbwIVoJy4j585DKPpP7kOuNV2DRk1mWWAhnRf953aHHbYSrH4XgcOWdYENQr90lDuKiOBJwOF1eDHeDI/DvcNdxx3EdeNm4/JxgTgHLBhzxwQYBf2C3kVH0X50IVqEipA/iAwRIBT4G3wfPg5vgVvhCjgB9oRNIBU0ATKCYKYWvHLZXms1yIbA+bBWQMdBeRYTwpBzfK4uxE5DTqPB6TB7hdjih2zDg7zWCrF2SDsaGIZqEmIJD6nBAzwLhFg6JB31tweixBweEoj7xfblm5RIUd8sMDv/NrHAfWSsSISUtgdGRIE8TcHA89NyIO0eAWdJRIztiMxZoLytANEcyW0WHxOxT9E21Yx4KoCpIGF4IvamtViuO0iUzDneyiCSJY+byYp4ekEU7zhAhRoN/gQRQihhRJao556JyzZbbRCUOgURTy4dIjz0pqARKPw8OX1Gt74NYohLyNX2dm3KC2frz5pWP6CjroN/3TSZ1ZmMqoPJqmTeVPFQJik3zEEItv9juAmJMKEIV1HeYhTiaMQLlCBcohhJEiRLkSJTA/lSFcXQ0tBgwISFEaaYY4ElAqywG80Y1RW45YkAEHCQdXk/zfon2JjVyMPyTXlYvss7nN2UNy7WX9Rev8vKupVS6+rkVucSVYfzrPAch1ZZoU3SPj//TSYK33qHSdmgab/9u1HHYi3fjZcws1OylCW3SLfNwJVBu/R/f8h+eQ4aNtWo40qddFqVs86rddFVM1x3W6O7npmLCztnqx12O2DkSpHpfKlVl7BtUx45Xn9cRf0mzXXNVHUVUqpTMKp1RFUiz6pM4CZxn9/MAxTtj3lohpmV8DhvKF3oXW9N6u0wym6jHTDGiLFOGOeM8S6Y4JqJ7jx+koeeSUaElu8AQMBBbvhaQomISpNzaXJOG0H43saZwAaPCm5SPUPybnZ6WlzkibM8PI1Pg8eQukUeXfrMAoFWQrO1OBhQVy9PYMelcwixD7ZyL8N6bNEO9XPZ8n2PrQ0DM9+Q4Q8AdG/mBbgZINeUDpguOJNxAzD6CXrVucced1ZqAgNTiGAdaFXJRl/Uocycfn8uPMzwPwW5pq+DHd/t3X0gBEUIiPAzi2fCs+AJeDY8Cc+Tp2Gs5RcEDAH7/39hFZhHxFOnW6QCSOfH5BnxzGKJeR7p5IVF/lM/rXik7X38/7+2NtQHBaq8gW9eAfj639e/G48df/b1w/9njM94YPnAdiXrqW4vd1WZ6ya2yiuOuddjwV92tvAZkgFZwosvasbiAkSwTETKcGiGZR1SbsjZ+Cvvj44Fyhh+6BK+/v7HYdBi8mCHkEUmcOJCRyGesslyZ0olkYa8L3zV52kiOPt2SHuRhV+++x0F4MBQBBg8IgomGjoGU0aMmaASsGXFmj2bxOy4EZOQ8uRknTLFSlQoVa5SjXozzFRnvjnmmmeaFh3atFtuaRLLrNetR69NVtnMwYqMM0qQMD4I1JoHSFIB6kUgnwJn/ALO/wPUm9+Yt1gfcMtOEUyT57YdrLmvHgg6F0b1Y23fRYbD7Fj39ZRyRF3b8S7XMWPrSHO43ruU+Px45xk3T3sxptda+SW6oo0NNtbGXfM8PTyJqUXvoGsZ/TRf7RvplpzbduSvdryZy/RaiVb56Y1mpdS7kYtJ758TfDJs6JonR1iv0NoAYg/5GWVdNo232jaVH7N0oGRmeHt6pobvMLk918o+5DeVOu8ofhbHRXBvxzUqlztkTGoMUErNo1NNVRb8JD/78vURrZlF0zP6pwV4lQV65ziWl6Yvnt02pypVON0u3s9namXtrEVxusDYS7Oi/SZxwxUrhMWpdbpVxfp6Od2FIaZNDpEzvBjGrrRGDSPLimnlTUn3mxxnS+cxbe3orrREWjjNyIPqnbUvSS2aFO3Fi5QZBzCStEwdOyrKLN2IEWDozhF6r4pxMkvkuDKtPZXhfh7TLGUycYCOqxVoorSMyZO4enO6glrDjE1U2zJUjABj79gyJ+3U0DjZOotuCxPmOovYJlNGY+xhH7qrkYebriA+OSHWulRvZuppmlKdFBqcWL2kScHVkRKnBifllqg3RvBCOV9J4nFx7tVhTBqFwpdIUf+xYTyOonc3/7PvBh1snjm1uN0/1NLcyMjU1VUkCh/LNOQEvrm/ZglLn51mLjW3sDA3X2ViMo2N5/YVZWxxmFm7TAqi2dJsQ9tMU7i0ZpW92s5L7WtnNFNqb04NszGxsWAwmUwzUyrZlikwYzBYRnpDZtQaVlEzEjMnJ1bVZsbVUuJC5hRURyevD3ULjFmMDdVNbXCOKKXVgCi51moLkCUgfHSlGbWLe5u2+XQMrTaohRGqHJuHKqB66rrrEUEIPzs740CBm2tbtWydp/+DF6ubP7OB85k4XrwPS6M7krUk0h2PBEOq0ZDLnzMblgRD2HDIgbFULGZ1WyqK6NlMByzd05LLiIIatJhKNlPZQpLkqSAjEpJupq6XREGK2HwqxqRJQcPMaFRqD24y7JQKVsoHaF4vRzF9e+hKySfBLIwB85dFNVSWpce630csw75M4/t9JBlNn93lh1PSE31lPI+iIxuk4zvzRddlagWLh/M5pAemATGoGTkMUqXrIdPFS4K6A4B0/KsshRkqcW6QPmI/96JdfgTdjEWxbFd24JrbqYdAoKjrh6RCH8Zaf+BWd0VwurA2hyc6PHVWW+mwlvXJdZdgqyvEUo24YZqBF639KWhIYAjWNkxQ9w1OA4tSCQSnHgqMr8KLrc/I5bjFklG7CqSb8S87imAWM2TBkHpiL4+RxesPuoiLa7A1TEXXrA41ADSiqzm2oZ5MOPxOqNssafFWXUMaZVMzgqgvVsz2ZLanMEvRMSIgDFEXY2MBmUvUiEBiKny6HByHTa9emlw0dcWI8pudyyDhG+RqeOM2IyI+NminciccqLNEFG4cznF0PAeEsdpUeV88DmmbpS6eH7c6OszU3cQOFR2a6m/dgehOFss0zv9bs7lbpRMbXA8JAlQsTLNZBKUjo3osXUCqB8kd39+NzbTdzvsGS9OXBJmK4m9W3rPk5Mn0mn0JiHWWZeTze+0y+GYjJVg15tSdE5XLB9/Cv9jcxb2Y0ACE+/E4E60Rpe6olXQysYExYxZmhbdbEMbCZP8hAkQEMSyKXX/mbFG9OhLsbaZDImWsyz0AhoM+3BOL+0f2fBTAEb/0OEPybzBC7LvG84jed7XGSXR16TC5RvsdP4mC3NFVoXk69VDnprd5TU5Nffv+ZnrfoUPd9myr2WM5LJltdGx0UdbjprGyHqCuNGVhEMwhvRltM3gA9m3ILY9aUB4fV7t5NqCt7VwKaWa0f9rl05uV1Lt7waHGKME6ETG6MEaTNJT2wuvADI24i+gkEz99QUn0vHu5/RQMO5W8Bx2ebhyh1uZY7V2UXZZ391mrUU59PN0Z3nitrZh21A5dl90XOEVwROQH34yT98WRt35ESKHBcJy5zr/MxL7IDHTBsqvTtP/bh3gjiLFfZlzmHC708+m7I6HEYD3D7SMOKUtqm7qtofFiM96mRk3AEKRDSizGAQKtbDUMM9QQDUEIjS4QiRBKB/kr5H4/FrXM2GEAt4Gr9s0ZB6eHqqW0HQFzyhxPXP7f2DgTL4fja60OU0m0x+KDC12NuSqGd+/3Tmn/9fZ0pSari2iKKHZXYrb20pbTQJI3kIAXNUIfro5xC9Diz0GisZ/38eLRr3PseXhuxuLp1xaUg+YwgLVaPNLDMDwRsB9oDjdvMVpCA9SFQQC+rRedhMmCEmVqVHBGlG/jSgus1X75dwSo1RoneZO2gKCGAAyWoVo1mJE17p1C6xxXzfqO0cFv7dSvOSBEC/Yauh9qyIVm2rKhSg5JTLia2BtyoFpRNpLICHetLbzIiCaQrBzxAXvLDx1aFi0QFoUOJmJnzf+d295rVGzccwjXlsGNRqF74VDwzq33JsiTWKDEJjfcTnNpG4C1Y59v3R8QWWaSU6OhXkN5bvtn968K++N/xcs0L+jC4/7ZQrMGVUV8f3Sr9IyFgnnxquvRTxxOHX0VepdOAKfXtBpP3WqjbEeTYmCtE9iLNbceuGkuDMf2JZomdaJlnOJsQ5Jy74bG33m6TvBq7ylE31muxCcIvwCR9EOlB4xOiO3/EzCA0gZ3ABCggr8a4bo59j9ouz5TjcYrT+WH0aruzqywlhUzGm0MTlLp0lvzh86WPTCcDrKRliEUQTeS1kCUm/RTNCWF+C2HlZhkHT3sE0j+5aGDaZi+qZn+a16Po+6bXvkhQZ8TZQ45CmDAjFalguIHBGNHd22PHjBdxRcxrpmevd6Y2oCzAfDuZ3CjHJhmHoh6Wmp9Ndm5gMjll44P/BfFQUueI/YYreiLAhHg2sanBkWldkEaAjHRKG6hdqtHv5MeEoMLs4Y4gViyqxmlh2oyadMSQ7zWaingoSa5/hP3G3LjqILXJoA/JaZlUaAlHf+UpmSco+g+QjStDKCGq79BIV8/lCZGSafylFTMKMeqrsqZqhxfB2XMresPRx7qSVvlHNVoxOUDi5rxN1u/TCPHWPiCXv9qmZg1gIdrzZ5mqvn+veeab0SV3F9RdEkUEOV0QHYuTvJQ3yjN3O8sMLra7POYjc+otRFqLskCNDguNMX8pO0tT0eOfwpV3e1uGvHVwKl+KLNtlP618e5svnbH1p8c/1Sa/io0iaRvt3ecPna+u1Bc6KO2Y0w4NvNFWo2EIM3z5ynguyrHfw/dxNcZddvnSs3r/4cj7lWrFds0xId0ES7GRstXv3S87RpRWmDRwH1uph0ho63AxxXxD2NZzgnRwxvHv5wnH2WIpQ6nBXvh4Zwlndj8IGxBG4nwoGRwJp9PMDRKiKBguLjDoanD2sNeuOQtS8fLbraZOtDyBbW5QwCj0Iy69+NU3HcZM/WKIt44uuQMZuNs5qElc5sFlqQintouEAyDmSv40RDQW+ubzOhuXg+JKFjTaWENDCbCm7hqoIM/Rm93jSiqQhqQz/RVofGgWKU6pL4/3uOlRStScq3WVltD2sC6CqT+ubUdnnSpbak2hq0KXL+fl7OF8WRQ92WamkLa604V8w8KXd39FjcbbUmSNEW1Xf0zcsyNz7LJnN5I1DJ/PCsID8zcMk1ku7E3JC8OlXrELneI4GlfE6CwF+jNFIdqZAcnnavuxE82bGO/VQv68csA83Hq0RidlquG/rIHy1p1UCVxk93u7hyi0CiLajZjtfgzGYBBBpdJsdJqxJ84FPA/5/G1zyN//04zdjoP8do+8UjwouWlYAuD4wbhaP49BXTR3146fkaUsQQNkdjZX87u16r4rNhUnPJ3zPXQJDWKijvosKgjmIAIoiE1xB+75FOIo8B/skx5f3OHgLf5yT/7kxrICro4NXWSxmndinPZ/kHe+4R60bAVBXp1/2uoo4R4mlmZOy2HodLhac2mQ6MWjv/KbflIEG4m1Qu+kTEH8fUS2sYDW1/Ytn1yE8Bz4Y6Zw9MK8fguaoNhjrrsxIQYEI+graeAtdarf8Gh1P6U9bdoEkcjQS325Fj8z+7QlZZLJgZ7Y4QgBmv0PCjNp0EVGh1FGKGYCJfu3fD2A12xIA2zQJYvzgkgZLZbj9AE5O1x1BoJQUDTk6YW/EO34wzxeiVLtGoqAShnlKohqN8fxR74QDvXo6q9riMxSgwCoR3NgKDKl/Xt3PuuFhJhKdvVAuZWonxA9CeizgmvhGQIAOb2DVkqEv2OFpv60CMejadQYUjxf16GSPyBY7ytFZAR82mMMRewEgbKqsHxn6jiwPn8+mERuZr4Ss8mLQcEUM3s0qFI1O3LcSpZVbQsl9hb8F3HydEyL9CowNhkKSnQliQEDgLK0XaaCdoqXqzZyANXoTtg1TTReUDF78CY1WxWv+81EPeaMCVgyUl6Jh6a1oF1dO8ZfcVCBHfXTlJIzal4fB4PUZ2jgy6rvDBYXYAQhEaqmZEzgOGP3mPwVRTJ4QJlgIzabGB2/cOWRmh39accIwDpCRIYRI16SbDoKZ1PzOMsADSmCAJZYPw7nN4gtECA0DmRFVOi+jEkgYQaVaxf5Pl7dp8tPSbdF2a7spm545f1uZ0iliMMl5ycprfSsGpPvKPGfy9wQNz+WlB77+2+kshF35Gbonfon9Pd2zq8KaoTed8jkRylbHKUBHfjbdKz/VMPkMqsM3S4s+JshvxpI6brOftPa752k6OiwGs+7Atj/dc0i9CAbnwfi5YGdvkrH4CYV4Ojl1hTD6KObBJLJs5AHrYeFs1KlQg/NsYwGZOCsEPUZX3kYp5gbeKFcYcackJLlgqvy/1R/G7l1UVW8R8/urMRiuByo4LW9hOxDl/CGx+lFQyJmZIycTitJoUdZcbcRP33WJR7m4APWj7pydBLZ1Mw2osW8RwivO0DKAi474Pz2XDV064vNSBgXKWWGHCxAQqAimQYzvW0k09GuRg1eYMMyREBgOQpcnVUv5qYo+WEZfKy0Zqqjwe8fKZzi736UvwOSFejXrm8WCpYlq9KBgs+7U753dytuCatVMY1IsFsmVpVF7lrB1xYqUaj8lxv6OCtOEFRjewdbKvGZwMx22V50DEYKK5oWNW5ua4fGlLnUGBqm8DlGyMFuIaXJCmqAcQEmmVTQwIn5OeREjDLUWNK2bldWyY29C4+GiobKkiVX6EvQiJ9dlA2KyipS1ZNSt7CQTJoFBfrfPcqylRMA/2WqeKSjWaMJkBpSPxDtsAC1sL56ssBqk86Q6UmtZjxaPTxFHo6SWh+oUid9yUAEehsFnr5ZRFwRDxJ2rBQkpuMZIN3UNyP9WhkGQUsSX0zagSpySX2ZWr8rZkcN8gvY8guAMU5Voeck8V2EU4/ucqbmvdhlqznaGV1+b1Es1smEKzh+KltMj1gyTb58Wi7ccIfC/uP97mZogVoZgwCKIIa2uJU7aSspBZnvc70BI6cdMSYtgwfeJTm62/CME/FXU0YOD6vQam3GCIh+qM2b4ig7PaPZxKNxlX/JKlqEbEKjYOUdBdIW1HLtFhBpJWy3Xxz56skRHO5sKxnzTdkYh3E65WzhQ2uFpirXaI6PLPkgg3AxMqu1C4RYfpy9T61X2+lOjW9ZS3TXr4wMyBRdaeF2ljTR+NJRoeISG8FJEVKCi42O620jwMk3AeZS6lfJe13LeIUW8JreCIgBkx3x4yKrcH0SEmj1KogKU5D2untUenyXK8q1RE2607JdqiQfpbucE89pcOHWxfCJ2Lqc7xEAXmLV5JLgn342WKC4IhriKIDZcwqOeJx1Yj7wasqke4KKxyJATwuZbRfCdamW/lBuoy/uLB8jglmKBEfRnQgXeC6hZf1yeVkIGOTvKGRF81dK8Ss/QzYn1GSGxCAoJ5Dk2y385wRoHdDbQE5e5J2kjzu+UpRjUZcNeHfMEEASgFFWbTJWwZhn0fk8n2xSdeCsMk7YPZcoU1dzcQ63KvFCfCXRY8zQxOBf2yQHDsNiLy1TrukNRxbczODj/hKJf/MywYzVs8p2dHBTUIn3o8qvinAW9ALk3uMQPNaV6PUhfMGUKhCnYvGos8Kc6YZGNiLxDRmxH5bSZi6zpz771wzIA0W84kjBicRs1zdaD7wFrf5saB+KS1Bg0qS91d0s5wLPyJyDcTL/TL8yxZFyW7o+IOH+sA5iCyeQtAhWqSrAjibAsKhB5C1rXS8L8HnnnO1t3E33aOhCml6oiqMjJojFrQ9IGbXvvIC0110gYOZY3p8o7U9pzLDXpUX7OA6rQrAz1ZgR/H8VT9TXd3rx0x3ZGBdkK8Q/Rx7EugtgSCRbrgUgKooPMmeSmvyoYfMzdqj1AaIxCVndiFOJwC2oSOk6SL2deGT2duoVT/vhc8DKgrQSjadjvdl0k6hFFMMA2m3H4xGem4wfjFAA4xEIuLm203FNMGDIgZ7g2IOcDrvI/pB8vTYLX8UZM0j1OPrapuEz/Tst4G34dUZ3Dc7URtpwxqOMrfBAPyAvIH01OXlD2PrubLhjrN2UuQxRcvTYtZY/xAzHq7hoVNMsqUczVCTk681SMnSYLkCCa2D6mPZ4sy92vyKz5i7W2fpW4GcV/lEW1K6SKRNpsbUwn3FIB8/DEzOc60HqB4E9SGEGg1qHjnRNX6sEEAIGbUPDoW5wbIvDVQ1vHW7tX6JCWm6Xxy7CoWHstMlcuRg/TLIq72h8idNJoPEgCbh3jgpaleOvxXMKmSn9Bqk/H73xxTky++pUiAnIoLsuhmDSuxCvBL37zTIrx6jZgYkwUNuLWJ0q4w6PTXS1jDQ++r/4Q2aCUPe8ScRQaE1THX/5RRyFS79pxJqfBzorohue1fZBRE2dyfurNDRru1VuqIEzKWozprB6NUjwYVq9zaj11jpAfBtegRspC2auVRxwS2zXpDcJVGQ7MU5muZTY7GfWpb7sq6kFLqC4ZdBPn6HEkBy26KmbzQ5PSb/LAN3KSxNN3//ER4XTZbzfczLnYXYSueUvB52MGAPo9DdJj9wh5w/Xiv76mPZyTj9Pm6FvBA11NJcUMtuFixXxui7UREF5u1mQjDYHOblxEKLIBfwZpw9kPhFzRaPGl7Vdzco8MnNuVAN2Zkh/HTH0vIFG4cyUwN9zV5naRlVRw4hzFS3WAUyPLSY9UDVu7TyqhsN3xsODbcS8Vl5DW2eawF58aHm9vPlJMp0d4RB9qt5ArJIyh/eFG2UCtuReCnpV0R5Q/DKdc67eZoSLV+QLF+U2qWhgVk91GccKgZIbX56Bxdj1LCMkCg/MpAqPBwq2qyu7v+ZzKxAGIYQlkz8wP6kDSZYJ1Zt2K8AjR/bq+7PcPMrbXeY3QGnQyzlxoi7sXnqLTHFFZElp2CrF5JNbwvJ+T1e+vU6S8Y23UdoK59IA8ZvegO2cfjSKgBIPggEc3Fc6sshqmFYMx+xIA8lopRXgVN29766pCMwUENZU5z2QqF6rKN6XaBKv/Kp/RPlB7p7/DhTUdn0RAsjqD7hhQZY+SZtkIGop/v/FqKDuQ/zJgTQDx++PG2Z9HMi6e8zh8UiFI3pCPVHXFMlRfuG0wy5csy5ZM2TDb8xAIqyrC5rcd4yVVxsnA6cwjEutw+30RyXHcaFvrpChNTTKxAXjD9Bc8VddaIsIEWuCxiEUnsLS+DEreKXqeZVY3QJRjqRxNB5ON/NGWwEGr3F/W8qzwo/AGA+Run0XJnh8Aqz8LXtFKNik7JF+JlYM/XpcI5/BRCod1sBq/bkUeEE949R9ckxGSwqNhxFHaVZcLWKisE6pWxIt2sJKv4oIVBSYIESUcSxiU4h16N1VQ+8vQwQSAFsiO91rXOEI+7VWSrhSusDXbSXShGdkF392cOkQjxNSbEnApSqm93ZWGB64oK3puHV2EFHAHvdidPh82ajLiwHGNEdEYsL4UvAbPLOiRe65TkZCMkvHRKN0oCYdC+/oE7grXA/tlMOsxGwt3GYQwM3PoNzrAFITkFPmpTpK7zuaEM5WfSUEAk7ugYEZRltERWn7wbvmMLxDXZB6joaPjbeyz/usWwxLqiuXLrFy+0nwf+c3yxGcaqntslg/dDHz9pLZMFlJ2nZfoGTmgVgn2GbY3LSlICtpi7zMhKctNCvXrBkDdT9r0Qs0kNUvUk4EZVnR1B9zEb+Q+ESXdzw8P7Ya556iyOUawvqe19jUMAXUnbnGEQbtgqmabgGD3SOUfDVoeOl5uSmUiZrBJgFj0bxX9ChTSN8bHQ3N5fQqhadDtqxDxyaDZTSKehS4KACJAPLDYsxqlZ0qzEshzIgApSTBC0rea1T2f3z0rbBBhvVh7BHLxq/hrZDPkKzKPRIYhjlrFa6Zm813f86QoAUlAiWHG7ZMEZVprB/zbEOjAfHLzq1cuYQlNkfNp8CKbcAWVSMZvkEvwSNqv7dAgE5FJR8QAenF5ITVaTfjymbNzXxhezAHAimGJzJpyKOoCIkkQiVk3po/AUdL5/T3rKFuE+sdRGA9XWZZhHS58osS2NsoXP34tUh7MA3UX5gzxdbdSINkQpx9+F7EkHp618LUPQ5ivGTela2tjwhudloOXwwBLDhzspfHEwg2fM45+vmgeKw/Llw/n9aXzDEbnX36hWgt+19x4uJCdWPyUeN+MgHisP4e1qGqsQ5Gucshc2wT+FD7X/a5gVA2gQwAF2oFGQs03qKZm36H3Oa5YWuYivVEBXEmy3LJh7SCRdKTU9XgampF6cFTQTqIGQxG36lOtTF4MwYtE6RGH0dIK7sErTUwH5FWSQ15u+vgg/bwy9ZChp0NikfO6mUycF1AMhFw+bHXXLfH717Cj/C34IgagLbptBIer3+8Vit5tAWNtwLPt+g82VfdhZUC/e2UalAtHJ+Z605RklmLcXCszZLUCjDuUv4Q5i7HL93smrn0sqh6N1j0vB3uuPTkNogzJbkyzmZxAn5aSpB/AfQEWCQGQ6fz/wh5a1iApHHkNzuP/FO+UH8NaWD6xSsBV/l2LgNRHtJPW8hK/wRTtNdEQNR9wWJA/dI98UKXuZ698VrEFAAMJT/RhSYFRiniSSZLPiN0+KxAv08RONoFo68fCe7daiNChUXb/0cc4KL18Cpi04+6aNNKV1+bwgTST6eUZvs1PnL4P47aWgeG7gfhBp/BMFJBWW7sucPdGZZnfbrmdldEXYAYspbg8eiv9Zj43fCaF6i/IgkRuJ1oec77YkvPNTvK8qeJqUAoOzUgKl9l8eGqqW5CVdHgjqFEjJTg7LB9QUsj7e+CDzF5jx2G2A6Ls9tYHajaKDmqVbKHU9llgqfhvm4aqBI/LYAe5m+haVTsxIiUHCMExMAge3qswXUi5vrfKHibpKpHncUJHQd7X4MzojTKpdQCOvN6vUnpiTJfWYSfSGPtP4trPtzioAZeTLAkjZ60tnZKC5bK/Rew7zLYxaTNzvbNNTYmIV21jAEySe6OBrPCsvEsLTXSfLbB6cQ7H4Txj45JOicH3PGljWfVYT7OpBhM9G5pQGS9nBvoNib9usWT9iWK6qTJfqIdcuTghHHdp7+ghOQsu+oTbtyVv4xMQzkA4oRLn5qu+LUqWJuW8YWwUot0T2ph6LfF9WGvtHH6dQHrkeTHiVVjnFKCH+LkPpV8N2ekGsk9pvVtorKOuieFqkqdpAmPI7aMxGk6dDp4WnHg1Kb3abZXEyjNmrV2+w0D5MaRoW7jDD2of5MoyRnEvXYEt465JPi1bpOlJr8uJtMKW0DEBgdcxY4gqU9pcyhyJgQLyjJQHRiHN622DZcsv92l6BORNcrYQSukaneiJZj8SOeVlg3lexiTUt/2EvyYajNn4fxNFqzu7aDjgW+7qvPQACevaIKCNAZ0SyOC4bSdEIcBip78FCplQ61LsiNcnEBqYs2KZ1Y7Ry1L+dlcDATrMtBnxDtz40VEVE+HcbXKYR8ojcTyTB9DDD3fvf4GvRpgeLFSvmhQGMXz/Ao+fecw1dp3RBa3/hWDE7gAF+w6htZyXap4CIPoX5zYjeU/6fiuVU34v7b46g7Wlou9wI7qCQjCyAhL4Kl6X4r/NkhBeDeOzrM0Mm7KamJyJDTdsE/MjgC6NQn7yWKBEujXCMud/ciPbbqQeDocdP8TOsWCoS1/KGhMhyNxlnSNClTH5+G3EizxIgOSGnoXaoC0pr0KjuaAOnZ3C594y7U9gW8Ht7b0+tctl+TqKwojBWItETj8OgPyf1Xi8rb+0sEHW9lW7j5di53pz90yQt+ZZ7bjM4X2zwlCJPyl0GvsSurqvz1QWSlduX46LQ833ixz1BTHoSQVy6qCYY3692KppHBcunFvSmMyR2fOo1uAMmfYgkUpRcD8BlC1FKOF+R6Qk6IDYswTjSG1PjETV8K6tn2/VTTEpjJ5RrEcarhlEDQPGRpNTxVXyndN6lSr3MzD7HM0hjTUz6ECX5p6miUd+ITN/2ukP82T8Po5avyZn6iy1O3swFoNp0yrh96RFT+x0Uu3Mp1eBv0qpcsngNq/0D2F8BafuaYBi8shfsMUX2LJ0Rid/ygyVY+04ernbo3XLaHir/lUPvZZzGLZWmeZyAIQrFxxepo90PQioOSRikg+MU9VySR+FBedbbuETvGDEVUtt9g8Uki14epHAXrOCLumqgeOGtuAAOfKvHzLYSwdLxq0LT0sPn8fllAZ+6ic7RWqBfMvtjrFYynLaNnjYtMe+q8cmnHAUOiVEnDhgfATgLIQIuj5dyL0u/mVrDIHhOfCD6FYQvPfQGlmbrV/CJXZqeokwH/RaYYvhJFHT5RI4JEoABw2kNJ2qhODE4ISdNfJCq6t7HjMyu1ffI+8Ng3avwQ7kp43Flwvrdqo9lmyh0P5EUjeyoTwQblNSiBB1GFAr3kE8KVHeDYZaa9q4tW7TrPbeNqQzWVi5NybZ8QdX/ggdk78bRzRBXKO31osjrkhKCb6P5VTmkRTjDD088+EvEFCTgAwE2j8Dy6+1LwotwkmD+zIPOgxbZlM4/y/0ThcKMwP8ryUzEpuiYlE+3lQF3Pll4umIQRZi5ex3RNDwlQN/OqeA3b3N4HF4DA6AvR20L6cibYRn+/hWNkvmA0iiI3uxQoUDv68jzqRd0P73MsgURRPU1SV7Xqyjw8uwrS1sqTZJg9JGe8G43wgmSqL2QQeDCOEezniR6fB3T47MwGj/lvgo9ft4+nl67AuTTpTVczh38eL7YofsCtZ5G+cKchR9XQBV8tDQwFeaG9CNPxZlrXAN0XJlsfTBLD+sJylN27B89ZF4OTB6DDyvTaMLsYhCQCj3q66r177s0DLhM7zYxsYZaptptwIQEIlVRPaF24jpWYdXm7dFJhKKvg/ESminJcaLN+oAHDnzgsywH5ZByqZtYabcF1fPI56lavx/MmZMQn/wt5qGvi+My6sgjHAK4hYReqnzj7HZU7g+Lc1AQKClzxhIELgdPn7CaK6zoFgw544cXezgUqkpHG/jjmd4Vx2zthW2V8ifw5jPaCcwblkBYI68oWhsbLDpmqhscC3CnbSLYRqKgLzeb63ZMYo9IMLqvL1XbGu/p6Z5CgstXbuHTJT3KmMCfDO/oobaAE0XgsHOOXTfdJUVxS9Tid97tHGMvPxSyewZHjIyyk+CEd64UqTLLDlC5L3T5kcEylBQqNweVLVcvyrqUwWObkXxnfDpkY2L5Bx2z9WdHk0DwBmXobmOJ27ECD6GDco/yKj1pqMQRbn3xg8r1MsHF5LfVBGbwFOuOsB1DmfrdqEG/p0hA8mfHmQd7ke26fZ9nICpYEmA3WNVF381qstabZhWxqqRdBwDorq9U8EiqQjKnZA00iUaKtUIcKiksmUCEzmFWSuRuN6OTA5d6QFerEqUmFyNuhYBxHuaXezrdX9nzgbQJ/Tq0pIq/0AhKbXTp5BXBzroHSBLjFvmnxmcPImOk3Hjb/tY2EiGydhLlJLCuAWAfcOL2pjw+ppYX6nkZ4kTK0cFAjVkQVsZDP3/7P7FFAB7PBoERwASKBWmaPh6IpuN85yJomct3vME1UAE68XqQMelFgo74P8LKTbJgemklQIa3YX2AJAVvYSeujdLO71cripeMnZrPmM9xlLO519GYX1zPx/LMj7AzGHyAN05mRo13MCMBdSYuwT2jrCt0xY/Ak9XIpJaEFREOzuKkBOsTNS9LrPdChaRElM3hLSiCWCzjL8Yl13+WtoVnk0CRNISYoJviyC7VWdmAxyMKzDSKSWAY3LVbc3uwfWiCynM04rvzEIV4E5Bcvdzf9Who63IoK021BDfS5sMZ/YVXmJ/7one0t2UODwYnD24q58GiuTLKRjYLqMYwUHJ3A7+XDkSBayX/BzxkgLvwNi8pGDY0rSjUS9DlsAJV94Bak+brmPQcpxngs88yllWiPZIXdOgIC80bv7t5PlSryfyyTbHD1I4jRXuiKT4wx9HY3ObfVUskOVXk9H6cKxUQzbUeUxwWk1dmKDAkMf98fvhmBnOqx94Wp9PUWrXwQxn775pID7JRo7TFQfWXMQBWU99nAAUYjBGfdQh9cnswDBh2Fiq6Dt/0F2A6rWGVHkBoD+fmSiNYOFxPBWhoigAlKppTAYlNm0RH2FfFTCWQ2ZQ2j/dSk7SnsI/9go21xoT1o/N0RmdPYcYoirE4SBMbOB7lzXrjH3moYwf9QdxJO9Sy/i1LYqnfEnrg8B9VgBsGoUapZICzeAS7ju9ZVFSdc5kVoM+MR5QBD+AWviZUHptMWS9QZMnYRLShEKQgIHOZ8upz5mWkDLLZXmseQNNFxCMHGhuG88Te2LSlLhHIciVnZv7/69zKAo5dO/2bekK7WD/PRs/LCPSf4igZ08todzRjn2i5AdEyjm2+vBQ7YIes2XwwH9THHsXsPaK93fQafV1HZYOyTYvJmErAgvEqB8EPC00fW3Wj3CQ4mAVUYJA0KbJATpY9TF3UG6WD4RJHNl1X1H46dDEeapY/TjrerMmQxm+SX7NINFC4f5L6PGUgqQ6cGme+gzVcTpF4UOu7FYMLJl7QyMxZfCKFXAPFi2e2RzyKthUgpRPtnsxqn1iq3HXLlWV/CJ0XlYMdYhEmksVzmuYCSAfHWqiHdx+rFFWrq0WtRRazG0tSLhM+bUNIXt2G6DCkp5x1BkBqJmdcJqmvFUtZRqQEm1goNAFhgfWHlHrY+6kMXAVaAQgViePCXaPAYgovljknObRjElGo24/Q88lCLidqaoCZTnym4ZRcE5Hc/yn1CNHRjdizMiX0Yp/5srA1PVFptj+1VQ1zA9x7lZGD/FU1L5F7tUcMxIDmPRaLvC2acwGSFkoLt7XVaAA+/EbBsQQwqqC5tx0iJSemH8YUndVQ8RAFyPcEsViFUNXjFJm23bYP0nda4V0oKa6bWcJ5q45NPV3y1uQSIH+Z9S6aaDvXWIcAIMC82u8LTQ5skD6f9X1N4EoW8wp4ObIcEP5eq98+F+sUqiQ932mlfEOKLEslu9ZmXBjinfGwITCMS5TQD6AsBSxjfYPE4H/Hf8tC7U6mygnTXe0g8yftc7LlpAE/iuomlj3A8E1SPvIv+BBaLcBmLOCfytXK540P7EicwKp8d5E4gR0m9ugmojjPqGWTqRvOlYH5tK6mguIB0gUXa9CDIMZsrl5k3WqxNNCtk17DeC7yk5RDH2GzYle0AoLlmquKHbHXHV4HojFIat4jxtqid/iLz4XhXE1mPdXRZD1WLQ7NEuDqx90B7nClL8JiEf7IqJJ18Z4gN3jG/BwnVWvUK0NmREQBc0PxEc4PBeSxaLYn6T47Eo8VX6Edcdr6DLH3zNlB/25VUNmdz+JihbGq3JgUzboZaemaH6Swnp5S62+7qVVxMVDp1ObtlQio5SR21p208IZFsL2BJT4f9SzuLzx5AqMJBz+GeussKkl0p3vE9zMF+lLEZbhqocvMfP/mAVlXDbKRFG2KZ9yXXap9bEA6/4NOjJ5d1VuvlO3moZDDQsrKeLWL5lNzOKjUlpD4+YF/wcyJmdxOJ09sedZK7vrX7rsQSzVPhdX5un6SV2tluJpqbB9EpwXHSn+JF4bZhE6491H8VSbWh3ihPVLJhLJcSBqKD5E2UMclHcmED6bYUCXbU6m75POI3D34vi+SF6Hh5E+YSzf9a/Am099nQ5t2Or0aPxUoolSFKxywcXkXUxq8eacW/ZnZEXqkmTkyPu7cFve+uLt4oP+CdowvCuqd5I9/VgvTmwXvin/YbL+rNkHp8j961BEhnZ/TcG6OIz/wu1Xe0w2osf8vQDDDD0npdq3AEfi9497xEJFcjjoVo22QIPkeBHBUkvGVpIry3HkLZLlACPMsc6IDvs98hskjlv7Y6medrVWoYbS5RZLJVNaB2+4mV1K43b8yiux54ec9x7RdgCEKstfQYBju4NAGOMGILyNLFsuyRFdDr87pw3WfmvlBT5M3ewXStz+zAa3u2unumyh61It8HDrcCRcIeTeSYUCxkqTbuGL83oI/nksen7boVs6fOMS82Uk0AMaPqE/rqa4dx02jhWAHRngGftWOy6s2p1HVOZvMg6vDS7DblEIj0PwcqxLXrJos16vB0ExP5WgBahlJLU9590Lx2K8ebhZGzutksqFOsE3VdrTZCRYM7QEXgHfm9mOCv9GsALFYmR5+3MUnRvrlXnpSjf+vgNuqp+J+NE0lGy3rMP4hukOBsc7kkPvb3K6a4aLrVzlQSgGY38PeY9iXGse1fW9QPTtmyhgO3hoi8wBdFAIf7uBS7Vq96/OqJ+d3SzYKddm0lhRE7tLojDmXimhQLru1N/AZtK3Aavhd5Dzt+uvqzyie+jSdkNLXqRAc5FubDVlS8fRv34Xo9mRFboc1dEiDYvMkMhir03a8hRm1yH4Zv8HFLg/JWswHGAakqrUCG3uZVKqAGhQA4Ffv/uUk6Y7fhW0VR4kB4PAsXPgtzJsj6qir4nykIfWoom+ptFO/vwKfbc345e/EY4WXGUTx/mOIjBX5P81u0fA8mjRvYYj47LSipDHxoHtqdZaFO/S7Rgd/BCXudprfr3pR8gMUdPrR6ZVn33dt9OovSBUvnNt4d9YusZ+vJRnm4z4O4kU+mvtHp3bgfHNDDwbbiWoyZM29uB8YEC6j26eU3Cl0rvUTuLIyNxrdtAIw2uOW+U1HZRg82keTmpY0h2WSKhvpbVm4eYPCJsMyyGFSkZ1Jw4L3JxRibI0k1iJ7qccdSdm30Tf+N9krPxki/7G7tB/Osq/c3TfEZicsq0g4I8JqThucFPasP2Qg6gOPFiSGbCpIQXAVQG7LusA1n5+uI905cpaHQ8ZaWbbuIC8XcixsvC81zloU6bvJx7OQ9IY9mlKAIU+OthysGKcyp2b/UNRZRaFhJFhM/8bvmAepjDbdEC2e6DJIz8lJ2U6e9sq9aSS4828eoWY5+X8nr+3Yjpu8a759elAnaC/Cx4NBt0OKtc3uF+WGB1cUWW8nhhEeErHTT3FOrBYW58bCSOPxllkg/jNqh3hOCDQFz5G23FW17C1YHpVW/XDZO7HNgR5t+YHAiIGB3UmaOXw/JtcVWNEPcj69WMY//C8LmH8tUZp402JxJzv2lL0jO6Si/z5i25WQ9de1z4xFYccS+Dz+4xmhPSE3zXldh0FvFV9MTRFhqM+avBks2bqtwYPFiceFuZteGC0rEV9N09Aa6yukSeBQcDmB93MyFzRBGMXTBf8FiqGywuTvp4+1Qz+c7ox+oPIcm+EFm9oPoFmJ6l8wa5AIy8TCWPHDt3OBJJ2dGmdS7TDUUTdhKZb947mFzV27EGMTuUjqME0C2gw6gp2/H5wqYKxPzKF9GSyG7Mg/l+W8Vj0lEMYkdeIa+FONQf9IJ6TojBUQ/4uYD0/OSSau9YCQDZBnfSyN5Z4mGKfJfHZzUfpcE4HxEaB1Parfgk9rlatGl1jXBPqlAWh6a6VpQ1//eCdCIaXAIQl1MVhUX238BGgQJszqDvPg2YqccuoODlf7hEnkW0JZgmz06k4nG0c5u7X5wxOt9TXoovIKuc1cO92UgOYsIgH7OsOcZEdYBzNHPAGOhTfbJbhoUsmun5+qywJ6koRmLCg7jPkr4CB7tSEbrp8XUWPhs4RPpj186cGTkfEs9fc7dHL6bBGGyAY2QJgh7SR828WoLmu2NJEtyUDWdqwLWOswd8ru7jbVqyn2sLdWhOsxygVbdWx+c/tfT24fD1o7cKabHZwTrTiKLxmtAevvpjbNJa7iZGryqvDfOZxPn3/6UxFem1/M5t5/0kjOklB2WP5KHBPCjvb0Xo9y1YZB4q9tx97Xb/sFQon8VrNCwD+SJerm8c9PHZAvVpspJoa7Bq+YOrhfd4qRZ5AfJLz+V1bMHxXx65yre6+boAZMVH9xOed6G+Ox2fathfqjbGfVKcTM/UF0F5CA7lxwA7C5yuOKN7Gcx/NthOX3agRHiTVS6UxEQbCIClCIyyc+8Qf7JFl4A8GiNDnA1gHD3k5AUMG6bfznPA8nJt9/7L5Q7D4btCr/lZy63YZNTxgEoL5C77UGd+Y2wDcbED0xMtoJx9a5ebqrVMXb7AdjrzScBfXDGppb98Ye55GS6xvxRttegTGcyqj5Y0A6f61MBvA2gOYWgXckbTCGA+kQ84eD7n4ECde4B7lwPThl5+8T1k/+4ojHSX5Mw3Z/i1A3thrmW9Av2ZDFyvag4DAtLByUdkBeZV9QuN5Z4ffr5G+F6zLn/l6sxH1d/Y5mLP0WciYKNQcBye1u53+wBy/W7W2f6M1qcX7EDP0zijYaB43xYMKaZ19krP68CAC2E2oy5rhNrkchy8T6+cAfEGBucU/y3VM1d3eeyjkb8/ng8L5wZMGdFtRrKzu28R1DoDf5/BwlAYsXF2OHlj0cj/PCRLZMvFBAlSbCaOKEXG7Q/J3WhUukcNPgQYQJDajTFm3c3ED97Fb3SgphZKRN1krmE4hMI1fvpsBRHH97+IpyeFxcTIoO2M47JBGiC47QlAeZ/hkhEmyqmpYGefxDqQJ6nO8l/vGKpZzxKqjRNtr+6HgNpMD9WZh9rNbjlw/CtpfS8R7LSJxLGX1WJ7xPy/PtsJTyaTecE3yf6EJPohk8iZp4YBduW/mZ3j5NYh8Ka7+DQCPSwuxCr01Nx+rptTkmMLoMxcLxifh1Unx8AHs7pVspoGoZRVNH9gxSsfquHxMyoUdsxoIf3mb6QzK3/YvLOtyGNntm9ouZBtlMju1/7MyQe7PY1eWjLyWYgJ01LKbvp+pM3DETcP/es2FDd7ecKCsgEwnsZ4Jx22K9XQRoAOCAsPk7Vx6G3hJbkIq7ssfcWLsMiKRfSEmmDsFq04BOnB6VSBJecGN0Z2OX0AG25PC3UAbWHTjFgDT2ZnHdVBRAl7H8HADy8lxdR+FB5CXpWdhRmUVSN3m84JBD/06tdeeccfVvFJO7+dVOQz/5Eji51qRA/s/cdzunxXJ7eb6Y6f3n/kgCVxO+Rrq9Y0UF7rvD4TKj9ZL8IVABgwbLw7W+AsEuGT1BIf9vUoyh0nLzQpMAw1iHLmqDBqt6RWLBF6juNghG01meTNyr0sOnGXlc/YDrBA7ZS+v10bT9mLceci2nZwaFDYYrEQatPwi4R/iAF5JUUFLUBYrTEPGn3Zs2XJtktrxAN8cGM6b/0upjGK5ygoDwSbtKeFxh13c02ZVA5wCq+CkPtA12B01y1BvBxV0MiFwJK0BjrUIygp+FHGCWcs4HZCb50g3Eqmaix8bGN4ubbsGblMr6XqKxYT08HtWBdAss9ADTel6JtR0wqgu4Ld5mprO0CARwVeUr8eiPI7wsJrgge/To6KIIocWmtp3syAQFoi/74jt+Ber16HnNXHGd1gjiV9yiWHbVLwCNuT+KZ+tAmaw2X/yUuMjExK9S3l7cpo+dBklCLxwCZr0tpGQNrF41u1lDZJr0pNrypK3m2sKBPJccS+KxgxL5wRXEUhM/azJOu5K2T9eZtVdjty7f8p49YHjbwAeHPF5r9eveduqp6VONOFlW2/rW1e+1x/ZE1Y1LZorxSBckznRa3fJN980d19t2R9uE4XlGqOGB7HKde/dnJ1q1Gv3tsshzM45Vz/OA87NTqrVs+MFL9UMr13sUpeVfuiCI+jDu0AG7iH8/Szsm1MzzyF7UJ6d/Kfc0Z4b27jRiTLECrgy87uG8ijGLn3z58lWO4bSs7Cat+We9j6uMmxZz3rNkB/eZ0+w5uHjfQBO5PKHmCSmdBYpF/UzHxrXhyVaF7SKyiaPjZOLUZEnp3zjZPErxEy3N021B+1SEMJ7HvfisCSB5FcOyAv5nz32F0fjboNaq+YDcZMAUSvf/wAArgtr4kFIjLUPk3GuQi8OiRqZpW7n6ywRaMh3XO6arYEdnoRSAB+UwMe6Ff57v/ajAHj5n9GqG0oIuxtpq7eXgfP4YDE7jA7b4lBchKaT1QXUJC0UnaB026rP64A/QczYnie2FqgQNp+RB0NLpNJRmBzoZWk+wE0pAGGg9TM1Ro3+RfRjkbaN8BMtBe6Y5CpMefazCzkgb3MI/j5XDKRfNinQzQqIG6VR3JMFQaEFktwl3eyOGJZ/ckWubpNE+ybEmT/Q0VBDBO9aTq0WIp3epuivFlBmCUOMqQ/jaYNwNtrt9L0Tb4DcdAkKC9DTEZC8OnPXBW+XN69h5OtVwqDaNElvhcnClb7oIa/3xCtsiaQ780HZuHasv6wJU9o9Bcnf9iu9zsRbrT8jNxQnz1GzznxcAgkJgMNoDuKp2hd7zX8B5SdQMfKcB/F0Pn2b395eVE/R3fQsOAynV+/H57QcvdvHJI0bb3IVnGa/n7sGgOrB3mh7jAs9ijoCaGl3fi0N6OdPn9Vb7zkP6mCrO57Cc7bWevn7Lbt/sPD+OYUR50+Ea4Fehq9I/WxkkgMM/cPl7dfvlWv7/C/MHqGEewd27Xr63XX1k7UnPrK1snH6muE4E9SGP/ZSs2NfIn73BFOPjAr07vA2dD9wFSl+8I7SKKoxfpVvTOcQejPYpDvmPN+38q5PeiE1U3vcS+FntoVbqIyMFaOqdmhTfU6Soam98raiL2CZa6HDXGPKAebfl6Y8hgVnVK65ygi3YLODHyAvDNvDCHdT0WTEwfCu7HLlAonMSIBvAGD34DEpzbJ5PwgrzW2om+WjnvHY94vGWz8MFsOy8vzJnvvFGtd2bmk3JesHxodlffDm+jJnK2sIrR6h5djt0qNY4yEHzyeXAsvfNjm0rt99LxKU2TUzTaOYr2Jen+GOTC2km4g7BLh1UUPnBndTRA1c1a+4IQ4ibHwSwXdLxqzF01HvYGbKO8er0qtc9u58NwuozWHourAZweA86D5bg+yIiy/6maZvPdr0+uXqe89VWMqNAFVnlAr4zD3WQ1JMJBVT48Kngyr7dQQ5XgCfnl5UB9daeKUXgvdfPtnJz/pI9WpTb/t7H75ti9cXkP1LPOVQwG9cpm+0Nn5LLsYrcp94ITwu4TCrrDEFM0Cb/7VgyOlmGhdVccnqbbE/S4oFwIMDyswZozFyw+znk2pRb8sdukYZa+cWRXENd5oJzj0FaY3Alia4XYpc0h2Otjhj0S1Kw/ZKb6T3KlFsegsbrLJJzIxBCHHlrRnwGBnxsV5vJnwLZkskd0i941k4r+cu/X4wY1EBzsMPmNwd4/qlYxYH/E4LCcjlYEyf/rG6FHuZ3AFhLYJVmqMvyoGj5i7s3tfXLHZBhyo5nDYobnm+uzlzFcHIMGPocBUj5I2IpOqtERE1mDpDZdzhvTs7ReFX3ECUw4jAQ2SLnyX3bJ5mgrFN3mTOl5WIVHjrFSN/knx/H80MLbrGuoi0HIUAf+RwTp3cdkO615q8Peh2wERwCak6b7uKQBdhPrDJlptw3LJGqM1CzNB6IqVtVkY5AbV46xGmOvJ2DE2EPPgNVgF/0vvKwZRolZrFP8bWrFYl+s0IG3K7rVbsa58M9wZzS4qH+dk6ZOKx5dFFDsWnLGNZBRkYIaYvFzItIYRf74WKaN3O9jrUUk2sTKqkboaVEC9f9BIer5ThlGa/tz+WF3CD+IvV9H9ym7Fxy2sJO80vzqP3ks7vuuSLLzAW5uJ9SKUNsOLfDUakE0e5dKh0j/t/TK569VFId6/KVd95VDzSEUV/wR5W3xZS3DJcWYPZJ9Ek4YowWf5c4Ppupgadjce/GI0+ze3LQo1mx9LJL/i6TWN/8Rxbzcqinpf02OiiaC5qsPg5gEdwMWMer+o7yNFAPCrsRgEHSrGhRDe5VyOX+E+VpVL9T7B9H5/HcumcHFb5ngkZW7k5wSo1q6UA3SJlMTiEIRc/J9bf+4u0fktbl+X4j/bDFf2uqVaPmUf+j4eu+stp7vaLE+cnw43z/mcP2uFiq0UOeM6HbHkzCL5AfPfRXmdPPnTTVN5eVxza32PmSA7AQ/ulCvlFaC+fJ3zoCp5Bl+/0RxmhiF1FsCuWQAkl7X4qLC+PEvYrIw/9sdvvDf/x8+/Nebfjzx45nnblon/vMh/3AC4MzcHnDP4BobpYoMzoAPxrZ3/k0TaBGjmkbNy5amWmvVV7E0smfrJCIz81+KHxML8LAjF5KqsSJ7giUWLTI1EmBMMrpqmPi54lkDcU63TyiWOR3gJvRfbTyRDfRXKcfZtEhpGoB01TN0VNgC4ByddP6tBIxuKj4DnER2Dm2+vqRCq3ZPiqs/wkBj0npbUXaoCCOPVRi7LYxZBKxVywqVUfR0joReuhNBbvgGVb0ejIuq3/53ycoEv3NR3x9dMt5b/S9c3yZP46w+9odZDej6TiF9Fhu/8yEC/+DfRUik7avdGz8tbTPM4Ol3lES0RW3dfvYGoar9Xv/lshTVpn+SiE0mHzIwHarpwMNcIkx6y5z/GyboAGuALxzg1LKFUgikeCSkMKU7PeMOpx176CqIPDjdT3oHPzRPAs6oNos79b/musYFrLbfEfiNurIh1ORI6u4oKK24NzEpeFBzefqDFv8UVahZoG2m42S7SRfvJyqwOAT9m1iPXUSRz3wVFqEASrCnQ3/6eCgAXxsuZmz1nbx/avYMAP+atGoZqcrmgJow5LwO2MxtU9mvuGvjsD5DdHa+RxF69DaZ2KXBrQLo2msmr8Bt36cqw2Wrc1ApNfg7Y8tD9yKCw+lM6Q7OpK+bH/aaMzVmqjNOd+swUYyrzKs6ea7kISFPNfFlmVvEbeYsgMwI3IrEU1XvTi6Nvltdubx8IfFqC42qnV659mrYvffgRpbgyvMv5x5ti9w7nurQ53S05HJpQJ+6GjB7S2I2VvONPHGV3Yfj7xATbXW/+qPqX/JEtbxE6zyq6tY2rJOpwCvqq0XATIBTHjjswJymIvpYeaeer0Z+WAf//prau3OUFuE5zmZSAHaH1FTfomRs/O3v6RW2yjGRoGWSXOGhEONJy5vRdBG2VYxT45ajAEFr1dfG5R1x7ep+HHiQqRbXtAlvefvfHB5Oj7X3DHctN5qlXnWciuhN86Bn3hioKIkOql+n9KF7eDylWRg/xYDYEtt3fktxKjQO45Gs41gn66A3DDaudFe0w5o8NzOWgu0NUEBELjYYvvKbMY3Zoi6CUFD58ZksmPK1sLfhomv49zduMguA36Yi2fC1rI2mfh7uQctU4Schtw/pyImbFyseuSKS72KB3wbwmv9wdguwCRPXmhcfsFIEdmUDgPnPfC/RMuWhBSWjnkj6sx1aXcPwxQiQVlSchmu6oqmwbSI0PsuM7x36LQVL0faj9Q/eH2++PTYp9eh5PVNBL9RhzAz8y+3GnhX/jEX66o1adakWs+pfYVEzgMb7vYWDajkAddXE7xqGii/Wg3mEyROr/E8R5riqTIar7LdkOT1yDmztTgkmcXI0T5baj+5aATErOD5KtLhoR6eo+SvR0mk8DX4sNIlQZSPOIal/DOCMqxx6xhe4U60WREk4wDVDnG5pARMYovVBcE74C4B6zpP5aH7Qr3gHoJ8efQ5vWU4E3XbdZjpDA069/VHzQEv1tcdKBbE2kOrXgX+3cifFIO/U/KMN1zZYr6JWrBhs2WaX8lz/9hBH1+ga2BQ6wZlWjdDsvhxcz/v9rO26p8c3inTG+/onoeV5xdEGoDkWPGHhPt+eKPEgyDkTeW8YWsvXAoBHgaDWMx6VPkuf9HgjQCEgsfDfKL+HHpwdFbhO6EdORsHK4xHb3FG4RaECihapeXKtcdiqvw8oyPPf7P3kb79CSykpEvq+FQheL2E/oCu8S/HtBK+dmK4vDxEW9jhM2eD3bkbKg/stdBQH6CWdKvgo2ZpANgTw4PinjVzXYy82gr3W+Vn8SyeoRmRc58U2z6nZPh+4d43cb581Ng79L0IfinfydTPtCeaqrLWJ6ZDJsgakrsw2vGzLFFUfqFc1qzE/iZ8U6Sv3/g9/bOOuQS8yVeOHagHc8sR1tp3njCJXAYY3+AISjgYxnnzIgbyVBPLlvVnvU5ZdqPACOAlSOdHzteEkzXiw/MPqIe+lDGCtxtGMUQzwVxRhhJHHYqsR8ZyD2lj+zEBBMj/zosPL2z4ld7wJpRpweVkpb1rQVRRgKIjC2PLNS0GO44kneooWwUwRwu6o4icoocgvKJiQdG9iOEc50mB8FwF4FPtTuLYGgMnSxA/lpfTJxR3nq55j9lnWt33Zfl2d1zvxaEciXPfI8e38b6Lg/YVPqUChgLRs3av9I7RcOfHahAU4mB+hipH+bfJ3E/xZV5e78PJNMk5UKrmNN96alDfKBjOOVgfWolki8EvKGm7Wu0/ZA4FT0urkExQnGwafhKjsgwwRkCSJJgMkWUgvAMi8wxuFsEc+WhHYR0ninYHvvMuuQsIzmj6O7TqbAGAm9E68KsYc0Exs1DRC2mAohSbH92L4ogY9NHJ8dEdURPRstbrejkXab+3+vBWscbHqmTYDNow0LuYtpAW2HU8GULQcAks6FxgR/9oEXq89xvKccDju2wBAAy++mXBwz4XLXvVpVH9D1bCdjWpavJXCOS7FLkiW6WhQSx/WzjBCatpOZUp0hXitdv20LdeGnELlGQczN3KWNzUT4zat/hJJzct2WsmMNgzZZiNVdsTnPls4au0aoat0iU631/y/X4M3MyCrmVG3eNd+ZKetQ5ck8mSWigaQF0zqn6Ca6TAh84uR8hZAPqb2G5qohkx2VYXqA/L1hkaZWFQdv6S+DsUeTxZWcNMUtCBZ7p2tCJ6IYjUkepNmpuUOJxNqMFVB3nFC6LFaYVzkvjaiQmP6w77YUJ0xDxcRY4gts32RIVFdZSV+0wqTBTPKV00AQ+aB9mx6SO0EDQDorzQvq3AP7jyFy1sv895anR9FOxnWGWisInA2wcn5Ke7RmGNIOlUzvMa4puDB9EIjnBXYW7VySvwuUY2jCg+I0nNmKqMomp6GsFMmx7uAaQki7zvvakY5bu+dVCJ/R8VtSLSSYzugYM1HkCxkRdHtfadYoV/5XBFwT4jnBnp//PtgfDnK1OZH187gwAzbCH4gQAkXty+UBLtFTPB7ZJdVsOnAjc1PgmRtRT5lTLHe+IclCBDZXX9vnvlapjRQz7WsiaGqdLzln/qCcgqzEyRHSMgktNY3ROHb9hZ/qSt9KXTMuhEvGIt9H0hUfnCb3L9MDMhf+NaBxPQrSoCg5veNSUUzc6WNn7IzDR9pVDvCw0uj77+/e1wUO3QG/J5BmuEfofI3oWdgMlRajkf5L4ikXcz5E2WLp7CmuqTIanZvsk00CZmb6GVmu+BpeHh9+PguKbAvlq3IdKO2TZgjrvBvjBZEQMBtRlAswqxlA1xQoMnPPaDIjTItetk8u6WDBHIoHrdbLMpE/br2TGcq/Au37dVnCiy27Lcpptljjcv9EVyDAn9iPLVoTRB1ilS/CkPflHbvv+B4c5WSc4h3FBcSvABjHoPGRT6BM7SSr69ljY4d+9yt3iQt4igD2HP0I/CXSwentM2lK80DPUnuoCpUpSMTYGJ8LHzGzPgYjG6XEBaejsKtur8bAo6rgbDc18R1Xh2uiEkb4SrfYoQ5BEE9+r+CT6FMvA9fEgLq0VHRKhvTLtug2Qpufxq4eXyou5bQvt/19DK1ksSymPpxCv8nucSCpxDsz14zsubKZXJc1/pXxsrsfabKBafBy/BHHZZTGtASWoSC6PEdFlAxsPH4aQ/nhfp9+E7GDhs3b29Tkj9dl0IC4Rhn4I1lfNL0LN9VNh/SvbPIdNeLDlN6b+YzKlcFrbXiuqBfpVGBB3IdPHwycu/UtAeHaWaZR81dzfa3T5TU/Paz0OjNtHYxTo2k7NUWi8FyLw8F5UDBfZxcFOBjpOCFmevS8MJYC5XHLPpK7voQk1fphKHf2xHF5rKRrhebFgyd/OzUg7aJFhVkljycui82YKr/jK/X2G2fLsSxbmvdDkV5bIBmprW9Oddt8sDYgLrsaPXVFDXyIXXz6b16gHmxYgArp/PlRaX71A29feKi46sDYN8DTUTbFRP5zxZc/75IsuRf74ITya+TpRsqaQDFgMpcrLJMMDIFoO76F9scI+XNRQf+wIT1C/4ViCPQuL0wwIng1TbWxcDE3+uNK+5qYdiTbMbysqSBXGvvwkcD3X3pGcbrwV3X8XCy4W+f4om5iHBkIveso/0dTm05ojdDsSxUTNcEhQLTkjfqCyj9KIIcZ830kc4szNswvh6EqnZNdEzp7bL+hKy/wh9pAIhkaVvmbJFjfGn20quaE0+gQQesG20WM8BDdwtpEDKXlZNuHC9IsYnj5768FFXAJ20RaCw9zOOYITXzljgg1GltxfjIoIDvgKVBkBhJydb1LihWqdU8swp45/DBha54ZGpWhMzOSYyM5XauYUV4zuMHAwgbmuJfoLJLBugevdJUGO6j/LCRkwZwnkq5KXkfsukMTjGR4eIRpubMcslyz6KFkJj9thGKyGPxJBMMU0ytIkQZIRH4ybaIZRCiWDw36eSmlcZeXya9uUV873chntY1mFdjb9LuIwqz09UFVlav4Cv/G4eeO9CkIGP5T2+DL57DwR5SA1MXsrUjPQBbg6A9994X3LfSTLoxr2zPm6jjDmmGyx0NHPA6gtJticUsirp0NAtb9SxvxcsHIquF1Az5wlxrWlFsn506cL6VP0Wg+WPwNCOC21HK4rrjXiesfMKr4WbRMvFka3cukveV73Z7kXSqqMDY2kgpXqo2myP5SA4z1vGjLUM29PoQUPeXPp+3Lo5vAtVzRE/2F2e75A6jC8R3XDZJsw8rkZUsmr5fDW28WOtux5Kjxa4RNOBhEt/iWXDJgvefUsi9vExqRdaZWLAKmssYr5qhiD7T3tbUy7+aq5I3k/SqQTqiAgIZC6zhSzRcPgGw/wlekYqNTaIhIs8L9ZLiPVE018k4fuZF37t9N4fogNFdzyVxnE8CX8zRp1Sb44EjYF5yw7IBCpzPKTHvdvh0/qBc4bhgyA3/GBSz8phrUGT8/1ans9e6D2oCKqC5fmk6UXJHDq82H0dT7iYvfZHCLN7hNmnpshrnr+EHP42DClelPD391wooLzo0qLX4T3SO0Fitr5Pxr2aQ9qS5oFLDco8iSWlTxqMuH7o4gJg5a8PRrbvd/f1DI0vjwnfvcd63+nx96tJrneJg1IzQs6ZB0DQbb9P0YdgfbdfGQuC5HsVps9VEsg3DnO3urCB6yhnhiHhMaFIW/Jm58F8MRuzqcI/21k0HMDJZrWQq09mfRe2NKNzxzyx386C7hr7uXur8QPs1Vr3ueWx7m9wQBmIjtiASOVQMolhAoWHj+aB9AO527SylsWEN8CMw9QD2a1D6SeNvBMIg2einHy7EoJf0qE7UpXE09HQPtjJS3BfG22V95ARGnrOx//zfOz0r3tiCCACKK/t++6JKk0C2knXIXrG8vR5cOeRECu3JlaoCvFpFVirDg5GDhsRnt22zBf8LcODAQUTZFsuEFVuNKwkuBkUpn3OVDj+2JyQZE9LfK1Cz6wk69wd6pBwPzihS8wDgA2/nD+1PzCv3GDQaKvfaKNdyzme1eZQca7C6OF5KwHQ52TxcXAXPoy0f2ANWtdBqYWkSxhnHYjeuv+d125+14anvtJQHogZcNcL00H+b1bfEcbuxNR2jBkWIIBRdl7oKPJbZKU2m4Z1wqApvuGhPrJ6lNgr0CQoOmZj+d/LfpfeohlmNLcYUs0ZBl8F4LKhAI68/EEzgU3EO7jZfafdhHBslxlv4v/wY45LI5cQSHx6bpbE7+N9VtxBP1fO9HQO8rz2hEtPoBNGH7OmXr3Tdtt1nm/hg/VQKEQETne1etD1jRjJ0/scwVGymFEXzKyBg4fGCwLzgfdXaTxw4L4e1YNFPhb5RlsZZdUwzLGpndvOtN5OvfASwsfIPQvq+fXV846fyMkM0WrUjVZEe/f+/kPJclHzwTP+FkpT8G/8k9ZtMaBmYH1pDgWk/yKTNzPmvd4HZ0IwCg5ALsKsB0ejhDjdDorjuiwMRfzT8pHc+nqtHE0oeAkbn5wH5XGGdIlMiuRvRbPOSjpFRUTqvNCr1QzgKWr8UvSCb4fqLNDvT6kmRnVeMRW2GUWA9KjKwMPDZPxz+z2TrOmNeVsl6EUpMQ2idvWhGL/FYbrKxGsh6uiSuwZ8zmWoEFqEmKBoLonEAH1L9Io8l+aBQLyIhtVvPn3EFB11evgoypBqWmO0zC7FQDI16qQo2LObOav9UcSQIAIelm0vS5ceE7m/2XjrZu8Q69djELcV2Cqr28/ry7VNI/Di+SNHMPgl8vseM5a80j1CaayKePpp+rySaCjoSgabo0yYXiT3BljuRdtZQR1OcEQA8AgQFngGo9HhG2NFNAIWA0CxgvrwH9TOaH+jC97/ji4L5x5XriCjcrYDVsL7Fxji5gBO28P4VioGV/BT5+W2XUnKKlL5xHoKLkmADNIVBKa4d79WLynbNQYRNPQ4PO/wuTA1tbilZaK6+zQ812Fgnv4g8DuDWC6PziPyhE/PBjonVGYJLeyYYkfu6Lrc79MX4fDUbJ7g/uGzMCTNQouhD6RhdV+1BQMVZ5wsyILM5jUhdaWpERUWG0g80PG5hvmDaH4gEc3m29yf8XRs7DWaoMI5naptAd5sV/6q9TcCxEklTOQ47JQLmh0/Zp/pRd3XW9wfC+MS0lI5+4WH87SvXp2+2UOfYgRgOrsvAwPU2P9sylaUlGKRlt0YwxzPW+aJfIVGPqCSzq+4aEJU3pnKBYPN267CcSZP2BBsuS7B/zAR4d4UKlflLgEEsnjbwAHfl+SHYyDakKtRcCbjOaJvjlZm5D7ZoLjw94Py9WD2TN/WAY3GDt3ehBCQ4Nm9YWvANBYM5ChtfE40Ej2f/iVPly8mAWI8RJbbmNrdgLEa47OK9aWhiauo+ADwo7kYKCbD7t6Lu2/13NeSxiiFZPiBWTl6icwmUKdxOemZv5V/8AuDYt2c9xD8+bgKQY4mxFr15W41pAaoyDJBhoRgdAwoEV2bk/zpda+p9g8Ip+GvZHIfvJCrBJwy+m7ZZiAFwnHYPFxMo+kzHCFKb8VNTfDQeiEiD9/OwpRoxOTR/JglbHcfEhM2dtWCDJdh88xLRz4WFakghFD/dMpoGr12hGdssXWg/WfaDBh+XuZiw8EYcDI03EJQmMG2PWnEmpNuEWZup90WogvP244vekltr5DgC2rUNkUBWnph0SoDRfgf31TJxssQrctVQdlci2J2nM0J54ffLiUZsj4ms6tlCyTzANMNT5DjVOixfrh8jrKXXxD7Pchr/cM4lYx/V38Bdhyfo1RwHU8M0pOp4t4jgQOjexshrAa38uXnlUt+PHPIfo1CT4BVpK209Awr+A5zRiee7rt7IgK564BjWvHQohpCB86NlsdZT2yocwALyK0/Oou1BExsWIqAqiKuYtJ9cBnDZxpyGpd5GprPnyGXWaZqwjddXnDv+1NRjKVlLVLIk9hQag0GlEq/frPTwVM7PTJ76+MV8NtwG7iFi6WRKkNlbGeyOsC/epyvxgBAvmHgEReQ04YPUmY8AOKK0sI4BajecHbZnLw+VIejnREsYiBDo/wQM8AXQy4/kR8JwRfZ3QVSGbJOlt0O+uHJBGZUEJ8uYRCsy0lAKAJ3BS1c8w5XmI4S7TR+Geo7trjbRus+0qSu3ZlEYwdYxX8BqI8zdnAAoMgLqSU6Qkbt9O7f6Emz3nTWW4FBwbyvrAhJQkC1JAPCBJYuOIkwjQluWcH/7Q9SfYmHuL/cvaonn2jw9aSQo/uDUU5PhvTdy0U69QbVAP1jmUIaayvEHS7KkvhO3AnSjr/hCSa+hf36qae/yTx/BaXeps9v5O5GmgJ7CT8ueYenuOe3/+HdqKKAdp/CQIJnVpOUcJ4DYIUILwHQ6fCvpDCH+3MytG8S4w4eytTTPXMLSgvx7cUlo+Q2TM1ZIZAOGP3EjkHMhEEIbQdH5hBnTx/G4ypkSSTt+IrF6Ja9gsfcfs2lXhQC0HBNhj4zDYx0j11gE9WRdqiJTH4BGc2xu31wCrDOOozEWAChHrWLBdK6fMNElbxbAYitqJ6+0MuwoCGZ94FSoewnQUSuhyz5rruuDrw+SElXWTH9ASLDwvZbeAjYC6jd+9pYPv1Zr/GrPv344WvS90nqQzdp+xM9orMtoNUuNDrHubBS+LL+tmj/Zn+Brk7F7Ybl/bi8g16XVZfr2ZyD/OSqO8h0Kv3YFRXwPUCtuPDDxn0P57EevMic97eBfVKaNte9dM7hISwO6+29xIw8K4266zeWBAJuznBhsHXoTBWMd6/MgEY0lZT3M67HnzcZtFMeKjFP5h3JHLqTRXi7K9aRz7KeIFf4wAxbeOoWCQA9dSSyVMsA/c4Z/sLfJxsUdGFlJmnutkpbKzv/9e5hLWOLTW28yscd1Yj1Gsx4f4T58xzZ94B7RokIlXCbmVDJDs92dlSOh87hifJP5Qy7PCsVLJIhcIqXgGZSML3zDVgw9FRN/zE1CTvEpJIDFMvYUCZhGIOaW8ltOkvRopBgP3luHSIORebTcXPOptlPd42gtVjPg31ssdeAiM4iiVM9JEDCmdRdzqrwDXgArKYLESEovv9GgWJVWEj/U53CJoaSpxhzN0hAlNyAyxzhjOlXrVGWiAhA2qRz1ztIapQD8DSVqbrXRS3N4E7cEWDKCLm+J2MpYpXfmOaNEIgGjODiQSDyIIGA58FyImFs1jpB+7g6fZuTgJINdzGFzRwM8ZgpIRJqRo3BBUF1xIFSWDQsnbYw7cedFdULe4soqj10x6yYk2q6MTqfuhJXfFuRo5whrNKuTk2scDsY6z9c1jS3UbTfSTCMwr/vGXba12sqNfje1NiA/RA52aUw0AoIyGHjs+swg/Fq0Y98Xk4mleH8osjSU6YF/bhrGjxWEvVy2ucwOLzNys3f99HmHUw2vnlpuZjAz1rra9xYApxrXWir5IcYaV59uPCE3IyFRtJDaAEqZ4z+38XadDwWgz73uPKiYaaY01hgb+BZsKlN45bIsDLSlHktD8P1y3O0Z8fMf5PhVP/bcOflU4Z5Tm4BPPvmAK6HbodHc6ghtkmxUvvTUobUbL6NAvNUo6dsPPAEI9l0XoFx3SYicuEFGCAHYJJk8Crhv+uG5B8h78SgJBQkSdWtGVuVbF2UpmlgpPS73XOCVdoDQ+kYSLMvaki4BIxUjO1qaK92za757SuPJyJX0soTYHkddydLJdujLNNvDj4JVv8fhzLL9ABWsXwxoyoveC9xmLfUqt0f7kx1+2OpKslBPgAyP9u0iRtGXCAO95FJmW5SlBzl3k3UI3L4BQ5l8hnET6WC+joEisWL5EjVkAsABz6t9AIkjD26boFRGz2pOMBP3GHrMXJXvHVBxUy67pUB1KJojaSLAt6ecPVtRZ6RB7AVeP65wcGscf38hZM0HnbS7//6RKxn7kgs2nq/03OBoXWkouUmqSN1YjcEfvAV1rZW2hzUoDOAmzjxJxd2jfZ3lXwcBsLh4mcxgfL1VSVuFITScq/GNk8N2JGj0fwEAfayusiuVGwJ+4K5jIVaTma/9laQwpF5ij9JpzA2PdXAS8kX67Ce4kUV85NnaIEyneTkaJhofraN19u735BLuCPVSpfWVnQ96XABqcORvSBkK6lvxD0JYrrY+Q+4BiSgInQm7xxCUiVaJXktPA9DoYz8V5eej7gsuLldYJOMFuMnEmirrXA2MiyFO2peMNRy9ODqYbh1ExihUe1wwFsRlEqcTDTzPhEZPs+BoPhe1rABGPnPzBXM44rI7rfQUE3/HH2pe9GmhgBl74/jCHbkkCw2h7Z7SxPTbdxJu1SbCtuWlXKWRhkczXwWzvttXYhbrpr6UHXZfSZejsMmiggjlm98RT4Sdy2sbxqpMzRxmGoz/jP42mAvux4PHZVODKxfYUUaTHu2HXb/gc8yVIO5H90n5ROhV25z9t5ajCGjfcvY6AtoKFrRwjbLEI1dvHv95eYBQe0O+jnrHDqA+aQqukez8zgRYSkV8mSEOxeZqO9+UgBitbzWu6OHOd99ubDbSF64ZEd3cMHsRALZedzpzwlVu346rCxZNMkr2MAOo6aXfki/NhjnkKCDc2XT3+dmd3UDrqZOWjCkSTgx8B3kWG19L1Obbjt33xi+M77J/fhm0mSnN/VckGDWOfPj/f7Wunc+8cv0oRQsVGre9/DToz3yp6EM1mG7hG++MoHD19VXdwlLt1d7OZ4Irj1O7dNEXB3A9BgB929Z4bLNr9XFiBGY9+vJNIGokevo16MT1kZU0mbGUJETNsevuc5iktaaBu5NggDOXbaKpm3YAcyupZq4dVoEBGIcSVFMxFT14NTENs/uSFDcfe+BTOWudYiWXOvxq6W8VUfSZBug7vRcTcMlekWP72tyU6bgUMuUJDqze+TW7k/GyeF7brQ4UPDJAZOl2DlDprDfTzLLHT6ioM8oLek5cccazKsVnwDRSNGPI8zRNyRUCfU00RIhCNE3BBtPF8YbokKJlG0Bj7dC7oT5b/J2/2yduFdbQPSnWajoLBUDQvCGa5WWMIOYsJn6HwTeD7vq+5PO+Nftp/N1s0az1RJTBAr1PPuM+qjFUj7rtdfaeijK2vzzhueeFOxiawLC2MELJzOlEYJAYNA8oDt57SYloudn3SWdcd+n6Lb9zxAp3TBuQ9K/d0Q8JP3Y/CqUBkKu3zXCtixp9YWvvTZHq//fMjqRUvM5cFXc433XqUJIMc4Q6FbsuTlg2d0qeXpPoESsKB1hbC/4RWoYg+mTy+Yc2jeZJ8PMJDlWy2eBhwlhxCHsX3Z8dtIbPw7nqb23MvTSwZ5hWbIUJTn1B3sdOyL48Es7MbnwVbqC8W0nVZilomrPTedHWCfyQjopq3IydqSOVtwOy01wDCkPyrTU2JzeXQXS3qw8Vmq+qW+UIKG/yvbN2F6PTZUqPHxhLY5ASrbwVNMeqOxi8eO5e9gSD4c02/UYh7AgDpUHmMfCYSxuGeOEEHlBWtF6OtoErdjCVl9v5JUXzZ9vR5L9gYiZO2LsxmXQMbYBQAED4EMUtf0Uut4wG6hGsOZVghl5noapyHD4WERi1PklTEjoVIApG5nrivn9kHpRRhcfeXeVLzFCfNBuc+cNivkWrsuihQbF8oJGvaeaMW3CLPqIRny9GpnHRmYB11qE5z9NzBzgfanqSV/RIUicLZSsKo7fmPIHgBxNtE6bPQ9FdpODQZczm4Uudl3BFZQYLjBvWi81jkw9Ow8+v7TDXjDtVT+ocR8H3RcbKee4P7FMW2uHmfuiZrqcDnCFyg3/QaWvWzebVhNTvOxzxXUXIw3HVi1OxOQLwLLvpPEtZfPy5MyCeqamNKitet/mgdY+b3qMErN8zz3O3TOsifdJSYvZzpYOi2NzPToxvY85oSHKPdlt9kiUrnMC08R/hPigLrgboviXTH/N0H87WWBtFOgV6h8aOrvK3SRaCoACClc5+KkB8OR7fph00uA9uOTwxXJl2oJlP1Y2BltTdzmluqWJ/ypyXzQQ2LKqbHH4DAAC8+7xmArA2aH4nBno3ICATYIPbzzz1Y+Ik64wztwJrIy9KrfThji8jxEjGo9ycI/ZW8SHUr2ClLyEhOh2E4BNsvIkc1IJlhBoHyog+2ShKZYdszwZgwgPCw9cuF+zbD67eBrGmOHF8mJYcUwBuJobuEAZYbxmyuHi+YulLP+a/aVztpDuif32jbVX5L79N/Q5j7u6cIZZtIAKnAYGXtXcJk89hcUKEVll0JFSHDF7THfoi2LQ7AvBRwPSpmQRQlJsBcIj7IgsLkr8uynis87lRmvGPE7ERBUConMiOKYp+s/eXFY4GC4CZs8M0ycRsI5NAc6voqigGxd6A7Azx4YX5YAFI60o0I6h9c/CL77A1bOWT8rFdSqf11tNVaSO1bdlbM5hKQx0fRmw83HHG8qzkoLTZK4h/FypGnzYUJ7rLMpnijR7qaanKDckTaDkznVYF+Maysd6EOYMrV9dr125Ik2N33Gw7zx9QPFt3lGsUEeUzVUcgujHqHv89qbt0emFsiyeprdXeQZsLHrEZuOlJJJL62wQ5EfgBvhvDKhZEmZJgNqLVMsR64MqUsg5cmWSlCkhSyRJdS5XhzVTCchiNAOG1y9K2G5rT1m30gLdsYa08w340DPgo/Cp4to5yFQ23tru7OuAHkFiDAklOL8By2umCl1domljAsCEwvYCYQZtVJvQoXmsDwHz3aDFtxGe7K2OeW9+w9doNpkojBeaTF7K5ej+o8VXlkAkwFhWrXwS7VtKRNH8kzOW+hd9MOKKEEaPK5u9+TMCOSMEP2U6PJKYvy2nXKYFqew2ZNHCPv3yPZ0VLCf1cgLjy0MNtX4cJ8aO5Kz2VFfvMVNNugwlJE8zcgl4BsKf44WRaOt94qS+CwBpRFM3Rz23O8h/iQreYqDXDhk8yYm4vLyvYcZTm/sosYMpZNDwdlgNGGzPg8TGL6ekXdqmYiWjd9JV7i0OeELGQssarjLJylhq/5/WWqfet+pEU2u7lilVimje3FnWVpGctZ2toOu8IgzXL11w6InEszrJhk7h4Yl5IqJNf+yfLGE6wLaQA6dZoM4rBBPMK2ABniyBBKLrExqrSAzZQ+obDOAIgIBIAgEnGfFsEGOvMVCSaroQCILjp0b4cAYQMhw8CsNt21ihOLfo4fYpYnw4VUvF4GECmi+aH44ut4ym0II0zjN7I9R7FIV+bqacgQMZT/mYNMwMclZFR2fSHFFkpnoKBjilmTSiZiyFyHEQ19piLYpSKnshsgmlnR9NBkNrRVbwk1ICq7FPEAvC865ifqGUR8dAozg5kWWxIpGskJzyVKGme0HheQ1vefTEoM1+c7nDqZR3t2sCAgKW3LTqUMAcIwqJQC7Z8+6mUiQoiAF02rex0y2qRqQMhXjuqDhtpRFBra2CgtWFSNPrH1p8slKLiqUnVRkEw6gtzvjmztxnIDUNgPISDcNfj1OAV/8nQf9xmQjsbrjov352MYnXuAak40Pp37ewbONihVdJdf5nm+jx4vQmruIHLQkknmAbtJMyGSf3++NbCaje1SRza85mImyt1/fd8BwYKUI9TAc9dNnl4my/TZRKgdb9/HwJfnD7se/H/xwBzQwYVr5tOjzTLiqBOlqMEZfncD+2pK/ZArMrkXPZBf1mIzDZFhiTBboFITRJ7soya5M7WcOvpKrKOy+MbcL1qwx/VH/h4P3A0Sx3hcBiqW2SiMdEzg63dbqVJdil3SFmlVNXLRFwqG7EDUJGzomlnZ8eTfBmQHFgZa1BRBSxoV+x9skCWPW0i7G9Bs0UysOSp/FTBpaecFTycCotAQrxIpmFJImDzvUyS6JJsF1pPV3nlYZvHBNoRV8laycEV9DTdcwQXsSZylp2Tcu0PgLJGhq9ltgDsx0EEXw/ALANvHGwDQiYSglFQp0dxUrx8VY9jZHPRqnR7LC+btJgWx8hiZdAjrzCiWubGzYNCjPWDJhmsOILKNcdR7VnpEF6xZslZ4ZZqar73AcPNUpIejyZp7XfJG6jZFwLgqNjeiiFTtdRq/Yks6ph41yDZumsxAGuOTZ58CkXNCJ5DdhJLmvJ2kOy/sOiEIXdpOu3TGIrsAfcX2GYKNPsctvZbn9f5d2yR7vNKg/DCl3hwqLt/dNB1dGevINM723GSteZ+lcBS7g9czY3HNFF0EL6T5NpACnGJ8LibDCLRJwuX92Lr1HEvARL4BVmGZjVN/0g6GxXk33tEVvEKEK7MTTjf/+7NQkt/C+XWKbnfAGaN5koEPmVmtuT4WIKV3KAnaLYETZajHC+vd8gNhtdyyWp1D/8E+sCr6B+KXS5cE/Ng80uBvntP0jabaTJ/abCDah2OsC6KP7wdQ6tKCyfCewk0HWjMPaHT2GwCsPjQgy3z7z9wSM3JST1Ufx4gQlVGezG+Cw3k+m/2M8erqlDChqPtoyjjIgwAkDkI2zc0kpcyBKkEaFcSKTtiZqXD5PTms5sjAxfBwE9L5zMwpKybvJxI7tG6W0VddHIjANpPHcWPHItDewDogMmJV3oxnP/VPgooN5Yno2iyRPvWXCmo/ClBY9AkRH731tKQ4T8CXulyBXTizO7AlEtFt8jMSy3I5uluw6j0U7TOL8uJOkll2WgmCtF3WBAMZok0h3fdAEVGuVMQNEjnts9CWb38PQ5xo8FGNsvXL516svSkSt+x/Ddq82XvvaVWZag0PtowwLnCJJZ5e5Lqx+YNPzf3qatPuWoT2nBTQy9edH/s5c11d4zwUZzxEvDrQd69eWxSTVhoTOfyaKq5oQs8WnTs6atNWZp2DE/z4IZYmFyp3x2Po9RlDLZXPYGtyi3BfaKrWVKVPYIVwUiaiFercjVoiWD6yxWPN/kkVRMGADqZ4HraaNYKEj5OG//8JB8UU0zrUfHPHchFb0X6wId0hV+BnxVhdnHyAV6Uzwrt/H0bTpVvWRHOe0rnvDrWG3xdvRrFmcAMqRO76Cq4CcYiTXnO9HBhZIG88ts1N8LnSArQANwZfYI4nICmYhjDyBZTiRO75Iv8zbSvYgp4V6LWf7/2SrWutFZJKf5bG4migBXw/xiOhIMvhIFixmh4YLqUZVFiecqoa2dCQLLC4aQVlMDVBDx2nrhogVGQVfT7DROLyEdC3KGEE4JQQbJ5Yms0Xo3ocFx9KWeg7MrUV9fh6ROXbtwr1penrDc2BjvByIv+s9POm9j5AI2YGW6CJj9fF6Ds3pd9OybK4C0dnmAcF/k+fBryfyJOhf1iSOzsflhOhapNyrZHv+oJbfKsfpxIm2siMosYsma8Fvi5bnP5YzVl0Cb9erP/v4d5wl2dD91wbdhDfj21Sd0DLIw6n1bgL7wIC3SKU2i8n7ampf+rfr+aGuyibbX5+CP6CjB6y9Srnm84uTEzqhGr+2gjJVPNzzW2ywmUgfL60twvqLTJEswr1WMPclztPBEUN7nICXKAjRKsqzqJjBtou8zdWHUz4nF1gV35vgRTNnN61kHEPmVaSfhuP0M8GRinySZnMPgToyEEtG3Ja0FRDgrSp3u0SiAwewWMmth8vkI5WrZBa4WsUTN/2iJoAELVsZtWZuJiWAS5GQrhYCKP5kQRg8tj+8+muN0djuXL07LZNvVbJfdyMilWd3otZzvWSXDJ71bGPIq58bc1ZSpRPbL3lq+2lMCCTERnH4dMnbR6oYcuxDhw5l+jKFmos0b04gwRf8fI8NSIwMvj8ao1RDDPIfVn5sqpKC/s+iKnrkO2eW/i/yYmbeISzAgXp1S1fOYlWcQ/RmbL5VMAGu3JiSXoYu7+vbmnzwkgUTxeljDKr4lEmdS5NcaTUEEpIrVaA1WlqHzfhplRZua7fb3wZPKeeKX94ZUgj11ZYCYn+COI3q4QQL0I5cPO3nWVXn3yblP5Fm+WPN5vrnPM+tntEG0OIwTOE+2ZuK4hnf04F+Rs4fFQ4HsmWgOqHL9mULFvBwiGs4d7DnetnrM6fa9hdLPnBhQ1CjBMRQWIkaayheOHi1qz0tm3DYcNjuCQRfeDTj9d3LOl7Mv50tOdPtsXnAe1JZVUciCup2ahV1EYv/iuk+OmewtcjPHZIhWENhdTaBYxp/iB1tHHUOD+a8POluLM4ChH9wVbqnalhC7LAqTamXny3ge5qDxBTjnd8CXYvuoYulQoXwuMaiMJnfEpo6UMg89gHs7q4LyyoBi88dCtYSaajCdkSLBgFPVDC3JNtFz1O4ywmSCAUVBZWdFFMYjh2pYyULTQS37/0XIYxUtQEiD9+maSaGa0HojMI3o8YIOgonDbCdCm5fP7+6NTOcYBZ1fiFeEtMvRBRSyDfubJFORDd1jSgQO+kRlb+ibhcNT/urR0R0OD2babSg5MRODb+mUuw/1HoezaRJkxkpsFwNv02Zd7vPcreRSeB0P4teXqxJ8v6OCwRcThWRNhFyJkSLA8ft3DtXZPLJlU+nNZDsakBG1NkqbGO30t3LvTBvITASiLM09ic77wBAbMiso0JgvWd5xDiYfLuCgJo5KNvQGTDiEA8a1PcLIBfUSDl/1CT54tFWjETJwJl/U8vmh4X9OcqCjr93kTHZxp+qrGa8Mhe4KLs1IGZM6OER3Zv2+6ah4UUM8ADdWqam55folqQtPiXeaMYCdPh002c0Mn+Svdwk4vo54dtyrwO9NsNWfAU0WJ3INFisZmPt5vu+C5LGn4+R7lIhrXAkSJmakB3Od7EsRtG3O8YmTgb+Wf+GR8iKN2co+LBGyiPh9yrYYI3pAry0rlwOnfmEwr2u/hVL0h1bTCPD7C5HVw+2bq1HbZdHxkqomlf0T7d6afZfCVYMMBgUf9jQZJfL+vjX20t5byYmi0nj6foeBNWFGe58+/JT+OF4YwXMtf9P9alvVQGbnSLfLOuNXpxiY5nvrfZldv/GUoZucl4P0Uvegv3RigCCegOswvkUzZR8hBnVk6i3jz6EMH7pFQac6K9X3TMtwMT6yh9anR10vMKdcso9Fp8mp/3xKgwuA7+TT2HLofgluwBwNuUoDzI0ySU7JREQcjtBTHEQ6hpzuGSdOjDkQdlIywgfIpSvWXLtKIphAJaswviYJNVhNyUVMu188oIGmSu4r9Uou+SzUlX+XtTTrP3XmICgy7U02jDGr4cgybP4RecXjdGys3yMIUJMx2alEs7iB6+mb3t2m8U3sPikc5pFNTjZXmESbBKIJ5bhAMooBVWeNvaXvbPHQ7Px58fbSHrw7E642yWX5zkOtP6QavdTTaf6/pSx+dKPtWWnYN/dyyc88rCYm2+d73EDTY/pO18eU3CbWqWq9zyXVfT7w1PP3UVj743avzAKgwn/1J6LhysinRWL167XJFZf+WqUW3nSIS/nh9jSzTueZrUvB9AMUAvuHDsPxa9OdPOePTNC1TERCZe0QDVqFn/pBxc4GM3J0pUcjUkjYUfdUeYeaGQgB/ncb41n6P9sS747NgVv0keSCF5o8HCoz0xul3rrpCAvwwNAb0P23CcEpCMc9tjkyIopsfP3XjTMKT3hnYh34yosZtbv+uAKEPPr/l0U1RfxcsxRYDxUfOeTsXuYWs24JvM14bGgwkQCI0wA2FAjj55ff5YpZ0dIcIUmw/FnTFIP7nYCkEDEOWDyDI9nRroAX4nDfuqbfKTeSQ052TLW0d2fs7WplpEIEHAH14/Ck5rmscQEQAAXN7A7eLFRVGNK2ezZYCaMq3FivSXzTE9npN0k9oYU4t7ZKNyipkp+zQMnMOwMcDDIZAYumq1SE+J47JECabEyKiMI+ArVBXk5c9rAViarwoTJa1sSZtAUowRRWmLTzXCk7g9MkF9et0O2fPYb6ptlhUFFz31e36WBvN9qdNKY0wTCguzpVLPu68xQyNlrYoOwev9NYsbTIBfoZelLUfz0SRQDi04lEMF4fZHI2SDF1HP9j+YSUyDFVz/BOFTzzN48cYl7iKkKtNU5xMFKUzYNMTQ9KbrA+imer+oCy7Uwhj/psNjmSjqlGwU56VwAyPkCywUw4OqdJFO5mKMt9iVK6plMiOBDV+yYuNKi6d5VXbJJlJ+xEtWT9QkQc2Cwz3vbfkZYut8XyNaJZwdVOCYxQcFcsKCHHmH3yx3kd8KD2sUbLg8Z4Dbntmvl1EY20gUJq1c9tmU1Hc/Njc9lI0R+1Bcdh9USuR1i6KqNTIR269tyEEA/To5LrWDWA2Dh2RoG6lbUbmeTgMAzEoiQTOSA70EwjTcYZg0Z7s9YWPvAYItQBUHtyDE+EINDBz/30guP5dVZ6PkiknPM0iMiLbf8meZMS+vAqjSzMqLZYB/dlvL05NFAnbtGXK9szMy7XJdoEPbMtjEpsQ9O/UUI+WoTcNAMw2WH9gSPG60kYbdDaI2+KxOdNBNW25g7z48UNIx8VwAJcqIXBF9mTDATEAFudQPy4U+IyUwd7zASygRaXaLutA3ttU/cn6FZA3wWxveWqbq1lnsSG2UIEDByRlsyTgUlFz5uYz/1dvluQiYIe3k1aa4S0RqvfMifoPABo1Mp4+XJpWKmSgUfwr0WRwgFHcbIVgGDBvXCTcb87TiDVZSfdGjNsTQpMcRHhbZR6TceH47vKdk7zmUqlkPYiI0Z+bbeV/GAkkvrt+Bfdf5Pkilb68UHpskCG8sBaHc/4MDjJGHT9n5yTh0WGOeSYKO3i4/sCFmlwKWMUPswrb41b5adP85YdkL3WVU5a/bNgljX4rB+p3eeoJzRcNh4KLERtO96O+5byokz+uhgYYrMVrfz8/dJjDkbzTc5D8Q/g0MELh6JdVyDkSX/7pZfJJAJv1cnnOSE8PyZB6Zht9mqt6jvk5OdnTx45ooPyQM1Vf3FkNUBxKub6BFf/91M8Np1AUJ4mlXUOMotFgic7mIxBlSSquoxlp6IohUIUMKDIN26gWpgRJzp/P9Dl8+qJVbC1X0TRQ8d5mc7PVdZpHbP5ktmKTmdJEc+3jAcGB/Du9m9MPTzwlcslHK+/WuZga2eBZPo8DOOtnvcWfoKDYV3VaOWVrs0EOOE6ReCh8EOMox7Cgze2ZZErPLt2wJYUVPPLjXilCZJudqXAvTyVRbP2kT0n4ASUzYsgV+n6d7qocbDHACFm9tFI+tIBIkA2YvaQ4VGT0bhGkpXbuOLB2TJQKRSatBEsjhxc/5buzq9ihNeYhvKB2QQQZ/jl1NLfl61NDZsUgkzZ1ApOiSx3SodE4uJHUSCAq8PswBAK8UcXOolBy5ceiXZ9YrYV9IAj5mCpxvf5EPgPROEyMzQX7j3SedoxMSSCIPucsz5qZGjlwvnxxe2FCDJ4GjDfv2lv9ZBcxmYh/ZP0HdQ1AESnetbs+1QAA695jOzwgzKSoyMeJWZiLzu2sxJBp3Snebhf99zjE2LLmrvw7Oa45Hp4nVjUqlIVcHOH6CY1zTCAPdLMWnNhvSxbPibCbgaIbBWXbLW0phnc2OFRZTSAGcGImjKaQWZpvJ1DCZKvAKgRzd+JOofyU/jNW7gz99GUFDv+hRu5aWVV9qo5ALysRxEFqu/9NcQQQNDT6jYzvRgGEwstegB6S4r433tlS/PL1fiTRcSTWet7evk6SR37iSnFqWWrYI5jo93EcdXs643U1sB9fwTuR7nkThw634YiPfOpo/R+OrnQXhbculZrW5blcZaXKU2KXmX2Oq8rJEnYqGMUA9/f3bR+ofT0msXKKnF0aq35J6+XsSsUfOxOyPUFPmOx64L3eDxKBSvI1OmpRNInfuH3M1H/Z4zmmHS++5ha4JXTrjl7ikqdJZtR6VwcG7ubMDqysYFzP409M24pm1SxBE64hH39MOhARd8VVceG3Jm2jR6kDPwnv6DA4GN53XNaEMA2yfk4LWSoQfmocHGE4HJxa1rM8o3t5We6xv4agxnKpmGxYNZGeuW49N3DOmP/vuSevxxW4IShNyrvQjaHObpKpBd4JgV7rOdmOuTmXj+dH8CIWo9GBM4lteDDTSvgahTFUcD2zc7HKAQbdgunTjKVtQPREXyha5knLqggSb/gtWubddNHuztoAvE5oiQAlXpAF0D9/+ojZZ4Rar9gzak4xACJEPcTEzW2fXM+wcLawlEMEAyP85eH9bwscmXeIGPJWlX2GgPbiWxdEew65u5pbI1wErUCNBuc/4OccmGYdZTplbRcOoNdF89l1U092gXU4gzaIbXhkoyuhWFQiTmt8rbe0jM68+eNEw0UEOV4ejd9rc8BWptNaD+t7j4KF/GklsIjnEN75Qu1aCgANwGMR9TkWREQD6ddwaMfzp6EaDn4UHKOriRu/zz9EEJhE2AcFHpD3FL2JRcpQV7F/VCRuB4pHk9HUDh/H2Q4lSGXqDnM16h4pOS1Cdc84bn/DkPoMUlf/Z/B/F45B3QdSdo/tuprBriHimi/I4gPwnDQpt0THEYoQvI3JreVbQp6WyqtLGusEEKZgjO3HmBAKEhZLQK9E/vKuu4HiMuv4IMhY8rHjViO/b17wXARnJAbc2NVjlY4mHrVi14LRem1VsrdtqZ0cRIsI1ZzA/8ng+sOjAohc6oc2BeUhK19uWt0wQJVTDSmVED2JwQoSCOKHGpJt0neOqBrTg1BpnxF5hVste/Z+1RM4cDFOVIDhHG4P1Swn5FCcdyekugjQngcdlXx934+dPoEUZPTrwWw/BI+eY3upfCzmh9wGW7k8JkaX7KQTAm68OWpDm3qRtIlh3tnR3tMVnZEfhFt28OyvIRJ5WN6s3LoakYRfxxDRnBWotV/r3ltgBAzbPGE4+Kfibpb9yvxjiuYELjXUWBg2uYipX2FaRubJAjrh2gx5qk1wT46hxRhbKsTjKW73z643pG7Io7VP4/vZq8Fj+ErRmyObWOaUhV0bMKe2cZWICtBIK+bOrnqBw6pZGX5Swug6XYzZe8OAGUBEG+gabOHGICZkUyI/ohvmnz2hSMMUYfPmrvtjMTt4dHDefqCHM6ZsnRxvjJibV8wdvohXeATFkAK4YZZ+vwcu+qfKiBULppfRpqLUEZrmD/noBY9bN1oxQxBeWXoA88C5Owgia8yt5NaLo2aBGnDNtIOzic/NTXIHSnTW0bb2RobUFhHK+O9q1Plb7SXyQ7LuKlSMQ7OHxDEotgtSgWgJR29gNrymHUQjN/iNAgYBAKtrcZE9yqWng9ksoUOUHLERgjOOqDtBiRJXnG1ctqLTZPlS0U0HfDAqwKNoJFk8Vip8nO81J5qA2m1XB0xHC+WdZHKpQ8VevIQEkClTiklaF7XeN9zvaDI2tJ8ITVo+1/UUTymIc4qLqBhEYbjqxKmPIPzDmJ9mK/ehyZl1D/yLVqj4KOfNvRYE+ajVbIlf5P+Ch5fFHH0DTSEZwbY78E+jrusK5gTQqs93l1EfhUI7n7EWZca677KFgpfayCA9BMFa2KbBAPj/1n+93reMmbIuipTBlwCHT+9KoxZJXUtZakMViLXMWpkcRSLn5bcyRte8mqzdpPe4aYos62A6JZZFc4zJOTIP/j6x96PQAl5ebExm/FbCH8+9KKTTI5LWPEvU8pQ5Ofr6jBXC5EAEKFB45R4wk2mWacx7stJ+vpufVJjKHzCMKKMJsv2zVCZd6iKXo+17fZxSirRV3VM3P0i4/0QiaiY080v7Hoe3tEb0mKNRhBfMU7oiK334BLCOMziS7yh9y9O4qBrfnBgbe36letuM6YIqX0k1CnCyrDzf8u/RfXMIIArFaGq/dxjIrjCRv3q1wydgdNNbiTALRXEAXfgCBOC24zfESEay8251ee6wHbpE3oqRUS1YLib4SIpFChQCfGviAV8RRX2+mhu68ZD/1HvyKruC5wc2FZUR86hpj+jVkwPWfsn1Ewo2KAWdT79Y+838IKDuFWeoqlSDA8MsRTMucscek7ZEWyyCTsTgX1QNugs8e304b17e6GDBdyX4Rj1GPwWHSOXfSPGLp547HgliCUqNXiHaNBgMtwxLtRHmZO4iQNh2he5YZudRGJn6OTb/muOOtB7sB+F7A4Y28eDdJ0A8rodNWRBtbLHXYNQ9p1Y0EvmxrNmdPS5vz/BvwwWRUEWkJODjdR5lgBxj63RvpSQ6Zk74L+b+5Xyb7KhWjWRW/VIv4h/jLxaBt7axneMJtsfeKw2t0Gmgz6DQVDXZQrNRKEJxGUjEcVf0GSpD29a9+b5euexoEc1288kS9hR72oyno5EfIzMaHA34zDxzsSD/j6z08wbiLZu5J5c+KHJ6hGQrn3gyBJWavvT2qiuuzC6wesowhuI8UWNTK1uN/7wpyiWd/ENeK9b+oAHBQJTR1g4wm2yweL/pM62rGaZorZu2rtZveSmK/RHEjeWtdXK3n5sx0mN/v7Js3im5Q0nabsTGQIStmIj/OOdDqkJUqiT5GXjZB8SgkwjqkZzp4PGokb89VPXGP7KMjaFzitq+Rs3d/CjeaQ0zJhOv1iiP6Y/5F+8YQOqdTs8rYlJolroRwfGfLNzlzC/Lh2bWM2gdeppCxFMo10xEHViwDsVkTBYe9bQPgyXGSskEdoxDnL6wRUGsnzAUFRY8zBuZse1nGg1x4+c9yQAnyFbQu0XXTOECYpke6+Kq1O72P1DD/Uwi2vB2j+0Ko8DV3iJXL9sffJI9IVSINgN4ciouuIqwPWypDKeX5S6bFHBI/xCqb5/n5Wtr7hPhPbnitReYYY0GADQIzVjrmRBcoX2KoKJZ/YvpHLw7L0T+ZqxuOuXJTAb2/RlMYGb08xkcCNgfefP97cPkE7W729DhqoCIkOTgSlRaOZEvlbCCEq6hiG08dTIqbrlT2Wy0FWs8uz/Ytxonu3DICtGh8C+DoLZt1+Z2EjINKmFBUQKPwigBKkyUl824e1/APHQhcxqsF+w862E1bcZCSdMKpziK1saAfXi9qfJrx7nxPppkLL4zTarMWMYocVb07LLLz4tBwjXcDvmkRCe2I4H+MvfR+qqoolHjZJvSnfGSusV8ZrVKuIBBs4UQfuac3qboLia8+NIFsap1aSTC2M+NPqA+brY/Jvt9AHIxgbgyrJmzwx3kcsauMg1CA2AUQmj2WIKyfRoEKjw/mCoPw+4wyc6KOS3AM4kutzMqBf6VROoWqiElB6KnMFhBAuGit/smhTJhTrIVRTorkm0mgGBo4k86BEFWCFhq/T2EQ5p5J6+lETVtWkvXKHUem022N7LP4scNL+fhFrvJjpD1XyRULQCEvc7S+2tYSi/7JK+Dv/Ak2510X46NeL3LPOUExw0x/RMVz66ayq069pw2GzxVXNEwBDqs0EWSHFcznnGohdo6VFctRXC0ok8igyKvahMlmDET8RGcO15+PC/KnOuFylpLrMYpgq5vVANkqdckIwdiKj+jwu3BOXAcGf42FL4aGDmDKDFSHGd7sj9QWLYyzjlWDv5UmOZNQ0P/2gQvdbH2mf2Um2rC8wofO8n8FAVaSvCfgPvr9EZbHK6V5s8K3MLK7a82Vpqq5s1zRtg/cDzWUf/E4gw58eFwRJFLgeYiXrQ58fHLth8AnS0Up7ZkdBFQyFh11Z7rfzx8WoO11cOqKXHBHdsf7sHuNDXOigbfHuAFDj66sfzXaZf3zNH+nrer4qzfk+JdtUZTHtPNjvNL+dlKBV0JGU7CkVD8Y8jZH3lj95c16cH7mUP3xvqU61MVZ+g8hkZyYOqGqByjgQlPzm97Hwjp0VRU2TPXtKUEQydTDcFcekaYTIqf6BcQrdLnVU3KITd7/IqK5pYtzal0f3ib9ww9X/p7ApLWnYdSd3pfcb90cfftsHeDzZq32qmD4JhbyRTKmZUnjCmRI+rB2dAGL+WEIq46t/xKKiQ0+vloBxHqEUXiRjrembPmPKKtV7kClCmzJJgwOy8fMAhO3zFFloiSMfNNaalMPp0OQdMnzFkPXd4BjrgPLomNnJABrAUGs9mpwG9Fv5Z519IOXvbgFLNdIhpXDx26Jxo2bOgW8qZN8zYFNPpOGvNx/cumt9I1zDJODNWlaApqLErlP2nXcaPTsVepGqignY47MSX8NUBxQeWqfCAJkhEWBUPGIsVD9LpZ8I9FYKMtr0lHP8TR7rt3+K77Fvygp1l4WA33inB43fPkLHd1VlNW43uO9ectTTEHbHdowBl2UcbB/COJxoSFjUbzpoXHXZc3YiLOdBIpvgbCGdvpCFfeHOgMP8mUk6K0ZjKNnc0r9gSv9H+G5L+NT/xmEt0rP1RYp4F5jCLJwUXb6We223xpKJLJFgOWNWpsgxCAFaxEmPGKRwR+jIhfzibSORgNGNCoQpI+Ypb6u6DaNgt/7+eUtqcmPnk+Plo3X8Lom/ev9BihJEprZgPJEZtXbLNNm1DKGvUTeeFP99jxCswVxEDEd0tx2ONHOe7moWOLMc98If5JRfH3c05Irme2IMcARaX3HtxHad5UPNdjUnnJh8mxG+2BaD4+6OATRuoGvqvtx+zQ6vwjTEnM/Cwe6HzFfzlo6tNvu4683n8HXzm8svjNh1GOwg1WkzTF1sUVZ25e12Scn/bajCJywLXvxiaOh9TXWYYnEURK7BlMuzSOwMvPLYPoy88FNRsrLBPTFEnyR8QvHozcLCNQTPE3e+8dvOJdI25coqp3rv10gCi2Fe8qGbwXTSVzNq26s+WD1NzqYs6seyvN0L5PJFCO/7zp+zEQVaynRfskOODOlynWqlVmlIyOMci1v09+CEqNiUV28QQKV3f2DHZojWmAhV+R94LLXrcEjB+vQEZPJfSxmYNn7ntQjeEMDzTbEn8QIC6yAEU33zcSIKBoS143jBIwEDHdY1c4kF0OgS4J0uPyfj8he0sOcamTsZv7U5eSZ0onynqenvBS2m4EN5LSJm1iKPxIGMpb+GtnUSy5EoSXFK05O8/P3YSBGupni1nGqEkgPTXjO3uM7nr4YEC1ZRCF9aYnnOcnJ7ArmP7pun7CEESDWk8Xft34lLychYF9LNaMM1AC1UVSrEWap5I4iSJcJcaJK5oVIbgPWy3O85sGu+NRKNO4Fs3cXgajrKfHmuu60/dsI6EsRlblkEQZjyNaea1rKyTKmFyOKQrwCHEC3Wmi2aTeTv5PWZJYeOpKJqZLhLaa1LPE/60DVljUbcB7XSI7hM+aq6lIjVMUH9vgN4+oTQveuik8J3yV1pxpn8sXLLtWvyhO4UQ8asX2lQRffYLkWVvMlNvMJDRKNxb66m1zE28sLVpyrrKUSopACQUzHVEW5DPFsr7ax7SSXe8vN1aetEkRltOHywJ8WKzF+8+2k5yt0mRoZ6ojGk9HswicxLIMZx6Sx5zmlzsVQdkIKJ3u0aqBwJzlMIosG27ZWdpRQMK/HipbfkwTkY9hHAitKUk1saNjblPwMIbgtCwnA6lg5od6PD09LuLL1z2w9UBaA2M721SU0XVzddAV/g7SsUIDrKWE5LX9ozg1/GLablBXqmcbl4eU+Qt4CJcGu1f4ettOU28PE0Bl+8T0D05CaSwTirI+LfzESN2XrhKXJBJrnL1YX6pPfJAD2XkavCbiMhK8To5EOcBZiIEAO0JLwIRVT0Mu7mvI1JFdZoVLpYSedbrZ1OHZAmiABMiVuipb2bX9fovNdKqf/onc7T26Y9FB9Mr+N0eGPcwpi8f6MWvXp9eZpAAETXZrXed8s443eOBtOKqlB0B0CGbSIbe9C/5p1rr5QVAUzZN9QT1kZn/mN+W1g5iA9c5o1hedItIv1B/11FktZ1kdlD7wd6YGoltF/WftJ7TfwZHpC3OXHAP/JhhcO3Ahm88yAzQJTKdBNCgCsCHcjNEC/7Ci5eI9VpDbh3PEvRxjsuaL7/pU6I8zpiFul6MJazl8AplHg8oyzmooRGMVzgTwCHiHif23zVU4P8V23XRix9/r3SI86yKHhDctJa2WJ5BJMQuW2lmTUDlXLtFK4PYuBChQtJm/YkEZJYosyzZN2rht+EbNJDIZ8zYxzREfw+P3lWVgGPVOAr0JRRNtdQ/Oc1GhIV0QFCCDhRvrQRKVz3fPkiSYpkj2LwJK2z0+TOXahU8AWFsVRhw06SU2nWbF01LGilTI31naffa6WhHi6ILF7HW3CHaImjGyLb9w/PCE8g7QSXG1RKyt8lD+jl4YaRL7AW31MqnuEw5kq1QG0dzvK2rvchzKYiqf213OK3JdE902Ps+Pu5fMAkUjB5K/L27SsrcJNenAbyGMsBue7D1OF7AEgPPUuvsECvxj/hyvMIFdTQbosjkNiQeswWfM+P0esiElkuOPeyHY6DB6cknVxTrd8ZiVTPT165sdtzrnXDRvr+ehAEKU7OcwVJWFKMeqWMypD3uvROsHrkZnOgcYuy45tjrzYA0MHrtpTv1bc5+q/m11JMQQaDGV5wQzmqoyYj4M9I9JKkr0W8WKpj0FKOzHLPiv/5mdviIifFcpDARM66/3j/x7mOfo41FE6mFd0qYXj0kqD3eU2Cyu3wCjTpUVtdbkWeYnbm9eFVMu/ILZUnE1YCPDjOiG8VS2iNxNheduDB8Q7Pgy5ZAEA862ob64tJaHH7qBYhID44BlvQcuRvDqh/cfme71ZvdNZJkfHCi2FoEYVGslATgEN4tf2rH4yBm8n9I69mqhVhRsqoGAMYsQpb49UxhKDwgs3WtUFqjVeW1ejQOqWboq440tH3+Zgv/FokAr7tO7t7okSCuI8M17P+cB86w7sM5C0LNpjU9b9N8Pi18SabFbpi1dNMs1E2Bjy7pDJsL03OKjPNBCpLr6++NSEPhKXbcoe2UqvpjxPaLzwdYwKz/ievCcs2N/stg2xVJPYdXvFn5X1ZUmM0VpqdQIMmYYfmn5pem7T1bOSvuYn/zmyfrwNBzOJMTYKUO5VA40iMg7vjlsgsM1sToAIB1aJA8GV52+W92lHMNF+uBKdOlC60A3xLVGm5cQG4/O48gS2LzibK4u+h/YaZ8aLIpKjbCihOVlPNVSqrfCnp4rUaCzeUu885l6pTN+FX6X+w0MyUYT4Ii4BW3qM8W6eai4CIW37nMFOP3IjnxO6BOHoWEwS8UZUzQmn6wRG+iayZkvTcpWJt7xi5ujApsDt+bLsg8IkIPTozf0aVVLE5hRHxKElkRHst81HfV4pElRYxIgEli1QG6l+HkXRjHgjUO4eKahku2/+opL8RPHa2bU/mOh5WPtn3bseorFOabSz/11CHBI+XsLp05FMVRICrRhZ/lYN78/zlUcahOfK8rO51d9CgmRFImACPU3WPUChIt4x0uYqIGRJBv2OBllu0hhcsnRTm+nWN9Wnrwv61+5gX3D+FciY+HFaP1vvetcvdjltmbfbHG52DcCy9S7M+FQPGdha7cXNzM325ZlgtiEmqf2u9rn2BmFSJw54FKkMkaGlnbC0LTF8DJXeNMK6LMmoBqsQUCVK8/mfsxdDnIUGqVStCRRsSqyrR6AmMd9lgPHbIsug6KZ0R6QroZg8GDEavXjzWqVOnsc4oOIp3MEEcXiMYgPAaTEylpQsc6p9SiOpuR1EiARjNux+0vD6+PA2tnpHKC6KGcx6s7DbJLThv0qkLZ7gzSV4YY32a+E9DseUrKgNfBOiCd1bYyGIG0k4tpdgQl9Z5Z2NxTXQUJbT5cDMZKO8ud79mRWZC5I9ThWG6Qhm0mven8EFmGuPnOya0Y5MurBAy8F7/sa5Nxudz+vIKnaHPFFMxrBDgCtVzvOPYjp5H71gJkHIa+uZanxAm6Ao9XOysUXPLLw4A2D4dBcX3merTUa3fEJFq3g2N5RsCoROBOZ8+a+SrPAjxF8NaMRXPCIo/sHnj91O/ptuX4uzN+YW8k7ADM0ETQZQNl/P7mp3HX9QSUik3u84w1MzMBIEgN57I2ST1c4XnS0U9splrbNCtmX9W/WX/uGcYwITxvX6slq131q/tu9yxT9PhkNmRl2QtgXz5nW3eplG2VhcBiRr3P4Xr59pZFRstCHA13qL6faJd2Q3jMEDp3Fc86ztYTLOx4x1KV9JjxxpWaVHxz8hD0SoB3nqXDdGBcpKgLoAEOy63V5YrqI2/Wp6JvjOUC1VM5iNDsjeDNiTDLt4x8ZLOrRYwLq07nK+7XjGLN2SzPC0UoYyYKtuwHMf+o/4zbeAsNRy/dXnONAPA37qB+PacyIgffShZ9Wa6hyTKsU2+rYs/OS/WbaC2TPSbnyPtvNaHTEWV/Su++UPrHC3V/chBrE9zwjOKDVeAtfrekKWJyPd3/J9g2wLTCyxxVGAV5r4+glMvN9gbSCI4UmpbM9IIAAJmpbcb8jGqi4kFWVLwPp8ssSQD8c74aGQVA4ZHP5YwZaAqMICUrfI28q8Cs9hmHXSKjuiQcnmGWXJMWYmyyDTXT68dIEaPmjEMCJK2ctVbhwFKWLQK87NjUGN8MulIaNvR/5voRGR5PFwKEOCteFsdWF19TD7b/UpErvOlU1cqK/XvLHu/7+K4UxWqEdwccmq3ZpTY3FjcLAWBWJu/zgHjVc5Fezu/FaJcq0sbYgsOuv9QohRquSjghHi6S0Ij30KD9VSAuumD8/FcCuNseVoO9UDiWg/uKZ+6f9ZWJutRTAgY7AbTIDzQw8U6JeDIGASj6MAgCURKjilMG3YUgBssXpeZC/sSkBn3vsAIsdEe/p6KkOALAE4OJRZR087so100CnqvQpB5zoc75tQlLTUMCApJNRQV6tGRN/kTfxdicUWBeARgbCvREN9Z0ioIi0RrmylVs/bhlX1Fkumt6Xu36WkHX8j1wriES1wA1G3OrFK35dNda6QxBMLV7HTTo3n+RK/kZOGPAYvwbIsvEz5yUC8MKJXIOGBIZTEWEUTiKpODrtahKC14H+bl6Mba0e3q5G4XHnicTWRkhBzyqhK1L3p7dCAAWwyC9Qm+CyXPc5sLno+uojQ+WRe825j69kQy18IuWPW5aNZ4DEnBgrFHqAeLc4GOp+fowlIzHWr2dCkfkNcyEcj+7PfKjHucFMWGaJr4vB+WTfXnhX0x+KOxd27GuxmT+JggfA/uw+4/DUuRBsaaMdjz4nrsRVSDUowERW9jAWCsQggg4UEtQmf2YZHryiX36hY1cD4CECIOc5XTqb+344fDYMbFt6n9BIN580VazBgPWy2cksygDbgKTyh1AcSkQW1NIBDoiG/wstQUsYTF+06oyhxlB52ROxRVBnRCLAE3xRuKL/wqp8PFdr6vz1MTcqWUbKJQVSwklamyxnJiCJJEQYim9rlhsoETimeYbD9hGVI1nR0eEBlr7VzLFGFNAQntSyh7SuoYT9OA60jkc5kmD9qOl37+2Fxy9cegSeY7rO3+Ibg4487ue0gic7D4SAm57cJ8PnVaxIcvb3nKIkUCTZNkKRW+k+zoxqBI1SSz6A5RKbulf8sRYTiHt5Sie9Gyo41rNrE02VWIH3Hr1vhS76LxVQO+padMl5M60bjltbLB5GwY2cCjYFXvenlR+LmhkUf2A2gtj2048ubLP6x+ae8+6UdZIFJwYdabZIETB+Dp7n5FhTmEt+X5jgzBwY4U4TFePeyxjbTFMmlhOcLt+zRhcSCHo1WouhGuzpUvyCojE5X/05rUQ+8FtwYqcDDyxqttq8/J8/esD9xvHj6ADjcy8TFvIi+XHmYUyUYN7hejjRs3q2rS1XGXoB/nzwmsXUcEKZAcfJRofxXjhaj+FL2bYp6m4VkgBnQslAA6gmnE3vzmWkQnS0KApMAnFgHDfRavPcgRimgQkhghITTQJaYGDClpxHeojPH6yV6Dp/CZW9ZheD7/s+XqfANC5uX1rPpd+zywA61AZasrNjdmTC+r0VE048DCfbE1SYKLN5ORhmxlINM4qSFvozABinhz/EEAZhcHxnThakoPuZKdyif/M2MyRBR/u8bQZlHgfdRdp+TgXND8PH0SPGd76P82fiKoE4L4MPNygQfyjy7lHyMHe3g/qKmJiBcihqb7nzyfGOU0RxF1hR9XXBq2f3ikq0KEO+47fg+E5THjix49LjLKNG3c5noSYNTEw8U9W4kGfChfXRrxHkUikysklHqfZqWl3A6E3qIljydQw99OQ9Mnx19sZgH3/PKa4EiqTChqmIGWoxSOrojo+xNTRw8sWwrQnrcdYFBkL1r1i6YjqO26JEJyNIDFo9bqOw1TrHoxaMqBbwIS8XcjBrqG+LU0TegpFtQTGOoc9g2FbF8wT4FW1Wfg5RtmGbTWS3QAnZ1vCqjwVqRIWGwjqIZZJl5xdTsJZLAzi+GhoG2+cuwgFLXY2VIYkBNOY4LuQ+s/c2ibY+w2K116KjhlP4i44cFNng3lZcclkvd85UbsjmYxpD4Q7RlzFGWrSPk7Pr9I4xLINoOx9tJRUeLpt6hKBr8ZHGIMzj6FDuxnkxz6M/gYVVnXPIWDRQ41HgiRtb1e/vqEERB44pQRVQOcG4VFQOu32rX24dPgXFAXe3bTNndnxymCfPNZJW4pH1ZwLEhWRHoMm4V6ARp6EoLX2uZCoANFWGYaHRdDkVO37cjIhaWllP6cOACKaSYaCbjy8ZUM3E47cbmr8RYpeInxwqnAttYnY46VCW2PzopR8mjwTo4L5pDwRxaNGhdKs+IWPvvT6Y/s/9ixGbYOrl0d3pjvj5yTY5yKahCNlTSASS0llVuwlB1xizMw2Zj1dWyT0FjE35KhobEPnr5RlxpqCyCmW2pAJ4nKQAK7W3dkkd9mqViLjz8kpTOzSqELPdHmkpc9dTTS0eUBeYJwiy763vByB95HFkMyTAENF0HNHlkGRXA9JdnpaJjJGm42PdqMhmGGEpgBLjrkaBEkPVIa0+CEjmyMssF15l2/MB0nQiAF1WLVvBQmZjqIHaigwQJkAMcOzj17tKBsQiYDb7hlJ12x6azdCqKnH2Pivnz+53UE9Qp5VrLFM9pxMn75vu7Ofedj9nfrSeQwSQ7eD3RUt6VyLRi6JZhcILJNhBE0fJi2NujB9nxTwEfvVWr6kwTQaOfRbZj28bDf51OR5LGOwXYyCZGNlEQozQnn5MbWVmZlu7Do9ofZC8OjxJKDFcnRzJMWIKCZHk0MI8rr9ZwLxa+HlTx6In3Q1gyzZcinw5EM1sLAzQYDGPcT8QDgLbwC1bfZuaKguBtQy+zQgdNA5OzcZ9ameyB9m62EXvVIMdZ9BaiDgW+wyChkgqGb4wa8VCZyKm+PlO6tjPCdQh6EqJpB4shYvC/4oFD5mBBqfSi/Fgft8u58DNK2L+oRFj4g1SPAjIOn19LL1s8yyzpN21txZY1x1GrjRz2ViEzM1L5zIYIUb8Ui1TcEFY1p2lQxEu8wWNPiqtTW3klsdFvLdiwUNG4t/qKYrD08H8/cdvWp/v7ghdaGRTxX6l+gEfBsimr+bRat+26HH7pqKCZmUILlG382EoCsMW/M8tJl1coiDY5nlktDmCXFqDNEf4nJcHKDz4i+89KY0xh0vt6XQN4eT7DT66qAU69+MW3QwubW9WhD4JC73MRlK/4b6LFgFjBxbKm7unWp6iRYBjwdcbHtlcGmjv63b7Xg4kpcAhDH+H3Dtsn0hNoMLNHxt7uPPNoyXH3AoL4y6J9m6QDgHA9LxSlhWuFNjt8M+tzDdKtTM1RI33L5+rGji+Sg/ciE0Geza9SgNR1LXaG92IInfPkbHQS9i4XcQA8XHTWOJSTiwrg/ZxXPHxYdZMTHq6qqcTC3cqW4DjKcEOKo7WM/5Ktm2GCn4UAFSAZUJYGV1rYvNFcM1td9i3hTk4+/Y3i4XoGhwhQ4UtQGENmt8j0Aj9LRQO6KTL0W0gO9tfQDJr1Wv9y1c4w9hPuYHhCRg/FzUB6IrOzeYqc6XaHJ+S/xSQ+GnSV62hzTDRtYN1mMXOVKnnJBhnEx5NzmGpt0ok0iJYW3JFjWTiN1CoS/UaUyXUpWJSwxD7aGQ+DxJjIDFvUiLOdsJrT0jKnJz3Tgo9DnSb56aYnTViB9NjlzaRhgd2KH58nFJcYwUVSgNe2gyaWoG8iohOuj6bSQcwh/l1G2x9zi8uDUNtja1iOz+GAZnRlajNq+DetBXIJRCd+p9Nj4/evvtQ8v16r3kjg/wvz/ztX6f0vci1BVtqoXVBE0rU1n1nN5fBVo9SfD/AsgEHo/106O9sFKJteH/GFg5shupUsE6HN5dlcJfe+GNeVKDRGsqZi6dOhhOpJ1l0e8BzyBqZZaIyDzDVskyI04XdAxLJyHWFoUEUir/18+G44uGH7oYVM4J9AogkQ/2UWR61N3S7IqGvfJl2fTXhEYIt7GZmkep5N3Mq3bt31tW+4QkW+62LoDAzqw79fytF6Uf8tNNhsHw2i/Ajp/+UrkVzRaa3AkPu98NxXwRGhEyoO4r5pP/7CUO6cvBTqU6mPznHnhltkerRLovN6+kbATjhBJJ9IRCTUXz77esPJSza8Su9OsXiuwD87llvFmQWwdEqiI2rOEZePYUfb+INjMM5aC6GfcPTsQjWzImorVv9xWnLAG7Lt01Rwyo4TFcZs6d+AM/X28sDO/qgw6P75vj+uTI/W/r6JT3Tmm8Nvpi2r19JTgfrQSDoH8qzV9ThdhQrEg/0Ml3F7Ou8AXk1EQrSCu2b9oPLlr96JhWhKjgE0rJMila++yNDieZkHBvSUak4yNNw2/B2kLsnmL77+IZiMnX2fjrFkP1nVD3xjuDNsv2qSsnBwI0MYy49cXItfmA8dxN9hMY+7+T2+ZDgXM1mYaXkTO9K/p4GZLJzdjtEn80MRnJl/SE5wWFLKdN5y+AQOG8SwQcDHA8xfCa7H/shJxabYDl3k8W60mYoDd/AD1m8xvhnWiL7qdszmiMuNkVCYMQ0wkW8fAwPwrNett3fu/3vWcqVCOdAI5Jmd74W7xxH3NxIX+NJXFTkSdvdfCrzWHF/1jeQPsFocyNvs6fR6mJPMNRyIPN4Wn8MDg33FS87hgfhmbdmnd+/3fCg2ZVIxyAOIXpXgs5oAGz5nOYGM3hReHO04uXTib4KWxaDO2PFm98SzMkQ5dApBpihB3UruNe4ouSvRYDNCI6vggaoG4VmnumdNXOT9IAlxDaeA3KOGIV6v3zx8SFPMIIecgUcAs60/k/Psjdp5fTm270rXEtEJc0DH8lYyspAP8seOVDua8bmYhRfkyiTpGodnpsQI9HswH14b0DZP4Eicg3L6Kqb/EX4ihNjcm5q5Gd6c4liVjKM8ZkEnOHAefubLOuhDhcyCvIvXS6fzCXhmFuz7w644toOchVcLkd9dSpTWwpmJ/IdtxfPOc/REi4PPPYk7bEKBMlEZm9e5aMIYJ9lzo4+MK654it4B6G4lPSzTMmuSFgFQqd9FM1ztBE3Fp8Nf/Zx2bYqcSDpRMV/pjOHBKSuMGaEI+/0U7YsU1oyraiHbEY43MN/g3lTSAMR9z4qqr1sVKUnyFKfPVSXBGAnQOJhlEE/lebFg8BXvSNRzf+5iHi2IMj8h6HxrppeGEQcmYLYYLg3tWaG6skTatrTRfSIRyfVM6z9432kkUl9ksUTuw0N9sFB4H7/3Uz7YqtY3mWPRXhSrG+CH/6b8ZndRkTmrFSVu8cEKg8xZeNjWXbutsieLyhmvuqD2/VIDCKJHaK1vaOGnCH/o/5FgkPdLrlpPous11sk556IKNYQIJdAIrU0IqvB88msCJY1VDD53AQ61w7jZkBdl9uvdiWepibOB8vcyBvWH35hdWFKuUndHiWWXrJjp0blQIHtzp4JWVFCVzJCdqz7AhogWSnq2vx5THLi0KvJZ4gGs8wv9AN0TcnG0r8wZLp7LBc11Hkr5xU/yR4xrYKGT1FOvAML90OeOS8XPM67+WVyvPPCnNCLb7sBos6PTyt5Vkg7OZW3uRm3LFvBDNw34FqW2mSgBrsk+z0XIOke0QLHfA9/WeBJnXgL6IoY24ilruOqrl3bP/aaIG4bVFIkLjhirNXZ95Nloi0nrwMww49gPrQ8xrzgT9c+a9UVHZckDWiQqCwhwi6hlw/ALZH3OdpmochEvP9sG10cQGbPlAZ4TwluVuQjsF7piew8Vl7kM/X9JNlFhfu3iY6L7KUszHLqirzjIHZPvIr9bAo7o2i0543NI7OIEk91sNSr7uOC1ZoJW8j1aWm40yb4BSLPVpSkLAj0FXhuIXThj9weOJRqQCauGFWAX//sOYrlI3EqxssCdmaRUc/LdMgUOeppyPM3ipjylrjNJYDAuH8JolM12cD4ttMRkBqqBolu1jsVCghPQ7lsWGUDPIez81xhjOYmv/1czSuyd1aGGuPW7goWMIwgIUWQAAMln7b1bziAXGly3nS2QEDPmxgV+EdNmv1t0XsC6iias01SAC1CMPfn9j8CbCIPWpbHLCyULaLMZaChZ0MkpRXZ8JmYTlhp7WAWiECgF0u7DIYHKo9zoM3W1uAX/koDzut8lZGxNX+n4lJD+aEWBfR2DG1AUPyBH3rxnBMi9t5tZLJ6EsEcNtqYTLGPtiJ04G5HDOyQXLyEVKzGU5y3FviRDyJvfyuLG/lTXG7tWJadteUN4HWWoXwzv3T/gze/tegxd37lAiZsIM+U6HuAOhuhpLPrksBsPPlojE3IsuAXUQxjTLlnSn58269Pc+kBGHHwLUa4nKfrpxm6mBCrjjZrybHnquJa/Dp5I3miKbf2vloAG5C13epnSotwnFzAMu7BcI+m2RmTMQIk2GuoovllSODfAn5h3PUBecfm2BMAsiRyLZ1DnTFndge173TH3oR6pvvAIJwWiSPN6ffwdoSYDQSs9+5OxM8bdsUhUDdVjeDipuLKZYytEZwUDrdknmeWZwKhOFRKSOFNIHIvD49Yfe5qBSAcwGkNkVwNqlGhRj2SJ8oiBegy28GgNXeC0NU2X7vSZ0w3JrV/rz2Rf+eZDdFKZbnSQfC6hak9EGPhb5DzH+o/wCyeIaVOk4KlzVYH5gKa4wPE6fbNd+GYjYIom3R+XCJKo21IF25JVqk9/4ZM1Xtmu/p4tbYCn3YAuLGymGpOMNPvONmoB8wSqpfwtkDvtyyx6Vr6sK735YM5qUGb00ujQzNwdr/ebW49egoN6XQBq+/tfBJaG5OOX8vos24dNqe2WRgeW4xEpjVeRrKMyoDHq+xVCOuwRkoXbTpQ+LmbYfqhA7/3INuElcXvV/XJPztMWz3+ZQswG2mq0ca37n+xUhC9MkPotAuHTAO3T2VnQ+gia7O2XSukXH8TUs06a3D+BuifvkZY/uf70n0Zcfto//0S/CxKhrPfvRl62g7AwU+e4SV+mcVHFQ6mZReHSz3iX9WS4xwnVIofA/I2wbdwssKFU9RgbpgZ2sj4BgxmfQBE0lMgu057YN50gEK6sL3LZlpUy3mq8tehjpD/pfNsHz/yS79djJGQpovQExC7uzyZjC6WOnePxkmIshc/Fq6Tg3UHHj2fH7GzzdqR9SXIckr+tc254xtrPBnffy94anCFpY79bgywQ2Dj9K3CrFffl97OiNsnuMdYaQ/VP8j992boazv4vHPOapR9eZ+4WnFqS0NbjQ1nVxPl0HsJiN6277g2RK9enFeVfr3E1+GmD7ztHnA4gaO1Gr6ULQ6VcKztjPb03z+cnlpPI+0EuW3W5IlsHoMr/M8z1aqP0q3Y5EyawJnwFDT0sBY7Nd2jkC4MdKFrWaOXSITLtF29/zIv2z5280s/XYyhfc8vfrgG0jpWZmCe7zPVs0V7Vk4fjb1YfQzgbAD0FwAcFIGrfQT0GCLvIwxFOOZRezQKUJFHbMheGc4IM+CRPcxkUVdTcX8Re6BFVtDDdq++GuvN45uFR7/A4ANC8SP6xyb8JHkkwhrCZXT7ckXx+SN5JMJ+i/Df5TEifk0W0d0xC4HHIX6xJyBpSSa3VR2xMzT9F/MbeBzi/1BCzIaYGxF3H+LvKgkFzUU54FI1R/LKbAXENI9DfDxBydFlxnz+34wbABA/aCT8CWvjjPnQO/5j6Nz8jR7+Oo7uLJSgGCVfnCWx76a/P3xctln/dLCVlEu+vPTokLqNysD9Et3n36nldXkr1bokld8lqhVLUf5dqcrpMs/Sv1i5Hz9LW/sIvPubv7xF9S9Rtt8b7Qwa7e/s0maZpSORk2Ri1DNYPeWO9nh7Cbru+kpfeqfJzyvVoiWq9qXoPg3SM/epvLGtygSXRFIy2O3q7aqdyxcILSKsB2d+TVn3IsD2hcmQH5DPYjIB31NqcRHJ4FyYHtSulOr87KX1vjEekrKZTiq7lFKDBmFght2Xfu82ElmON4FYpNyfPqmjU6p7s1crS5b38+7Z9yMHCgd1bkp5joa1NjWpDZ+T3ekX2dWvvKTtnt5aHtbnXZ3b/zxoeSUnMNt8ML399fpuAvc72cNRhn8aUi/+ffSgbSV8+ee+5l0ze2+1sv83fUhl+/8ozM8XnPPppluTDL3/90eQFwAfvnv/AfDZt2sb/l/4//0d3jCgLxi4KATHPp47feT+X5JujNj6hXJoJbaR/nDsG7vrEz40spFAUHdM7pHc+fOaasXHEjIrgSt0XnBvTJ5n7dqBU83YQ06t0f3O93NSu4mU9FvtOqtlCp1MUN9M7oPcxRp9ltyHJrsrQropqPfyZzFu+fWdtr5HKmG3Vw7uotmjAFE/XF1KR3KNf7gN98VDfWHq/JXMwcJumtMPNfMUVgfC3O9EXyjaRMGuC5m3iL4p76YpvZLSJzG9oe60FT3S0CtDu6hjFJAdqeiWSJ7CxAnWIl6oYAw7hZliojIxc4JmKkmAJqs0OmuUhavfy+sAIe0mMP/r86VrH5XlSSuDb0uIK1lsQVLTSl5ir6fzTOy6RCNs/4D4/6LLtzGlAm0X6bewycR2UkqjEsuRUJrYhXjN2JkLrQZ3SYuqpZT7Tyea1GLMC5JXiezlR0Fyh4GSYsmLbsPL38GLUctIbB+TypLdEoIKkpC95PL4dtZ0I6a4fAtTKs52ycuU3UkLy5FaDbuqpZWrokShBSmoRGZB6oaBqcWShB9zIuskfk5FtQrE8pPIR5ZwffRzgidTbLJcOMGy+sUqVZlfSMey/pqgvkjaYlK2lqTO0HWWYjqKUqzJ1K5GzUKfMs3Te9tDUxfN6AhD/uni9nMshfvYueE5I7ev41lzIrucnG/a9ANNtqdAnQ6YxZz5jgtd3WyRglzme+d+lQtPHhdchYU8TfJWt3Jrulh+0Rp1GGFkVggoJoza2bGFS7Ink9zhrm56emnx2GwqNmZjnwrmbIsMKHqvbVU+IrtYiPcJmJWXWdutjIjRMT9o4MTiUqo5xwrr5SVVz2ZUwmJx0vT5rWokYlLe9bO0emr7oD1PXTs7M3WsQCkrSfejKpeXRGAW4JuijbLDyNMjX45zs9e94XY3e2X2aUlL4Ji5yx76X9wfxZIDDBofdgct77DEwFsGndKFFYWAzD8m1CM6r/t8CYBYuB4AozoZgJBqn45iAzAmagTXuyQJ9c7FLoCGwiyfXjWgFALRHdhXlrzoJRrL6GVtM4+KlQpkUktTIavkl+HyyyJrEJfUWCpDyYVZpMw5JiiVgiqFreTMFofRCaaZ3XmIxPj8EoLOhabiEUe+aGdYJawXtXiRtBMhtUaaOcrfhWlKemLmibq2F6lWooBm0SjiSmokqrFmjUIl4VdmoXxvz6hTKldHC5dSFdspVVh6WZcjD2mWS5dkXORPaaZXKdxNBbJkK2AoOd9FxlCnPdhWXO0xYh45zPXOdioYnJBuqwzbNLNmI5Otl+xkOem0M+w5cOQUoIVxZP7lIZd12cSBWlhz8lsir+gp8ZaU21H7GyFbSO75V3nw5MXba0scgCqqphumZTuu56NjYGJh4+AyYsyEKTPmLFji4RMQsmLNhi079hw4cuJsAhcirsQkpNzIyAHTyDNZgXxTTdFJS6eQn1f8FSlRqjjCi/43lKlQqTzMi/LcL6XqrFSt1jQ1ukynTu9dwBdHxZgnVpwZ6tSbGUqGHFP+xGQ9evXpN2DQECERMQkpGTkFJVWcl6/LwMjEzMLKxs7BycXNw8vHLyAohBIWERUTl5CUkpaRlZNXsBppSqyxFjNKgawYAt6+KbNKU5ZyB32pIpW++lZVqlOTWgYmOmoOc4Y2Q/XAoRPohiGxwKCSIpUvBTKKnQbRmpbpNtrksCOORZux0hgkMzIzdTSdb4w3Sweq9z7Yi4fPUpteadVDSANCRHPNtsB8CzWa5AVljTY5y9nOca7znO8CF7rIxS6xmUXuu2kxtdvuuVWLn2YGJ6JKsiqy0OBIYRlOKfhSUTjxPhKkyJCjQIkKNRq06NBjwIgJMxas2LDjwIkLt01UgD0AAAAAAAAAALDSUIZmXnjSoAgTIUqMOAmSpEiTIUuOPAVWs4a1rGM9G9jIJjazxR7KTAAAAAAAAAAAwEpDIxILZGO5fFLeZWkBYgqQi+hl+PJcnmhVHi5im8RbnNvIJlJiPpcVV6vLpUTCalcvLiVnJyuEEoVrdm7pSqWGlHbKV6+XFBblZh16adFIzKh2PROvJqdST+jZ0n85Lm7XHHfSWQWPu1HkToyvSatoDqekE9PC/6nyjLJkQWaGPieldOHfy3oH9bH2furvQvaY9xLfvYJsXXkHdRRlRv/jECpKZr4s1lYcBgA=";
