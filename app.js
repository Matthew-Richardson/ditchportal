import { config } from './config.js?v=public-reports';
import { canSubmit, globalId, sendReports } from './intake.js';
import { setupPublicReports } from './public-reports.js?v=purple-ditches';

const $ = id => document.getElementById(id);
const helpDialog = $('report-help');
$('show-help').addEventListener('click', () => helpDialog.showModal());
helpDialog.showModal();

const L = window.L;
const COUNTY = 'https://gis.lpcgov.org/arcgis/rest/services';
const countyBounds = L.latLngBounds([36.99, -108.25], [37.66, -107.46]);
const mapColors = getComputedStyle(document.documentElement);
const damageStyle = { color: mapColors.getPropertyValue('--damage').trim(), weight: 4, opacity: 1, interactive: false };
const damageOutline = mapColors.getPropertyValue('--damage-outline').trim();
const maxReports = 10;
const maxBatchPhotos = 8;
const maxReportPhotos = 3;
const contactFields = ['contact_name', 'contact_phone', 'contact_email'];
const optionalFields = [
  'ditch_operator', 'observed_date', 'damage_cause', 'delivery_status', 'threat_notes',
  'acres_affected', 'repair_status', ...contactFields,
];
const queue = [];
const confirmedLocations = [];
let latestReceipt = null;
let lastSavedReportId;
let prefilledContact = null;
let reportPage = 0;
const reportSteps = ['choose', 'map', 'damage', 'impact', 'contact'];
const stepHeadings = { choose: 'choice-title', map: 'map-title', damage: 'form-title', impact: 'impact-title', contact: 'contact-title', review: 'queue-title' };
let batchId = globalId();
let mode = null;
let points = [];
let draftDitch = null;
let photos = [];
let editing = null;
let preparingPhotos = false;
let sending = false;
let intakeReady = false;
let uncertain = false;
let ditchPaths = [];
let ditchDataRequest;

function message(element, value = '', error = false) {
  element.textContent = value;
  element.hidden = !value;
  element.classList.toggle('error', error);
}

async function checkIntake() {
  const available = await Promise.all([
    canSubmit(config.point, 'esriGeometryPoint'),
    canSubmit(config.line, 'esriGeometryPolyline'),
  ]);
  intakeReady = available.every(Boolean);
  message($('setup-status'), intakeReady ? '' :
    'Online submissions are temporarily unavailable. You can still mark and review damage reports.');
  return intakeReady;
}
message($('setup-status'), 'Checking whether online submissions are available…');

const maxMapZoom = 21;
const map = L.map('map', { minZoom: 8, maxZoom: maxMapZoom, doubleClickZoom: false, zoomSnap: 0.5 });
const topoUrl = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
const topoOptions = {
  maxNativeZoom: 19, maxZoom: maxMapZoom, attribution: 'Esri, HERE, Garmin, USGS, OpenStreetMap contributors',
};
const topo = L.tileLayer(topoUrl, topoOptions).addTo(map);
const openPublicReports = setupPublicReports(L, config, {
  countyBounds, topoUrl, topoOptions, addMappedDitches, damageColor: damageStyle.color, damageOutline,
});
$('view-submitted-reports').addEventListener('click', () => openPublicReports?.(latestReceipt));
const aerial = L.tileLayer(COUNTY + '/Orthos/WM2025Orthos2/MapServer/tile/{z}/{y}/{x}', {
  bounds: countyBounds, minNativeZoom: 11, maxZoom: maxMapZoom, attribution: 'La Plata County GIS, 2025 aerial imagery',
});
aerial.on('tileerror', () => {
  message($('layer-status'), 'The topographic map fills gaps in aerial imagery.');
});
function updateBasemap() {
  const useAerial = $('basemap').value === 'aerial';
  if (useAerial) map.addLayer(aerial);
  else map.removeLayer(aerial);
}
$('basemap').addEventListener('change', updateBasemap);
updateBasemap();
const countyView = () => map.fitBounds(countyBounds, { padding: [10, 10], animate: false });
map.setView(countyBounds.getCenter(), 9, { animate: false });
let mapOpened = false;
const mapOptions = $('map-options');
const mapOptionsToggle = mapOptions.querySelector('summary');
function closeMapOptions() {
  mapOptions.open = false;
  mapOptionsToggle.focus({ preventScroll: true });
}
$('county-view').addEventListener('click', () => {
  countyView();
  closeMapOptions();
});
mapOptions.addEventListener('keydown', event => {
  if (event.key === 'Escape' && mapOptions.open) {
    event.preventDefault();
    closeMapOptions();
  }
});
document.addEventListener('click', event => {
  if (!mapOptions.contains(event.target)) mapOptions.open = false;
});
L.control.scale({ metric: false }).addTo(map);

