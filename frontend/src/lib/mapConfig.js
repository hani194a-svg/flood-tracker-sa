import mapboxgl from 'mapbox-gl';

export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
export const TILES_URL = import.meta.env.VITE_TILES_URL || 'http://localhost:3000';
export const MAP_STYLE = 'mapbox://styles/mapbox/light-v11';

export const KSA_VIEW = { longitude: 45.0, latitude: 24.0, zoom: 4.6 };
export const KSA_BOUNDS = [[34.4, 16.2], [55.8, 32.3]];

// Correct Arabic shaping for custom labels (valley names)
if (mapboxgl.getRTLTextPluginStatus?.() === 'unavailable') {
  mapboxgl.setRTLTextPlugin(
    'https://api.mapbox.com/mapbox-gl-js/plugins/mapbox-gl-rtl-text/v0.2.3/mapbox-gl-rtl-text.js',
    null,
    true, // lazy-load only when Arabic text is rendered
  );
}

export const INTENSITY_COLORS = ['#3b82f6', '#06b6d4', '#f59e0b', '#f97316', '#dc2626'];
export const intensityColor = (i) => INTENSITY_COLORS[Math.min(Math.max(i, 1), 5) - 1];
