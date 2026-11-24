export const config = {
  // These hosted views accept public reports once their add-only settings are enabled.
  point: {
    url: 'https://services2.arcgis.com/ilLrLpXfElYxSy9y/arcgis/rest/services/Ditch_Damage_Points_view/FeatureServer',
    layerId: 0,
  },
  line: {
    url: 'https://services2.arcgis.com/ilLrLpXfElYxSy9y/arcgis/rest/services/Ditch_damage_stretches_view/FeatureServer',
    layerId: 0,
  },
  // Set both to the public, read-only layer URLs (including their layer IDs).
  publicReports: {
    point: 'https://services2.arcgis.com/ilLrLpXfElYxSy9y/arcgis/rest/services/Ditch_Damage_Points_view_-_MAP/FeatureServer/0',
    line: 'https://services2.arcgis.com/ilLrLpXfElYxSy9y/arcgis/rest/services/Ditch_damage_stretches_view_-_MAP/FeatureServer/0',
  },
};