let vectorSupport;
function loadVectorSupport() {
  vectorSupport ??= (async () => {
    const webgl = document.createElement('canvas').getContext('webgl2');
    if (!webgl) throw new Error('This browser cannot display the county reference layers.');
    webgl.getExtension('WEBGL_lose_context')?.loseContext();
    const scripts = [
      ['esri-leaflet@3.0.18/dist/esri-leaflet.js', '22wLLg9lMgz5Ix2IaWloXs+ScWqPCKxBgJFpSaCl04kKF6e6/GSdoGjtKky8Maac'],
      ['esri-leaflet-vector@4.3.2/dist/esri-leaflet-vector.js', 'mHZ6EpQireK/7bmjGMfM/OwDdnR9QSQY0o6HKLzCjiekUEgSuaEr03W+1G7FFn31'],
    ];
    for (const [path, hash] of scripts) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/' + path;
        script.crossOrigin = 'anonymous';
        script.integrity = 'sha384-' + hash;
        script.onload = resolve;
        script.onerror = () => {
          script.remove();
          reject(new Error('The vector map renderer could not load.'));
        };
        document.head.append(script);
      });
    }
  })().catch(error => {
    vectorSupport = undefined;
    throw error;
  });
  return vectorSupport;
}

function keepDetailedAddressesVisible(style) {
  // Keep the detailed point and house-number styles active through the closest zoom.
  for (const layer of style.layers) {
    if (layer.id === 'Address 1128 Point' || layer.id === 'Address 1128 Label') delete layer.maxzoom;
    if (layer.id === 'Address 1128 Label') {
      // The point layer now supplies the marker at every detailed zoom.
      delete layer.layout['icon-image'];
      delete layer.layout['icon-allow-overlap'];
      delete layer.layout['text-optional'];
      delete layer.paint['icon-color'];
    }
  }
  return style;
}

const referenceLayerUpdates = [
  ['show-roads', 'Roads', 'Roads', 350],
  ['show-addresses', 'AddressPoints', 'Address points', 360, keepDetailedAddressesVisible],
].map(([inputId, service, name, zIndex, style]) => {
  const input = $(inputId);
  const status = $('reference-layer-status');
  const pane = map.createPane(service);
  pane.style.zIndex = zIndex;
  pane.style.pointerEvents = 'none';
  let loading;
  let layer;

  async function updateLayer() {
    message(status);
    if (!input.checked) {
      if (layer) map.removeLayer(layer);
      return;
    }
    try {
      loading ??= loadVectorSupport().then(() => new Promise((resolve, reject) => {
        const overlay = L.esri.Vector.vectorTileLayer(COUNTY + '/Hosted/' + service + '/VectorTileServer', {
          pane: service, attribution: 'La Plata County GIS', style,
        });
        overlay.once('ready', () => resolve(overlay));
        overlay.once('load-error', reject);
      }));
      layer = await loading;
      if (input.checked) layer.addTo(map);
    } catch (error) {
      loading = undefined;
      if (!input.checked) return;
      input.checked = false;
      message(status, error instanceof Error ? error.message : name + ' could not load.');
    }
  }

  input.addEventListener('change', updateLayer);
  return updateLayer;
});

map.createPane('ditches').style.zIndex = 390;
const ditchLabels = L.layerGroup().addTo(map);

