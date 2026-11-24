const publicFields = ['damage_type', 'observed_date', 'batch_id'];
const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const reportZoom = { maxZoom: 16, padding: [32, 32], animate: false };

function normalizeReference(value) {
  return value.trim().replace(/^\{(.*)\}$/, '$1').toUpperCase();
}

function publicLayerUrl(value, intakeUrls) {
  if (typeof value !== 'string') return null;
  const match = /^(https:\/\/services[a-z0-9-]*\.arcgis\.com\/[\w-]+\/arcgis\/rest\/services\/[\w.-]+\/FeatureServer)\/\d+\/?$/i.exec(value);
  if (!match || intakeUrls.includes(match[1].toLowerCase())) return null;
  return value.replace(/\/$/, '');
}

async function requestJson(url, parameters) {
  const response = await fetch(url + '?' + new URLSearchParams(parameters), {
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Public report layer unavailable');
  return data;
}

async function loadPublicFeatures(url, geometryType) {
  const metadata = await requestJson(url, { f: 'json' });
  const allowedFields = [
    ...publicFields, metadata.objectIdField, metadata.globalIdField,
    metadata.geometryField?.name, 'shape__length',
  ].filter(Boolean).map(field => field.toLowerCase());
  const capabilities = (metadata.capabilities || '').toLowerCase().split(',').map(value => value.trim());
  if (metadata.geometryType !== geometryType || metadata.hasAttachments !== false ||
      !capabilities.includes('query') || capabilities.some(value => !['query', 'extract'].includes(value)) ||
      !Array.isArray(metadata.fields) ||
      metadata.fields.some(field => !allowedFields.includes(field.name.toLowerCase())) ||
      !publicFields.every(name => metadata.fields.some(field => field.name === name))) {
    throw new Error('Unexpected public report layer settings');
  }

  const queryUrl = url + '/query';
  const { objectIds } = await requestJson(queryUrl, { f: 'json', where: '1=1', returnIdsOnly: 'true' });
  if (!Array.isArray(objectIds) || !objectIds.every(Number.isSafeInteger)) {
    throw new Error('Unexpected public report IDs');
  }
  const pageSize = Math.min(metadata.maxRecordCount || 150, 150);
  const features = [];
  for (let start = 0; start < objectIds.length; start += pageSize) {
    const page = await requestJson(queryUrl, {
      f: 'geojson',
      objectIds: objectIds.slice(start, start + pageSize).join(','),
      outFields: publicFields.join(','),
      outSR: '4326',
      returnM: 'false',
      returnZ: 'false',
    });
    if (!Array.isArray(page.features) || page.exceededTransferLimit || page.properties?.exceededTransferLimit) {
      throw new Error('Incomplete public report response');
    }
    features.push(...page.features);
  }
  return features;
}

function reportPopup({ properties }, title) {
  const popup = document.createElement('div');
  const heading = document.createElement('strong');
  heading.textContent = title;
  popup.append(heading);
  if (properties?.damage_type) {
    const category = document.createElement('p');
    category.textContent = properties.damage_type;
    popup.append(category);
  }
  if (properties?.observed_date != null) {
    const date = new Date(properties.observed_date);
    if (Number.isFinite(date.getTime())) {
      const observed = document.createElement('p');
      observed.textContent = 'First noticed ' + dateFormat.format(date);
      popup.append(observed);
    }
  }
  return popup;
}

export function setupPublicReports(L, config, {
  countyBounds, topoUrl, topoOptions, addMappedDitches, damageColor, damageOutline, ditchDetailZoom,
}) {
  const intakeUrls = [config.point.url, config.line.url].map(url => url.replace(/\/$/, '').toLowerCase());
  const pointUrl = publicLayerUrl(config.publicReports?.point, intakeUrls);
  const lineUrl = publicLayerUrl(config.publicReports?.line, intakeUrls);
  if (!pointUrl || !lineUrl) {
    document.getElementById('reported-damage-status').textContent = 'The public damage map is unavailable.';
    return;
  }

  const mapElement = document.getElementById('reported-damage-map');
  const status = document.getElementById('reported-damage-status');
  const refreshButton = document.getElementById('refresh-public-map');
  const ditchStatus = document.getElementById('reported-ditch-status');
  const search = document.getElementById('report-reference-search');
  const referenceInput = document.getElementById('report-reference');
  const findButton = document.getElementById('find-report-reference');
  const searchStatus = document.getElementById('report-reference-status');
  let map;
  let reports;
  let highlights;
  let damageLabels;
  let labelLayers = [];
  let ditchLayerRequest;
  let publicFeatures = [];
  let loading = false;
  let submission = null;

  function updateSearchStatus(text) {
    searchStatus.textContent = text;
    searchStatus.hidden = !text;
  }

  function showDitches() {
    ditchLayerRequest ??= addMappedDitches(map, 'mapped-ditches').then(() => {
      ditchStatus.hidden = true;
    }).catch(() => {
      ditchLayerRequest = undefined;
      ditchStatus.textContent = 'Mapped ditches are temporarily unavailable.';
      ditchStatus.hidden = false;
    });
  }

  function renderDamageLabels() {
    damageLabels.clearLayers();
    if (!mapElement.clientWidth || map.getZoom() < ditchDetailZoom) return;
    const bounds = map.getBounds().pad(-.035);
    const occupied = [];
    for (const layer of labelLayers) {
      const title = layer.feature.properties?.damage_type?.trim();
      if (!title) continue;
      const center = layer.getLatLng?.() ?? layer.getCenter();
      const location = bounds.contains(center) ? center :
        layer.getLatLngs?.().flat().find(point => bounds.contains(point));
      if (!location) continue;
      const { x, y } = map.latLngToContainerPoint(location);
      const halfWidth = title.length * 3.5 + 9;
      if (occupied.some(label => Math.abs(label.y - y) < 22 && Math.abs(label.x - x) < label.halfWidth + halfWidth)) continue;
      occupied.push({ x, y, halfWidth });
      const text = document.createElement('span');
      text.textContent = title;
      L.tooltip({ permanent: true, direction: 'top', offset: [0, -8], className: 'damage-type-label', opacity: 1 })
        .setLatLng(location).setContent(text).addTo(damageLabels);
    }
  }

  function highlightReference(reference, submittedBounds) {
    highlights.clearLayers();
    if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(reference)) {
      updateSearchStatus('Enter the full reference number from your submission confirmation.');
      return;
    }
    const matches = publicFeatures.filter(({ geometry, properties }) =>
      geometry && normalizeReference(properties?.batch_id || '') === reference);
    if (!matches.length) {
      updateSearchStatus(submittedBounds ? 'Your submitted locations may take time to appear on the public map.' :
        'No public reports match that reference number.');
      return;
    }
    const selected = L.geoJSON(matches, {
      interactive: false,
      style: { color: '#006597', weight: 8, opacity: .75 },
      pointToLayer: (feature, location) => L.circleMarker(location, {
        radius: 10, color: '#006597', weight: 3, fill: false, interactive: false,
      }),
    });
    highlights.addLayer(selected);
    map.closePopup();
    if (!submittedBounds) {
      map.fitBounds(selected.getBounds(), reportZoom);
      mapElement.scrollIntoView({ block: 'nearest' });
    }
    updateSearchStatus(matches.length === 1 ? '1 matching report highlighted.' : matches.length + ' matching reports highlighted.');
  }

  search.addEventListener('submit', event => {
    event.preventDefault();
    if (findButton.disabled) return;
    submission = null;
    highlightReference(normalizeReference(referenceInput.value));
  });

  referenceInput.addEventListener('input', () => {
    highlights?.clearLayers();
    updateSearchStatus('');
  });

  async function openMap(receipt = null, resetView = true) {
    submission = receipt;
    if (!map) {
      map = L.map('reported-damage-map', { maxZoom: 17, scrollWheelZoom: false });
      L.tileLayer(topoUrl, topoOptions).addTo(map);
      map.fitBounds(receipt?.bounds ?? countyBounds, reportZoom);
      map.createPane('mapped-ditches').style.zIndex = 390;
      reports = L.layerGroup().addTo(map);
      highlights = L.layerGroup().addTo(map);
      damageLabels = L.layerGroup().addTo(map);
      map.on('moveend resize', renderDamageLabels);
      new ResizeObserver(() => {
        if (mapElement.clientWidth) map.invalidateSize({ pan: false });
      }).observe(mapElement);
    } else {
      map.invalidateSize();
      if (resetView) map.fitBounds(receipt?.bounds ?? countyBounds, reportZoom);
    }
    showDitches();
    if (resetView) referenceInput.value = receipt?.reference ?? '';
    updateSearchStatus('');
    if (loading) return;
    loading = true;
    refreshButton.disabled = true;
    reports.clearLayers();
    highlights.clearLayers();
    labelLayers = [];
    damageLabels.clearLayers();
    publicFeatures = [];
    referenceInput.disabled = true;
    findButton.disabled = true;
    status.textContent = 'Loading reports…';
    try {
      const [points, lines] = await Promise.all([
        loadPublicFeatures(pointUrl, 'esriGeometryPoint'),
        loadPublicFeatures(lineUrl, 'esriGeometryPolyline'),
      ]);
      const stretchOutline = L.geoJSON(lines, {
        interactive: false, style: { color: damageOutline, weight: 7 },
      });
      const stretches = L.geoJSON(lines, {
        style: { color: damageColor, weight: 4 },
        onEachFeature: (feature, layer) => layer.bindPopup(() => reportPopup(feature, 'Damaged stretch')),
      });
      const spots = L.geoJSON(points, {
        pointToLayer: (feature, location) => L.circleMarker(location, {
          radius: 7, color: damageOutline, weight: 2, fillColor: damageColor, fillOpacity: 1,
        }),
        onEachFeature: (feature, layer) => layer.bindPopup(() => reportPopup(feature, 'Damage spot')),
      });
      reports.addLayer(stretchOutline).addLayer(stretches).addLayer(spots);
      labelLayers = [...spots.getLayers(), ...stretches.getLayers()];
      renderDamageLabels();
      publicFeatures = [...points, ...lines];
      referenceInput.disabled = !publicFeatures.length;
      findButton.disabled = !publicFeatures.length;
      status.textContent = points.length || lines.length ?
        points.length + (points.length === 1 ? ' damage spot' : ' damage spots') + ' · ' +
        lines.length + (lines.length === 1 ? ' damaged stretch' : ' damaged stretches') :
        'No reports are available for public display.';
      if (mapElement.clientWidth && referenceInput.value) highlightReference(normalizeReference(referenceInput.value), submission?.bounds);
    } catch {
      status.textContent = 'Reports are temporarily unavailable. Select Refresh to try again.';
    } finally {
      loading = false;
      refreshButton.disabled = false;
    }
  }

  document.getElementById('public-county-view').addEventListener('click', () => map?.fitBounds(countyBounds, reportZoom));
  refreshButton.addEventListener('click', () => openMap(submission, false));
  return openMap;
}
