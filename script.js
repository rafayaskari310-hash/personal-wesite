/* Healthcare Facilities Web GIS: Islamabad & Rawalpindi
   API: OpenStreetMap Overpass API (no API key required) */
'use strict';

// Several public Overpass servers are queried in parallel; the first answer wins.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
// bbox format: [south, west, north, east]
const AREAS = {
  both: [33.45, 72.80, 33.80, 73.30],
  isb:  [33.48, 72.82, 33.80, 73.30],
  rwp:  [33.50, 72.95, 33.72, 73.15]
};
const TYPES = {
  hospital: { label: 'Hospital', color: '#d62839' },
  clinic:   { label: 'Clinic',   color: '#1b6ca8' },
  doctors:  { label: 'Doctor',   color: '#7b4bb7' },
  pharmacy: { label: 'Pharmacy', color: '#2a9d4b' }
};
const MAX_LIST = 150;
const TIMEOUT_MS = 40000;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const state = { all: [], activeTypes: new Set(Object.keys(TYPES)), markers: new Map(), reqId: 0, notice: '' };

/* ---------- Map ---------- */
const map = L.map('map', { preferCanvas: true }).setView([33.65, 73.05], 11);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
const layer = L.layerGroup().addTo(map);

/* ---------- API: fetch + parse ---------- */
function buildQuery(bbox) {
  const b = bbox.join(','), re = Object.keys(TYPES).join('|');
  return `[out:json][timeout:30];(node["amenity"~"^(${re})$"](${b});way["amenity"~"^(${re})$"](${b}););out center tags;`;
}

async function fetchOverpass(query) {
  const ctrls = ENDPOINTS.map(() => new AbortController());
  const attempts = ENDPOINTS.map((url, i) => (async () => {
    const timer = setTimeout(() => ctrls[i].abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctrls[i].signal });
      if (!res.ok) throw new Error(`Server responded with status ${res.status}`);
      const json = await res.json();                         // parse JSON
      if (!Array.isArray(json.elements)) throw new Error('Unexpected response format');
      if (!json.elements.length && json.remark) throw new Error('Server error: ' + json.remark);
      return json;
    } finally { clearTimeout(timer); }
  })());
  try {
    const json = await Promise.any(attempts);                // first successful server wins
    ctrls.forEach(c => c.abort());
    return json;
  } catch (e) {
    throw new Error('All Overpass servers are busy or unreachable');
  }
}

function normalise(json) {
  return json.elements.map(el => {
    const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon, t = el.tags || {};
    if (lat == null || lon == null || !TYPES[t.amenity]) return null;
    const address = [t['addr:housenumber'], t['addr:street'], t['addr:suburb'], t['addr:city']].filter(Boolean).join(', ');
    return {
      id: `${el.type}/${el.id}`, lat, lon, type: t.amenity,
      name: t.name || t['name:en'] || `Unnamed ${TYPES[t.amenity].label.toLowerCase()}`,
      nameUr: t['name:ur'] || '', speciality: (t['healthcare:speciality'] || '').replace(/;/g, ', ').replace(/_/g, ' '),
      operator: t.operator || '', address, phone: t.phone || t['contact:phone'] || '',
      hours: t.opening_hours || '', website: t.website || t['contact:website'] || '',
      emergency: t.emergency === 'yes', wheelchair: t.wheelchair || ''
    };
  }).filter(Boolean);
}

/* Browser cache: used only when every server fails */
const cacheKey = () => 'healthcare-cache-' + $('area').value;
function saveCache(data) { try { localStorage.setItem(cacheKey(), JSON.stringify({ t: Date.now(), data })); } catch (e) {} }
function readCache() { try { return JSON.parse(localStorage.getItem(cacheKey())); } catch (e) { return null; } }

async function loadData() {
  const id = ++state.reqId;
  $('error').hidden = true; $('loading').hidden = false; state.notice = '';
  const b = AREAS[$('area').value];
  try {
    const json = await fetchOverpass(buildQuery(b));
    if (id !== state.reqId) return;
    state.all = normalise(json);
    saveCache(state.all);
    map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
    render();
  } catch (e) {
    if (id !== state.reqId) return;
    const cached = readCache();
    if (cached && cached.data?.length) {
      state.all = cached.data;
      state.notice = `Live API unavailable. Showing data saved on ${new Date(cached.t).toLocaleString()}. `;
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
      render();
    } else {
      $('errorMsg').textContent = `Could not load facility data: ${e.message}. Check your internet connection and click "Try again" in a few seconds.`;
      $('error').hidden = false;
    }
  } finally { if (id === state.reqId) $('loading').hidden = true; }
}