function renderProgress() {
  const step = $('layout').dataset.activeStep;
  const location = editing ? queue.findIndex(report => report.id === editing) + 1 : queue.length + 1;
  const progress = step === 'review'
    ? (queue.length ? 'Review · Location ' + (reportPage + 1) + ' of ' + queue.length : 'Review reports')
    : (editing ? 'Editing location ' : 'Location ') + location + ' · Step ' + (reportSteps.indexOf(step) + 1) + ' of ' + reportSteps.length;
  for (const id of ['step-progress', 'expanded-step-progress']) {
    if ($(id).textContent !== progress) $(id).textContent = progress;
  }
}

function setStep(step, focusHeading = false) {
  if (step === 'contact' && !editing && !prefilledContact && !contactFields.some(field => $(field).value)) {
    const previous = queue.find(report => report.id === lastSavedReportId) ?? queue.at(-1);
    if (previous) {
      prefilledContact = Object.fromEntries(contactFields.map(field => [field, previous.details[field]]));
      for (const field of contactFields) {
        $(field).value = prefilledContact[field];
        $(field).setCustomValidity('');
      }
    }
  }
  $('layout').dataset.activeStep = step;
  renderProgress();
  if (focusHeading) {
    window.scrollTo(0, 0);
    $(stepHeadings[step]).focus({ preventScroll: true });
  }
  if (step === 'map') {
    map.invalidateSize({ pan: false });
    if (!mapOpened) {
      countyView();
      mapOpened = true;
      for (const updateLayer of referenceLayerUpdates) updateLayer();
    }
  }
}
for (const button of document.querySelectorAll('[data-go]')) {
  button.addEventListener('click', () => {
    if (button.dataset.check === 'map') {
      const error = locationError();
      if (error) {
        message($('location-status'), error, true);
        return;
      }
    } else if (button.dataset.check && !validateReportFields(button.dataset.check)) {
      return;
    }
    message($('form-message'));
    setStep(button.dataset.go, true);
  });
}
new ResizeObserver(() => {
  if ($('map').clientWidth) map.invalidateSize({ pan: false });
}).observe($('map'));

const expandedMap = $('expanded-map');
const mapPanel = $('map-panel');

function resizeMap() {
  if ($('map').clientWidth) map.invalidateSize({ animate: false });
}

$('expand-map').addEventListener('click', () => {
  mapOptions.open = false;
  expandedMap.returnValue = '';
  expandedMap.append(mapPanel);
  expandedMap.showModal();
  resizeMap();
  $('close-expanded-map').focus();
});
$('close-expanded-map').addEventListener('click', () => expandedMap.close('back'));
$('finish-marking').addEventListener('click', () => {
  const error = locationError();
  if (error) {
    message($('location-status'), error, true);
    return;
  }
  expandedMap.close('done');
});
expandedMap.addEventListener('close', () => {
  $('map-home').after(mapPanel);
  resizeMap();
  if (expandedMap.returnValue === 'done') setStep('damage', true);
  else mapOptionsToggle.focus({ preventScroll: true });
});

const queuedLayer = L.layerGroup().addTo(map);
const activeLayer = L.layerGroup().addTo(map);
const marker = point => L.circleMarker(point, {
  ...damageStyle, radius: 7, color: damageOutline, fillColor: damageStyle.color, fillOpacity: 1, weight: 2,
});

function drawDamageLine(points, layer) {
  L.polyline(points, { ...damageStyle, color: damageOutline, weight: 8 }).addTo(layer);
  L.polyline(points, damageStyle).addTo(layer);
}

