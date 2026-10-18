import './heatmap.css';

/* ------------------------------------------------------------------ *
 *  Carte de chaleur : engagement moyen sur X, par jour et par heure.
 *  Valeurs lues visuellement sur une carte publiée par Sprout Social
 *  (données du 7 nov. 2025 au 27 fév. 2026) : approximation à ±1 niveau.
 *  Niveaux : 0 = très faible … 5 = très élevé.
 *  Lignes : lundi → dimanche. Colonnes : 0 h → 23 h (heure locale de l'audience).
 * ------------------------------------------------------------------ */
const DATA = [
  [1, 1, 0, 0, 0, 0, 0, 1, 2, 2, 3, 4, 4, 4, 5, 5, 4, 5, 4, 4, 4, 4, 3, 2], // Lun
  [2, 1, 1, 0, 0, 1, 1, 1, 2, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 3], // Mar
  [2, 1, 1, 0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 3], // Mer
  [2, 1, 1, 0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 3, 2], // Jeu
  [2, 1, 1, 0, 0, 0, 1, 2, 2, 3, 3, 4, 4, 5, 5, 4, 4, 4, 4, 3, 3, 3, 2, 2], // Ven
  [2, 1, 1, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], // Sam
  [2, 1, 0, 0, 0, 0, 0, 1, 1, 2, 3, 3, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 2], // Dim
];

const CITIES = [
  { id: 'ouaga', name: 'Ouagadougou', tz: 'Africa/Ouagadougou' },
  { id: 'ny', name: 'New York', tz: 'America/New_York' },
  { id: 'paris', name: 'Paris', tz: 'Europe/Paris' },
];
const DAY_SHORT = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const DAY_LONG = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const LEVELS = ['Très faible', 'Faible', 'Modéré', 'Bon', 'Élevé', 'Très élevé'];
const EN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/* --- Utilitaires de fuseaux (indépendants du reste de l'app) --- */
const cache = new Map();
function dtf(key, locale, opts) {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    cache.set(key, f);
  }
  return f;
}
const pad = (n) => String(n).padStart(2, '0');

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
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(tz, y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let t = guess - tzOffsetMs(tz, guess);
  t = guess - tzOffsetMs(tz, t);
  return t;
}

