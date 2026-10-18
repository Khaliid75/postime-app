import './style.css';
import './heatmap.js';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

/* ------------------------------------------------------------------ *
 *  Données de base
 * ------------------------------------------------------------------ */
const NATIVE = Capacitor.isNativePlatform();
const CHANNEL_ID = 'postime-rappels';

const OUAGA = { id: 'ouaga', name: 'Ouagadougou', country: 'Burkina Faso', tz: 'Africa/Ouagadougou' };
const NY = { id: 'ny', name: 'New York', country: 'États-Unis', tz: 'America/New_York' };
const PARIS = { id: 'paris', name: 'Paris', country: 'France', tz: 'Europe/Paris' };
const CITIES = [OUAGA, NY, PARIS];

// w = numéro de jour Capacitor : 1 = dimanche … 7 = samedi
const DAYS = [
  { w: 2, short: 'Lun' },
  { w: 3, short: 'Mar' },
  { w: 4, short: 'Mer' },
  { w: 5, short: 'Jeu' },
  { w: 6, short: 'Ven' },
  { w: 7, short: 'Sam' },
  { w: 1, short: 'Dim' },
];

// Créneaux suggérés (heure de New York) — suggestions générales
const SLOTS = [
  { h: 7, t: 'Avant le travail' },
  { h: 9, t: 'Début de matinée' },
  { h: 12, t: 'Pause déjeuner' },
  { h: 15, t: 'Milieu d’après-midi' },
  { h: 18, t: 'Fin de journée' },
  { h: 20, t: 'Soirée' },
  { h: 22, t: 'Fin de soirée' },
];

/* ------------------------------------------------------------------ *
 *  Utilitaires
 * ------------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = (n) => String(n).padStart(2, '0');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* stockage indisponible */
    }
  },
};

let settings = { h24: true, seconds: true, ...store.get('postime.settings', {}) };
let reminders = store.get('postime.reminders', []);
let nextId = store.get('postime.nextId', 1);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

/* ------------------------------------------------------------------ *
 *  Heures et fuseaux (règles saisonnières via Intl, jamais de décalage fixe)
 * ------------------------------------------------------------------ */
const fmtCache = new Map();
function dtf(key, locale, opts) {
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    fmtCache.set(key, f);
  }
  return f;
}

function clockParts(date, tz) {
  const f = dtf(`c|${tz}|${settings.h24}`, 'fr-FR', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: settings.h24 ? 'h23' : 'h12',
  });
  const p = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  return { hm: `${p.hour}:${p.minute}`, s: p.second, ap: (p.dayPeriod || '').toUpperCase() };
}