/* ---------- Filters ---------- */
function filtered() {
  const q = $('search').value.trim().toLowerCase();
  const emergency = $('emergency').checked;
  return state.all.filter(f => {
    if (!state.activeTypes.has(f.type)) return false;
    if (emergency && !f.emergency) return false;
    if (q && !`${f.name} ${f.nameUr} ${f.speciality} ${f.address} ${f.operator}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function popupHtml(f) {
  return `<h3>${esc(f.name)}</h3><p><strong>${TYPES[f.type].label}</strong>${f.emergency ? ' · Emergency' : ''}</p>` +
    (f.address ? `<p>${esc(f.address)}</p>` : '') + (f.phone ? `<p>Phone: ${esc(f.phone)}</p>` : '');
}

function showInfo(f) {
  const rows = [['Type', TYPES[f.type].label], ['Urdu name', f.nameUr], ['Speciality', f.speciality], ['Operator', f.operator],
    ['Address', f.address], ['Phone', f.phone], ['Opening hours', f.hours], ['Emergency', f.emergency ? 'Yes' : ''],
    ['Wheelchair', f.wheelchair], ['Coordinates', `${f.lat.toFixed(5)}, ${f.lon.toFixed(5)}`]]
    .filter(r => r[1]).map(r => `<dt>${r[0]}</dt><dd>${esc(r[1])}</dd>`).join('');
  const site = /^https?:\/\//i.test(f.website) ? `<p><a href="${esc(f.website)}" target="_blank" rel="noopener">Website</a></p>` : '';
  $('info').innerHTML = `<h2>${esc(f.name)}</h2><dl>${rows}</dl>${site}<p><a href="https://www.openstreetmap.org/${f.id}" target="_blank" rel="noopener">View on OpenStreetMap</a></p>`;
}

function select(f) {
  map.setView([f.lat, f.lon], Math.max(map.getZoom(), 16));
  state.markers.get(f.id)?.openPopup();
  showInfo(f);
}

function render() {
  layer.clearLayers(); state.markers.clear();
  const items = filtered();
  items.forEach(f => {
    const m = L.circleMarker([f.lat, f.lon], { radius: 7, color: '#fff', weight: 1.5, fillColor: TYPES[f.type].color, fillOpacity: .95 })
      .bindPopup(popupHtml(f)).on('click', () => showInfo(f)).addTo(layer);
    state.markers.set(f.id, m);
  });
  $('count').textContent = state.notice + (items.length
    ? `Showing ${items.length} of ${state.all.length} facilities` + (items.length > MAX_LIST ? ` (list shows first ${MAX_LIST})` : '')
    : 'No facilities match your filters. Try clearing the search or changing the facility type.');
  const ul = $('list'); ul.innerHTML = '';
  items.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_LIST).forEach(f => {
    const li = document.createElement('li'), b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span class="dot" style="background:${TYPES[f.type].color}"></span><span>${esc(f.name)}<br><small>${TYPES[f.type].label}${f.address ? ' · ' + esc(f.address) : ''}</small></span>`;
    b.addEventListener('click', () => select(f));
    li.appendChild(b); ul.appendChild(li);
  });
}

/* ---------- UI wiring ---------- */
Object.entries(TYPES).forEach(([k, t]) => {
  const l = document.createElement('label');
  l.innerHTML = `<input type="checkbox" value="${k}" checked><span class="dot" style="background:${t.color}"></span>${t.label}`;
  l.querySelector('input').addEventListener('change', e => { e.target.checked ? state.activeTypes.add(k) : state.activeTypes.delete(k); render(); });
  $('types').appendChild(l);
});
$('search').addEventListener('input', debounce(render, 200));
$('emergency').addEventListener('change', render);
$('area').addEventListener('change', loadData);
$('retry').addEventListener('click', loadData);

loadData();