function requestDitchData() {
  ditchDataRequest ??= (async () => {
    const params = new URLSearchParams({
      f: 'geojson', where: '1=1', outFields: 'OBJECTID_1,Name,FEAT_NAME,GNIS_Name', outSR: '4326',
      returnM: 'false', returnZ: 'false',
    });
    const response = await fetch(COUNTY + '/Operational_Layers/Hydrology/MapServer/5/query?' + params, {
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json();
    if (!response.ok || !Array.isArray(data.features)) throw new Error('Ditches unavailable');
    return data;
  })().catch(error => {
    ditchDataRequest = undefined;
    throw error;
  });
  return ditchDataRequest;
}

async function addMappedDitches(targetMap, pane) {
  const data = await requestDitchData();
  const options = { pane, interactive: false };
  L.geoJSON(data, { ...options, style: { color: '#fff8fc', weight: 5, opacity: .85 } }).addTo(targetMap);
  L.geoJSON(data, {
    ...options,
    style: { color: mapColors.getPropertyValue('--ditch').trim(), weight: 2.8, opacity: 1 },
    attribution: 'La Plata County GIS, Irrigation Ditches',
  }).addTo(targetMap);
  return data;
}

async function loadDitches() {
  try {
    const data = await addMappedDitches(map, 'ditches');
    ditchPaths = data.features.flatMap(({ geometry, properties }) => {
      if (!geometry) return [];
      const paths = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
      const ditch = {
        id: properties.OBJECTID_1,
        name: [properties.Name, properties.FEAT_NAME, properties.GNIS_Name]
          .find(value => value?.trim() && !/^(unnamed|unknown|null|ditch)$/i.test(value.trim()))?.trim() || '',
      };
      return paths.filter(path => path.length > 1).map(path => {
        const points = path.map(([lng, lat]) => L.latLng(lat, lng));
        return { path: points, ditch, anchor: points[Math.floor(points.length / 2)], length: lengthFeet(points) };
      });
    });
    ditchPaths.sort((a, b) => b.length - a.length);
    renderDitchLabels();
  } catch {
    message($('layer-status'), 'Mapped ditches are temporarily unavailable. You can still mark damage on the map.');
  }
}
loadDitches();

function renderDitchLabels() {
  ditchLabels.clearLayers();
  if (map.getZoom() < 12 || !$('map').clientWidth) return;
  const bounds = map.getBounds().pad(-.04);
  const names = new Set();
  const occupied = [];
  for (const { ditch, path, anchor } of ditchPaths) {
    const key = ditch.name.toLowerCase();
    if (!key || names.has(key)) continue;
    const labelPoint = bounds.contains(anchor) ? anchor : path.find(point => bounds.contains(point));
    if (!labelPoint) continue;
    const point = map.latLngToContainerPoint(labelPoint);
    const halfWidth = Math.min(175, ditch.name.length * 3.4 + 8);
    if (occupied.some(label => Math.abs(label.y - point.y) < 21 && Math.abs(label.x - point.x) < label.halfWidth + halfWidth)) continue;
    occupied.push({ x: point.x, y: point.y, halfWidth });
    names.add(key);
    const text = document.createElement('span');
    text.textContent = ditch.name;
    L.tooltip({ permanent: true, direction: 'center', className: 'ditch-name-label', opacity: 1 })
      .setLatLng(labelPoint).setContent(text).addTo(ditchLabels);
  }
}
map.on('moveend', renderDitchLabels);

async function findAddresses(term, signal) {
  const params = new URLSearchParams({
    f: 'json', SingleLine: term, outSR: '4326', forStorage: 'false', maxLocations: '5',
    searchExtent: countyBounds.pad(.08).toBBoxString(), sourceCountry: 'USA',
  });
  const response = await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' + params, { signal });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.candidates)) throw new Error('Address search unavailable');
  return data.candidates.filter(({ address, location }) =>
    address && Number.isFinite(location?.y) && Number.isFinite(location?.x));
}

let searchRequest;
function closeSearch() {
  searchRequest?.abort();
  $('search-response').hidden = true;
}
$('search-input').addEventListener('input', closeSearch);
$('map-search').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('search-response').hidden) {
    event.preventDefault();
    closeSearch();
    $('search-input').focus();
  }
});
document.addEventListener('click', event => {
  if (!$('map-search').contains(event.target)) closeSearch();
});
$('map-search').addEventListener('submit', async event => {
  event.preventDefault();
  closeSearch();
  const term = $('search-input').value.trim();
  const holder = $('search-response');
  const status = $('search-status');
  const list = $('search-results');
  holder.hidden = false;
  list.hidden = true;
  list.replaceChildren();
  message(status, term.length < 2 ? 'Enter a street address.' : 'Searching…');
  if (term.length < 2) return;
  searchRequest = new AbortController();
  const request = searchRequest;
  try {
    const matches = await findAddresses(term, AbortSignal.any([request.signal, AbortSignal.timeout(9000)]));
    if (request.signal.aborted) return;
    message(status, matches.length ? '' : 'No addresses found. Try adding the city or ZIP code.');
    list.hidden = !matches.length;
    for (const { address, location } of matches) {
      const item = document.createElement('li');
      item.append(createButton(address, () => {
        $('search-input').value = address;
        map.setView([location.y, location.x], 17);
        closeSearch();
        $('map').focus({ preventScroll: true });
      }));
      list.append(item);
    }
  } catch {
    if (!request.signal.aborted) message(status, 'Address search is unavailable. You can still use the map.', true);
  }
});

