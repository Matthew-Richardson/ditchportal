export function globalId() {
  return '{' + crypto.randomUUID().toUpperCase() + '}';
}

export function makeEdits(reports, layerId, batchId) {
  return [{
    id: layerId,
    adds: reports.map(report => ({
      attributes: {
        ...Object.fromEntries(Object.entries(report.details).map(([field, value]) => [field, value || null])),
        observed_date: report.details.observed_date ? Date.parse(report.details.observed_date + 'T12:00:00Z') : null,
        acres_affected: report.details.acres_affected === '' ? null : Number(report.details.acres_affected),
        GlobalID: report.id,
        batch_id: batchId,
        damage_type: report.type,
        ditch_name: report.name || null,
        ditch_oid: report.ditchId,
        length_ft: report.mode === 'line' ? report.feet : null,
        damage_notes: report.notes || null,
      },
      geometry: report.mode === 'point'
        ? { x: report.points[0][1], y: report.points[0][0], spatialReference: { wkid: 4326 } }
        : { paths: [report.points.map(([lat, lng]) => [lng, lat])], spatialReference: { wkid: 4326 } },
    })),
    attachments: {
      adds: reports.flatMap(report => report.photos.map(photo => ({
        globalId: photo.id,
        parentGlobalId: report.id,
        name: photo.uploadName,
        contentType: 'image/jpeg',
        data: photo.data,
      }))),
    },
  }];
}

export async function canSubmit(target, geometryType, request = fetch) {
  if (!target || !/^https:\/\/services[a-z0-9-]*\.arcgis\.com\/[\w-]+\/arcgis\/rest\/services\/[\w.-]+\/FeatureServer$/i.test(target.url)
      || !Number.isInteger(target.layerId)) return false;
  const layerUrl = target.url + '/' + target.layerId;
  const options = { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(12000) };
  try {
    const metadataResponse = await request(layerUrl + '?f=json', options);
    const layer = await metadataResponse.json();
    const actions = new Set((layer.capabilities || '').split(',').map(value => value.trim().toLowerCase()));
    if (!metadataResponse.ok || !layer.isView || layer.geometryType !== geometryType ||
        !layer.hasAttachments || !layer.supportsApplyEditsWithGlobalIds ||
        !actions.has('create') || actions.has('update') || actions.has('delete')) return false;

    const countResponse = await request(layerUrl + '/query?f=json&where=1%3D1&returnCountOnly=true', options);
    const countResult = await countResponse.json();
    return !('count' in countResult) && [400, 401, 403, 405, 498, 499].includes(countResult.error?.code);
  } catch {
    return false;
  }
}

export class IntakeError extends Error {
  constructor(message, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}

export async function sendEdits(url, edits, request = fetch) {
  const data = new FormData();
  data.set('f', 'json');
  data.set('useGlobalIds', 'true');
  data.set('rollbackOnFailure', 'true');
  data.set('edits', JSON.stringify(edits));
  let result;
  try {
    const response = await request(url + '/applyEdits', {
      method: 'POST', body: data, credentials: 'omit', signal: AbortSignal.timeout(75000),
    });
    result = await response.json();
    if (response.status >= 500) throw new Error('Server error');
  } catch {
    throw new IntakeError('The connection ended before ArcGIS confirmed receipt.', true);
  }
  if (result?.error) throw new IntakeError('ArcGIS could not accept the reports.');
  if (!Array.isArray(result)) throw new IntakeError('ArcGIS returned an unexpected response.', true);
  for (const edit of edits) {
    const layer = result.find(row => row.id === edit.id);
    const adds = layer?.addResults ?? [];
    const photos = layer?.attachments?.addResults ?? [];
    if ([...adds, ...photos].some(row => row.success === false)) {
      throw new IntakeError('ArcGIS rejected the remaining reports. They are still in this tab.');
    }
    if (adds.length !== edit.adds.length || photos.length !== edit.attachments.adds.length ||
        [...adds, ...photos].some(row => row.success !== true)) {
      throw new IntakeError('ArcGIS did not confirm every report and photo.', true);
    }
  }
}

export async function sendReports(reports, config, batchId, confirm, request = fetch) {
  for (const mode of ['point', 'line']) {
    const matching = reports.filter(report => report.mode === mode);
    if (!matching.length) continue;
    const { url, layerId } = config[mode];
    await sendEdits(url, makeEdits(matching, layerId, batchId), request);
    confirm(matching);
  }
}
