import { Source, Layer } from 'react-map-gl/mapbox';
import { TILES_URL } from '../lib/mapConfig.js';

// Valley lines + Arabic labels from Martin (PostGIS table public.valleys).
export default function ValleyLayers() {
  return (
    <Source id="valleys" type="vector" url={`${TILES_URL}/valleys`}>
      <Layer
        id="valleys-line-layer"
        type="line"
        source-layer="valleys"
        layout={{ 'line-join': 'round', 'line-cap': 'round' }}
        paint={{
          'line-color': '#0ea5e9',
          'line-opacity': 0.8,
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 10, 3, 15, 7],
        }}
      />
      <Layer
        id="valleys-text-layer"
        type="symbol"
        source-layer="valleys"
        minzoom={10}
        layout={{
          'symbol-placement': 'line',
          'text-field': ['get', 'name_ar'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 10, 12, 15, 16],
          'text-max-angle': 30,
        }}
        paint={{ 'text-color': '#075985', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }}
      />
    </Source>
  );
}