function nearestDitch(location) {
  const click = map.latLngToLayerPoint(location);
  const bounds = map.getBounds().pad(.1);
  let nearest = null;
  let distance = 19;
  for (const { path, ditch } of ditchPaths) {
    for (let i = 1; i < path.length; i++) {
      if (!bounds.intersects(L.latLngBounds(path[i - 1], path[i]))) continue;
      const a = map.latLngToLayerPoint(path[i - 1]);
      const b = map.latLngToLayerPoint(path[i]);
      const next = L.LineUtil.pointToSegmentDistance(click, a, b);
      if (next >= distance) continue;
      distance = next;
      nearest = ditch;
    }
  }
  return nearest;
}

function place(location) {
  if (sending || uncertain || preparingPhotos) return;
  if (map.getZoom() < 13) {
    map.setView(location, 14);
    message($('location-status'), 'Zoomed in. Select the damage location to place it.');
    return;
  }
  if (!countyBounds.pad(.08).contains(location)) {
    message($('location-status'), 'Select a location in the La Plata County map area.', true);
    return;
  }
  if (mode === 'line' && points.length >= 50) {
    message($('location-status'), 'This stretch has 50 points. Add another report to mark more damage.', true);
    return;
  }
  const point = [location.lat, location.lng];
  if (mode === 'point' || points.length === 0) {
    const nextDitch = nearestDitch(location);
    if (!$('ditch-name').value.trim() || $('ditch-name').value === draftDitch?.name) {
      $('ditch-name').value = nextDitch?.name || '';
    }
    draftDitch = nextDitch;
  }
  if (mode === 'point') points = [point];
  else if (!points.length || map.distance(points.at(-1), point) >= 0.3) points.push(point);
  renderDrawing();
}

map.on('click', event => place(event.latlng));
$('map-center').addEventListener('click', () => place(map.getCenter()));
const centerMark = L.circleMarker(map.getCenter(), {
  radius: 5, color: mapColors.getPropertyValue('--field-dark').trim(), weight: 2, fillColor: 'white', fillOpacity: 1, interactive: false,
});
$('map-center').addEventListener('focus', () => centerMark.setLatLng(map.getCenter()).addTo(map));
$('map-center').addEventListener('blur', () => centerMark.remove());
map.on('move', () => centerMark.setLatLng(map.getCenter()));
$('map').classList.add('drawing');

function lengthFeet(path) {
  let meters = 0;
  for (let index = 1; index < path.length; index++) meters += map.distance(path[index - 1], path[index]);
  return Math.round(meters / 0.3048);
}

function renderDrawing() {
  activeLayer.clearLayers();
  $('draw-actions').hidden = points.length === 0;
  $('undo').hidden = mode !== 'line';
  $('map-instruction').textContent = mode === 'point'
    ? 'Zoom in, then tap or click the damaged spot.'
    : 'Tap or click the start, each bend, and the end of the damaged stretch.';
  if (!points.length) {
    message($('location-status'));
    return;
  }
  if (points.length > 1) drawDamageLine(points, activeLayer);
  for (const point of points) marker(point).addTo(activeLayer);
  const [lat, lng] = points[0];
  const label = mode === 'point' ? lat.toFixed(5) + ', ' + lng.toFixed(5) :
    points.length === 1 ? 'Start marked. Select the end or next bend.' : 'Estimated length ' + lengthFeet(points).toLocaleString() + ' ft';
  message($('location-status'), label + (draftDitch?.name ? ' · ' + draftDitch.name : ''));
}