function hour24(date, tz) {
  const f = dtf(`h|${tz}`, 'en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
  return parseInt(f.format(date), 10) % 24;
}

function dateLabel(date, tz) {
  const f = dtf(`d|${tz}`, 'fr-FR', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' });
  return cap(f.format(date));
}

function ymd(date, tz) {
  return dtf(`y|${tz}`, 'en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function dayDiff(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}

function offsetLabel(date, tz) {
  try {
    const f = dtf(`o|${tz}`, 'fr-FR', { timeZone: tz, timeZoneName: 'shortOffset' });
    const part = f.formatToParts(date).find((x) => x.type === 'timeZoneName');
    return part ? part.value.replace('-', '−') : '';
  } catch {
    return '';
  }
}

// Décalage (en ms) d'un fuseau à un instant donné
function tzOffsetMs(tz, ms) {
  const f = dtf(`x|${tz}`, 'en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = +x.value;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Instant UTC correspondant à une heure locale donnée dans un fuseau
function zonedToUtc(tz, y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}

function phase(h) {
  if (h >= 5 && h < 12) return { label: 'Matin', cls: 'day' };
  if (h >= 12 && h < 18) return { label: 'Après-midi', cls: 'day' };
  if (h >= 18 && h < 23) return { label: 'Soirée', cls: '' };
  return { label: 'Nuit', cls: '' };
}

function relHours(date, tz) {
  const ms = date.getTime();
  const diff = (tzOffsetMs(tz, ms) - tzOffsetMs(OUAGA.tz, ms)) / 3600000;
  if (!diff) return '';
  const sign = diff > 0 ? '+' : '−';
  return `${sign}${Math.abs(diff)} h par rapport à Ouagadougou`;
}

/* ------------------------------------------------------------------ *
 *  Cartes horaires
 * ------------------------------------------------------------------ */
function dayTagHTML(date, now, tz) {
  const d = dayDiff(ymd(date, tz), ymd(now, tz));
  if (d === 0) return '<span class="daytag">Aujourd’hui</span>';
  if (d === 1) return '<span class="daytag shift">Demain</span>';
  if (d === -1) return '<span class="daytag shift">Hier</span>';
  return `<span class="daytag shift">${d > 0 ? '+' : '−'}${Math.abs(d)} j</span>`;
}

function cardHTML(city, date, { seconds, now }) {
  const c = clockParts(date, city.tz);
  const ph = phase(hour24(date, city.tz));
  const rel = city.id === OUAGA.id ? '' : relHours(date, city.tz);
  return `
    <article class="card clock">
      <div class="clock-top">
        <div>
          <h3 class="city">${city.name}</h3>
          <p class="sub">${city.country} · ${offsetLabel(date, city.tz)}</p>
        </div>
        <span class="phase ${ph.cls}">${ph.label}</span>
      </div>
      <div class="time">
        <span class="hm">${c.hm}</span>
        ${seconds ? `<span class="sec">${c.s}</span>` : ''}
        ${c.ap ? `<span class="ap">${c.ap}</span>` : ''}
      </div>
      <p class="date">${dateLabel(date, city.tz)}${now ? dayTagHTML(date, now, city.tz) : ''}</p>
      ${rel ? `<p class="rel">${rel}</p>` : ''}
    </article>`;
}

const lastHTML = new Map();
function setHTML(el, html) {
  if (lastHTML.get(el) !== html) {
    el.innerHTML = html;
    lastHTML.set(el, html);
  }
}

/* ------------------------------------------------------------------ *
 *  Écran 1 — Accueil
 * ------------------------------------------------------------------ */
function renderHome() {
  const now = new Date();
  setHTML($('#home-clocks'), CITIES.map((c) => cardHTML(c, now, { seconds: settings.seconds })).join(''));
}

/* ------------------------------------------------------------------ *
 *  Écran 2 — Convertisseur (pas de 15 minutes, de −12 h à +12 h)
 * ------------------------------------------------------------------ */
let offsetQ = 0; // en quarts d'heure

function offsetText(q) {
  if (q === 0) return 'Heure actuelle';
  const sign = q > 0 ? '+' : '−';
  const total = Math.abs(q) * 15;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${sign}${h} h${m ? ' ' + pad(m) : ''}`;
}

function renderConverter() {
  const now = new Date();
  const sim = new Date(now.getTime() + offsetQ * 15 * 60000);
  $('#conv-label').textContent = offsetText(offsetQ);
  $('#conv-slider').value = offsetQ;
  setHTML($('#conv-clocks'), CITIES.map((c) => cardHTML(c, sim, { seconds: false, now })).join(''));
}

function setOffset(q) {
  offsetQ = Math.max(-48, Math.min(48, q));
  renderConverter();
}

/* ------------------------------------------------------------------ *
 *  Écran 3 — Planning (référence : New York)
 * ------------------------------------------------------------------ */
function renderPlanning() {
  const now = new Date();
  const [y, m, d] = ymd(now, NY.tz).split('-').map(Number);
  $('#plan-date').textContent = dateLabel(now, NY.tz).toLowerCase();

  const html = SLOTS.map((slot, i) => {
    const utc = new Date(zonedToUtc(NY.tz, y, m, d, slot.h, 0));
    const ny = clockParts(utc, NY.tz);
    const refDay = ymd(utc, NY.tz);
    const other = (city) => {
      const c = clockParts(utc, city.tz);
      const diff = dayDiff(ymd(utc, city.tz), refDay);
      const tag = diff ? `<i>${diff > 0 ? '+' : '−'}${Math.abs(diff)} j</i>` : '';
      return `<span>${city.name} <b>${c.hm}${c.ap ? ' ' + c.ap : ''}</b>${tag}</span>`;
    };
    return `
      <article class="card slot">
        <div>
          <div class="ny">${ny.hm}<small>${ny.ap || 'New York'}</small></div>
          <div class="title">${slot.t}</div>
        </div>
        <button class="btn ghost" data-slot="${i}">Rappel</button>
        <div class="others">${other(PARIS)}${other(OUAGA)}</div>
      </article>`;
  }).join('');
  setHTML($('#plan-list'), html);
}

function slotToReminder(i) {
  const now = new Date();
  const [y, m, d] = ymd(now, NY.tz).split('-').map(Number);
  const utc = new Date(zonedToUtc(NY.tz, y, m, d, SLOTS[i].h, 0));
  // Heure locale du téléphone pour ce créneau
  openSheet(null, { hour: utc.getHours(), minute: utc.getMinutes(), label: SLOTS[i].t });
}

/* ------------------------------------------------------------------ *
 *  Écran 4 — Rappels
 * ------------------------------------------------------------------ */
function daysText(days) {
  const set = new Set(days);
  if (set.size === 7) return 'Tous les jours';
  if (set.size === 5 && [2, 3, 4, 5, 6].every((w) => set.has(w))) return 'Lun – Ven';
  if (set.size === 2 && set.has(7) && set.has(1)) return 'Week-end';
  return DAYS.filter((d) => set.has(d.w)).map((d) => d.short).join(' ');
}

function renderReminders() {
  const list = $('#rem-list');
  if (!reminders.length) {
    list.innerHTML = '<div class="empty">Aucun rappel pour l’instant.<br />Appuie sur + ou choisis un créneau dans le planning.</div>';
    lastHTML.delete(list);
    return;
  }
  const sorted = [...reminders].sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  list.innerHTML = sorted
    .map(
      (r) => `
      <article class="card reminder ${r.enabled ? '' : 'off'}" data-id="${r.id}">
        <div>
          <div class="rtime">${pad(r.hour)}:${pad(r.minute)}</div>
          <div class="rmeta">${r.label ? esc(r.label) + ' · ' : ''}${daysText(r.days)}</div>
        </div>
        <input type="checkbox" class="switch" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} aria-label="Activer le rappel" />
      </article>`
    )
    .join('');
  lastHTML.delete(list);
}

function persistReminders() {
  store.set('postime.reminders', reminders);
  store.set('postime.nextId', nextId);
}

/* --- Notifications locales --- */
async function ensureChannel() {
  if (!NATIVE) return;
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Rappels de publication',
      description: 'Rappels programmés dans Postime',
      importance: 5,
      visibility: 1,
      vibration: true,
    });
  } catch {
    /* canal déjà créé ou non pris en charge */
  }
}

async function ensurePermission() {
  const status = await LocalNotifications.checkPermissions();
  if (status.display === 'granted') return true;
  const asked = await LocalNotifications.requestPermissions();
  return asked.display === 'granted';
}

const notifIds = (r) => DAYS.map((d) => ({ id: r.id * 10 + d.w }));

async function cancelReminder(r) {
  if (!NATIVE) return;
  try {
    await LocalNotifications.cancel({ notifications: notifIds(r) });
  } catch {
    /* rien à annuler */
  }
}

async function applyReminder(r) {
  if (!NATIVE) {
    if (r.enabled) toast('Rappel enregistré (les notifications fonctionnent dans l’application Android).');
    return;
  }
  try {
    await cancelReminder(r);
    if (!r.enabled) return;
    if (!(await ensurePermission())) {
      toast('Notifications refusées : autorise-les dans les réglages Android.');
      return;
    }
    await ensureChannel();
    await LocalNotifications.schedule({
      notifications: r.days.map((w) => ({
        id: r.id * 10 + w,
        title: 'Postime — c’est l’heure de publier',
        body: r.label || 'Un rappel de publication t’attend.',
        channelId: CHANNEL_ID,
        schedule: { on: { weekday: w, hour: r.hour, minute: r.minute }, allowWhileIdle: true },
      })),
    });
  } catch (e) {
    toast('Impossible de programmer le rappel.');
    console.error(e);
  }
}

// Au lancement : on remet en place les rappels actifs si la permission est déjà accordée
async function syncAll() {
  if (!NATIVE) return;
  try {
    const status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') return;
    await ensureChannel();
    for (const r of reminders) await applyReminder(r);
  } catch (e) {
    console.error(e);
  }
}

/* --- Fenêtre d'édition --- */
let editingId = null;
let selectedDays = new Set();

function buildChips() {
  $('#r-days').innerHTML = DAYS.map((d) => `<button type="button" class="chip" data-day="${d.w}">${d.short}</button>`).join('');
}

function paintChips() {
  $$('#r-days .chip').forEach((c) => c.classList.toggle('on', selectedDays.has(+c.dataset.day)));
}

function openSheet(id, preset = {}) {
  showScreen('reminders');
  const r = id != null ? reminders.find((x) => x.id === id) : null;
  editingId = r ? r.id : null;
  $('#sheet-title').textContent = r ? 'Modifier le rappel' : 'Nouveau rappel';
  $('#r-label').value = r ? r.label : preset.label || '';
  const hour = r ? r.hour : preset.hour ?? 18;
  const minute = r ? r.minute : preset.minute ?? 30;
  $('#r-time').value = `${pad(hour)}:${pad(minute)}`;
  selectedDays = new Set(r ? r.days : DAYS.map((d) => d.w));
  paintChips();
  $('#r-delete').hidden = !r;
  $('#sheet').hidden = false;
}

function closeSheet() {
  $('#sheet').hidden = true;
  editingId = null;
}

async function saveSheet() {
  const value = $('#r-time').value;
  if (!value) return toast('Choisis une heure.');
  if (!selectedDays.size) return toast('Choisis au moins un jour.');
  const [hour, minute] = value.split(':').map(Number);
  const label = $('#r-label').value.trim();
  const days = DAYS.map((d) => d.w).filter((w) => selectedDays.has(w));

  let r;
  if (editingId != null) {
    r = reminders.find((x) => x.id === editingId);
    await cancelReminder(r);
    Object.assign(r, { hour, minute, label, days, enabled: true });
  } else {
    r = { id: nextId++, hour, minute, label, days, enabled: true };
    reminders.push(r);
  }
  persistReminders();
  closeSheet();
  renderReminders();
  await applyReminder(r);
}

async function deleteFromSheet() {
  const r = reminders.find((x) => x.id === editingId);
  if (!r) return closeSheet();
  await cancelReminder(r);
  reminders = reminders.filter((x) => x.id !== r.id);
  persistReminders();
  closeSheet();
  renderReminders();
  toast('Rappel supprimé.');
}

/* ------------------------------------------------------------------ *
 *  Écran 5 — Paramètres
 * ------------------------------------------------------------------ */
function saveSettings() {
  store.set('postime.settings', settings);
}

async function testNotification() {
  if (!NATIVE) return toast('Disponible dans l’application Android.');
  try {
    if (!(await ensurePermission())) return toast('Notifications refusées dans Android.');
    await ensureChannel();
    await LocalNotifications.schedule({
      notifications: [
        {
          id: 999999,
          title: 'Postime — test',
          body: 'Les notifications fonctionnent.',
          channelId: CHANNEL_ID,
          schedule: { at: new Date(Date.now() + 3000), allowWhileIdle: true },
        },
      ],
    });
    toast('Notification test dans 3 secondes…');
  } catch (e) {
    toast('Le test a échoué.');
    console.error(e);
  }
}

async function exactAlarms() {
  if (!NATIVE) return toast('Disponible dans l’application Android.');
  try {
    const s = await LocalNotifications.checkExactNotificationSetting();
    if (s.exact_alarm === 'granted') return toast('Alarmes exactes déjà autorisées.');
    await LocalNotifications.changeExactNotificationSetting();
  } catch {
    toast('Réglage non nécessaire sur cette version d’Android.');
  }
}

/* ------------------------------------------------------------------ *
 *  Navigation
 * ------------------------------------------------------------------ */
function showScreen(name) {
  $$('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  $('#screen-title').textContent = $(`#screen-${name}`).dataset.title;
  window.scrollTo(0, 0);
  if (name === 'home') renderHome();
  if (name === 'converter') renderConverter();
  if (name === 'planning') renderPlanning();
  if (name === 'reminders') renderReminders();
}

/* ------------------------------------------------------------------ *
 *  Démarrage
 * ------------------------------------------------------------------ */
function init() {
  buildChips();

  $$('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => showScreen(b.dataset.go)));

  // Convertisseur
  $('#conv-slider').addEventListener('input', (e) => setOffset(+e.target.value));
  $('#conv-reset').addEventListener('click', () => setOffset(0));
  $('#conv-minus').addEventListener('click', () => setOffset(offsetQ - 4));
  $('#conv-plus').addEventListener('click', () => setOffset(offsetQ + 4));

  // Planning
  $('#plan-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-slot]');
    if (btn) slotToReminder(+btn.dataset.slot);
  });

  // Rappels
  $('#rem-add').addEventListener('click', () => openSheet(null));
  $('#rem-list').addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const r = reminders.find((x) => x.id === +toggle.dataset.toggle);
      r.enabled = toggle.checked;
      persistReminders();
      renderReminders();
      await applyReminder(r);
      return;
    }
    const card = e.target.closest('.reminder');
    if (card) openSheet(+card.dataset.id);
  });
  $('#r-days').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-day]');
    if (!chip) return;
    const w = +chip.dataset.day;
    selectedDays.has(w) ? selectedDays.delete(w) : selectedDays.add(w);
    paintChips();
  });
  $('#r-save').addEventListener('click', saveSheet);
  $('#r-delete').addEventListener('click', deleteFromSheet);
  $$('[data-close]').forEach((el) => el.addEventListener('click', closeSheet));

  // Paramètres
  $('#set-h24').checked = settings.h24;
  $('#set-seconds').checked = settings.seconds;
  $('#set-h24').addEventListener('change', (e) => {
    settings.h24 = e.target.checked;
    saveSettings();
    lastHTML.clear();
    tick();
  });
  $('#set-seconds').addEventListener('change', (e) => {
    settings.seconds = e.target.checked;
    saveSettings();
    tick();
  });
  $('#btn-test').addEventListener('click', testNotification);
  $('#btn-exact').addEventListener('click', exactAlarms);

  renderHome();
  setInterval(tick, 250);
  syncAll();
}

function tick() {
  const active = $('.screen.active').id;
  if (active === 'screen-home') renderHome();
  else if (active === 'screen-converter') renderConverter();
}

init();