const ymd = (date, tz) =>
  dtf(`y|${tz}`, 'en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);

const dayIndex = (date, tz) => EN_DAYS.indexOf(dtf(`w|${tz}`, 'en-US', { timeZone: tz, weekday: 'short' }).format(date));

const hourIn = (date, tz) => parseInt(dtf(`h|${tz}`, 'en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date), 10) % 24;

const hm = (date, tz) =>
  dtf(`t|${tz}`, 'fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

// Prochaine fois où il sera [jour dayIdx, heure hour] dans le fuseau tz
function nextOccurrence(tz, dayIdx, hour) {
  const now = Date.now();
  const [y, m, d] = ymd(new Date(now), tz).split('-').map(Number);
  for (let k = 0; k < 8; k++) {
    const day = new Date(Date.UTC(y, m - 1, d + k));
    if ((day.getUTCDay() + 6) % 7 !== dayIdx) continue;
    const utc = zonedToUtc(tz, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, 0);
    if (utc > now) return new Date(utc);
  }
  return new Date(now);
}

/* --- Interface --- */
let city = CITIES[1]; // New York par défaut
let sel = null; // { d, h }
let root;

const $ = (s) => root.querySelector(s);

function renderCities() {
  $('#heat-city').innerHTML = CITIES.map(
    (c) => `<button type="button" class="chip ${c.id === city.id ? 'on' : ''}" data-city="${c.id}">${c.name}</button>`
  ).join('');
}

function renderGrid() {
  const now = new Date();
  const nowD = dayIndex(now, city.tz);
  const nowH = hourIn(now, city.tz);
  let html = '<div></div>';
  for (let h = 0; h < 24; h++) html += `<div class="hm-h">${h % 3 === 0 ? h : ''}</div>`;
  DATA.forEach((row, d) => {
    html += `<div class="hm-d">${DAY_SHORT[d]}</div>`;
    row.forEach((lv, h) => {
      const cls = `hm-c lv${lv}${nowD === d && nowH === h ? ' now' : ''}${sel && sel.d === d && sel.h === h ? ' sel' : ''}`;
      html += `<button type="button" class="${cls}" data-d="${d}" data-h="${h}" aria-label="${DAY_LONG[d]} ${h} h : engagement ${LEVELS[lv].toLowerCase()}"></button>`;
    });
  });
  $('#heat-grid').innerHTML = html;
}

function renderDetail() {
  const box = $('#heat-detail');
  if (!sel) {
    box.hidden = true;
    return;
  }
  const { d, h } = sel;
  const lv = DATA[d][h];
  const utc = nextOccurrence(city.tz, d, h);
  const refDay = ymd(utc, city.tz);
  const line = (c) => {
    const diff = dayDiff(ymd(utc, c.tz), refDay);
    const tag = diff ? `<i>${diff > 0 ? '+' : '−'}${Math.abs(diff)} j</i>` : '';
    return `<div class="hd-row"><span>${c.name}</span><b>${hm(utc, c.tz)}${tag}</b></div>`;
  };
  box.innerHTML = `
    <div class="hd-top">
      <div><strong>${DAY_LONG[d]} ${pad(h)}:00</strong><span class="muted"> · ${city.name}</span></div>
      <span class="hd-level lv${lv}">${LEVELS[lv]}</span>
    </div>
    ${CITIES.map(line).join('')}
    <button type="button" class="btn primary" id="heat-remind">Programmer un rappel</button>`;
  box.hidden = false;
}

function renderAll() {
  renderCities();
  renderGrid();
  renderDetail();
}

function build() {
  const screen = document.querySelector('#screen-planning');
  if (!screen) return;

  // On range le contenu existant (créneaux) dans un bloc, puis on ajoute le sélecteur et la carte
  const slots = document.createElement('div');
  slots.id = 'plan-slots';
  while (screen.firstChild) slots.appendChild(screen.firstChild);

  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.innerHTML = `
    <button type="button" class="seg-btn active" data-view="slots">Créneaux</button>
    <button type="button" class="seg-btn" data-view="heat">Carte de chaleur</button>`;

  root = document.createElement('div');
  root.id = 'plan-heat';
  root.hidden = true;
  root.innerHTML = `
    <div class="card">
      <div class="heat-head"><strong>Engagement sur X</strong><span class="muted">Tendances mondiales</span></div>
      <p class="heat-hint">Heure locale de l’audience visée :</p>
      <div id="heat-city" class="chips"></div>
      <div id="heat-grid" class="heat"></div>
      <div class="heat-legend">
        <span>Faible</span>
        <div class="heat-scale"><i class="lv0"></i><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><i class="lv5"></i></div>
        <span>Élevé</span>
      </div>
    </div>
    <div id="heat-detail" class="card heat-detail" hidden></div>
    <p class="note">Touche une case pour voir l’heure correspondante dans les trois villes. Le cadre blanc marque l’heure actuelle chez l’audience choisie. Ces niveaux sont lus approximativement sur une carte publiée par Sprout Social (données du 7 nov. 2025 au 27 fév. 2026) : ce sont des tendances générales, pas tes statistiques.</p>`;

  screen.append(seg, slots, root);

  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (!btn) return;
    const heat = btn.dataset.view === 'heat';
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    slots.hidden = heat;
    root.hidden = !heat;
    if (heat) renderAll();
  });

  root.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-city]');
    if (chip) {
      city = CITIES.find((c) => c.id === chip.dataset.city);
      renderAll();
      return;
    }
    const cell = e.target.closest('.hm-c');
    if (cell) {
      sel = { d: +cell.dataset.d, h: +cell.dataset.h };
      renderGrid();
      renderDetail();
      return;
    }
    if (e.target.closest('#heat-remind') && sel) {
      const p = nextOccurrence(city.tz, sel.d, sel.h);
      document.dispatchEvent(
        new CustomEvent('postime:reminder', {
          detail: {
            hour: p.getHours(),
            minute: p.getMinutes(),
            days: [p.getDay() + 1], // jour du téléphone, 1 = dimanche (Capacitor)
            label: `${city.name} · ${DAY_SHORT[sel.d]} ${sel.h} h`,
          },
        })
      );
    }
  });

  // Met à jour le cadre « maintenant » toutes les minutes
  setInterval(() => {
    if (!root.hidden) renderGrid();
  }, 60000);
}

if (typeof document !== 'undefined') build();

export { DATA, nextOccurrence };