function clearLocation() {
  points = [];
  if ($('ditch-name').value === draftDitch?.name) $('ditch-name').value = '';
  draftDitch = null;
  renderDrawing();
}
for (const button of document.querySelectorAll('[data-mode]')) {
  button.addEventListener('click', () => {
    if (sending || uncertain || preparingPhotos) return;
    if (mode !== button.dataset.mode) {
      mode = button.dataset.mode;
      clearLocation();
    }
    setStep('map', true);
  });
}
$('undo').addEventListener('click', () => {
  points.pop();
  if (!points.length) clearLocation();
  else renderDrawing();
});
$('clear').addEventListener('click', clearLocation);

function createButton(label, action, accessibleLabel = label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'subtle';
  button.textContent = label;
  button.setAttribute('aria-label', accessibleLabel);
  button.addEventListener('click', action);
  return button;
}

function renderPhotos() {
  const list = $('photo-list');
  list.replaceChildren();
  list.hidden = photos.length === 0;
  for (const photo of photos) {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = photo.name;
    item.append(name, createButton('×', () => {
      photos = photos.filter(value => value !== photo);
      renderPhotos();
    }, 'Remove photo ' + photo.name));
    list.append(item);
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Unsupported image'));
    };
    image.src = url;
  });
}

async function preparePhoto(file) {
  if (file.size > 25 * 1024 * 1024 || !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new Error('Unsupported photo');
  }
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  for (const size of [1600, 1200, 900, 640]) {
    const ratio = Math.min(1, size / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', .78).split(',')[1];
    if (data && data.length < 620000) {
      const id = globalId();
      return { id, name: file.name, uploadName: 'photo-' + id.slice(1, 9).toLowerCase() + '.jpg', data };
    }
  }
  throw new Error('Photo is too large');
}

$('photos').addEventListener('change', async event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  if (!files.length) return;
  if (files.length + photos.length > maxReportPhotos) {
    message($('form-message'), 'Choose up to 3 photos for this report.', true);
    return;
  }
  preparingPhotos = true;
  updateControls();
  message($('form-message'), 'Preparing photos…');
  const failures = [];
  try {
    for (const file of files) {
      try {
        photos.push(await preparePhoto(file));
      } catch {
        failures.push(file.name);
      }
    }
    renderPhotos();
    message($('form-message'), failures.length ? 'Could not open ' + failures.join(', ') +
      '. Try a JPEG or PNG under 25 MB.' : '', Boolean(failures.length));
  } finally {
    preparingPhotos = false;
    updateControls();
  }
});

function resetForm() {
  editing = null;
  prefilledContact = null;
  mode = null;
  points = [];
  draftDitch = null;
  photos = [];
  $('damage-form').reset();
  for (const field of ['notes', 'contact_name', 'contact_phone']) $(field).setCustomValidity('');
  $('add-report').textContent = 'Save this location';
  $('cancel-edit').hidden = true;
  renderDrawing();
  renderPhotos();
}

$('cancel-edit').addEventListener('click', () => {
  resetForm();
  message($('form-message'));
  renderQueue();
  setStep('review', true);
});

function locationError() {
  if (mode === 'point') return points.length ? '' : 'Mark the damage location on the map.';
  return points.length < 2 || lengthFeet(points) < 1 ? 'Mark at least two distinct points for the damaged stretch.' : '';
}

$('damage-form').addEventListener('submit', event => {
  event.preventDefault();
  if (sending || uncertain || preparingPhotos) return;
  const error = locationError();
  if (error) {
    setStep('map', true);
    message($('location-status'), error, true);
    return;
  }
  if (!validateReportFields()) return;
  if (!editing && queue.length >= maxReports) {
    message($('form-message'), 'Send the current batch before adding more than 10 reports.', true);
    return;
  }
  const photoCount = queue.reduce((sum, report) => sum + (report.id === editing ? 0 : report.photos.length), 0);
  if (photoCount + photos.length > maxBatchPhotos) {
    message($('form-message'), 'A batch can include up to 8 photos. Remove a photo or send the current batch first.', true);
    return;
  }
  const report = {
    id: editing || globalId(), mode, points, ditchId: draftDitch?.id ?? null, ditch: draftDitch,
    feet: mode === 'line' ? lengthFeet(points) : null, name: $('ditch-name').value.trim(),
    type: $('damage-type').value, notes: $('notes').value.trim(), photos,
    details: Object.fromEntries(optionalFields.map(field => [field, $(field).value.trim()])),
  };
  const index = queue.findIndex(value => value.id === editing);
  if (index < 0) queue.push(report);
  else queue[index] = report;
  lastSavedReportId = report.id;
  resetForm();
  message($('form-message'));
  message($('send-message'));
  reportPage = index < 0 ? queue.length - 1 : index;
  renderQueue();
  setStep('review', true);
});

function validateReportFields(step) {
  const notes = $('notes');
  const name = $('contact_name');
  const phone = $('contact_phone');
  const email = $('contact_email');
  notes.setCustomValidity(notes.value.trim() ? '' : 'Describe the damage.');
  name.setCustomValidity(name.value.trim() ? '' : 'Enter your name.');
  phone.setCustomValidity(phone.value.trim()
    ? (phone.value.replace(/\D/g, '').length >= 7 ? '' : 'Enter a phone number with at least 7 digits.')
    : (email.value.trim() ? '' : 'Enter a phone number or email address.'));
  const group = step ? document.querySelector('.form-group[data-form-step="' + step + '"]') : $('damage-form');
  const invalid = [...group.querySelectorAll('input, select, textarea')].find(field => !field.validity.valid);
  if (!invalid) return true;
  setStep(invalid.closest('[data-form-step]').dataset.formStep);
  message($('form-message'), invalid.validationMessage, true);
  invalid.reportValidity();
  return false;
}
for (const field of ['notes', 'contact_name']) {
  $(field).addEventListener('input', () => $(field).setCustomValidity(''));
}
for (const field of ['contact_phone', 'contact_email']) {
  $(field).addEventListener('input', () => $('contact_phone').setCustomValidity(''));
}

function editReport(report) {
  if (hasDraft()) {
    message($('form-message'), 'Add or clear the current damage details before editing another report.', true);
    setStep('damage', true);
    return;
  }
  editing = report.id;
  mode = report.mode;
  points = [...report.points];
  photos = [...report.photos];
  draftDitch = report.ditch;
  $('ditch-name').value = report.name;
  $('damage-type').value = report.type;
  $('notes').value = report.notes;
  for (const field of optionalFields) $(field).value = report.details[field];
  $('add-report').textContent = 'Save changes';
  $('cancel-edit').hidden = false;
  setStep('map', true);
  map.fitBounds(L.latLngBounds(points), { maxZoom: 17, padding: [36, 36] });
  renderDrawing();
  renderPhotos();
  renderQueue();

}

function hasDraft() {
  return Boolean(editing || points.length || photos.length || $('ditch-name').value ||
    $('damage-type').value || $('notes').value ||
    optionalFields.some(field => $(field).value !== (prefilledContact?.[field] ?? '')));
}

function renderQueue() {
  $('queue-count').textContent = queue.length + (queue.length === 1 ? ' report' : ' reports');
  $('empty-queue').hidden = queue.length > 0 || Boolean(latestReceipt);
  $('queue-actions').hidden = queue.length === 0;
  $('review-instructions').hidden = queue.length === 0;
  $('review-saved').hidden = queue.length === 0;
  reportPage = Math.max(0, Math.min(reportPage, queue.length - 1));
  renderProgress();
  $('queue-pagination').hidden = queue.length < 2;
  $('report-page').textContent = (reportPage + 1) + ' of ' + queue.length;
  $('previous-report').disabled = reportPage <= 0;
  $('next-report').disabled = reportPage >= queue.length - 1;
  $('queue').replaceChildren();
  queuedLayer.clearLayers();
  queue.forEach((report, index) => {
    const item = document.createElement('li');
    const details = document.createElement('div');
    const title = document.createElement('strong');
    const summary = document.createElement('p');
    const actions = document.createElement('div');
    const label = 'Report ' + (index + 1);
    title.textContent = label + ' · ' + report.type;
    summary.className = 'help';
    summary.textContent = [
      report.name, report.mode === 'point' ? 'One damaged spot' : report.feet.toLocaleString() + ' ft',
      report.photos.length + (report.photos.length === 1 ? ' photo' : ' photos'),
    ].filter(Boolean).join(' · ');
    details.append(title, summary);
    actions.append(
      createButton('Edit', () => editReport(report), 'Edit ' + label.toLowerCase()),
      createButton('Remove', () => {
        queue.splice(queue.indexOf(report), 1);
        renderQueue();
      }, 'Remove ' + label.toLowerCase()),
    );
    item.append(details, actions);
    item.hidden = index !== reportPage;
    $('queue').append(item);
    if (report.id === editing) return;
    if (report.mode === 'line') drawDamageLine(report.points, queuedLayer);
    marker(report.points[0]).addTo(queuedLayer);
  });
  updateControls();
}

$('previous-report').addEventListener('click', () => {
  reportPage--;
  renderQueue();
});
$('next-report').addEventListener('click', () => {
  reportPage++;
  renderQueue();
});

function updateControls() {
  const locked = sending || uncertain || preparingPhotos;
  $('report-fields').disabled = locked;
  for (const control of document.querySelectorAll('#map-center, #undo, #clear, [data-mode]')) control.disabled = locked;
  $('add-another').disabled = locked || Boolean(editing);
  $('send').disabled = !intakeReady || !queue.length || sending || preparingPhotos;
  $('send-help').textContent = intakeReady ? 'Saved reports stay in this tab until you send them.' :
    'Online submissions are unavailable.';
  $('send').textContent = sending ? 'Sending…' : uncertain ? 'Retry same batch' : 'Send reports';
  for (const button of $('queue').querySelectorAll('button')) button.disabled = locked || Boolean(editing);
}

$('add-another').addEventListener('click', () => setStep('choose', true));
$('review-saved').addEventListener('click', () => {
  if (hasDraft()) {
    setStep('map', true);
    message($('location-status'), 'Finish this location before reviewing your saved reports.', true);
    return;
  }
  setStep('review', true);
});

$('send').addEventListener('click', async () => {
  if (!intakeReady || sending || !queue.length) return;
  if (hasDraft()) {
    message($('form-message'), 'Add or finish editing the current report before sending.', true);
    setStep('contact', true);
    return;
  }
  sending = true;
  latestReceipt = null;
  $('view-submitted-reports').hidden = true;
  updateControls();
  const reference = batchId.slice(1, -1);
  message($('send-message'), 'Sending reports and photos…');
  let confirmed = 0;
  try {
    if (!await checkIntake()) {
      message($('send-message'), 'Online submissions are unavailable. Your reports are still in this tab.', true);
      return;
    }
    await sendReports(queue, config, batchId, reports => {
      confirmed += reports.length;
      for (const report of reports) {
        confirmedLocations.push(report.points);
        queue.splice(queue.indexOf(report), 1);
      }
    });
    uncertain = false;
    const locations = confirmedLocations.splice(0);
    latestReceipt = { reference, bounds: L.latLngBounds(locations.flat()) };
    batchId = globalId();
    message($('send-message'), 'Received ' + locations.length + (locations.length === 1 ? ' report' : ' reports') + '. Reference ' + reference + '.');
    $('view-submitted-reports').hidden = !openPublicReports;
  } catch (error) {
    uncertain ||= Boolean(error.uncertain);
    const received = confirmed ? 'Received ' + confirmed + ' of your reports. ' : '';
    message($('send-message'), received + (uncertain ?
      'Receipt for the remaining reports is unconfirmed. Retry to send only those reports. If it still fails, give county staff this reference: ' + reference + '.' :
      error.message), true);
  } finally {
    sending = false;
    renderQueue();
  }
});

window.addEventListener('beforeunload', event => {
  if (!hasDraft() && !queue.length && !preparingPhotos) return;
  event.preventDefault();
  event.returnValue = '';
});

renderDrawing();
renderQueue();
checkIntake().then(updateControls);
