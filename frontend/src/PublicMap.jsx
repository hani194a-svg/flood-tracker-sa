import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, Marker, NavigationControl, Popup } from 'react-map-gl/mapbox';
import { io } from 'socket.io-client';
import 'mapbox-gl/dist/mapbox-gl.css';
import ValleyLayers from './components/ValleyLayers.jsx';
import ReportForm from './components/ReportForm.jsx';
import { api, socketUrl } from './lib/api.js';
import { MAPBOX_TOKEN, MAP_STYLE, KSA_VIEW, KSA_BOUNDS, INTENSITY_COLORS, OSM_ATTRIBUTION } from './lib/mapConfig.js';

const toGeoJSON = (reports) => ({
  type: 'FeatureCollection',
  features: [...reports.values()].map((r) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [r.longitude, r.latitude] },
    properties: { id: r.id, title: r.title, intensity: r.intensity, valley: r.valley_name_ar || '' },
  })),
});

export default function PublicMap() {
  const mapRef = useRef(null);
  const [reports, setReports] = useState(() => new globalThis.Map());
  const [draft, setDraft] = useState(null);      // { latitude, longitude } while composing a report
  const [popup, setPopup] = useState(null);
  const [toast, setToast] = useState(null);
  const [tokenRejected, setTokenRejected] = useState(false);

  const loadViewport = useCallback(async () => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
    try {
      const rows = await api(`/reports/viewport?bbox=${bbox}`);
      setReports(new globalThis.Map(rows.map((r) => [r.id, r])));
    } catch (e) {
      console.warn('viewport load failed', e);
    }
  }, []);

  // Live updates: newly verified reports appear without refresh
  useEffect(() => {
    const s = io(socketUrl, { transports: ['websocket'] });
    s.on('report:verified', (r) => setReports((m) => new globalThis.Map(m).set(r.id, r)));
    s.on('report:removed', ({ id }) => setReports((m) => {
      if (!m.has(id)) return m;
      const n = new globalThis.Map(m); n.delete(id); return n;
    }));
    return () => s.close();
  }, []);

  const data = useMemo(() => toGeoJSON(reports), [reports]);

  const onClick = (e) => {
    const f = e.features?.[0];
    if (f) {
      setPopup({ ...f.properties, longitude: f.geometry.coordinates[0], latitude: f.geometry.coordinates[1] });
      return;
    }
    setPopup(null);
    setDraft({ latitude: e.lngLat.lat, longitude: e.lngLat.lng });
  };

  const onSubmitted = (r) => {
    setDraft(null);
    setToast(r.status === 'verified'
      ? 'تم التحقق من بلاغك تلقائيًا وظهر على الخريطة. شكرًا لك!'
      : 'تم استلام بلاغك وسيُراجع قريبًا. شكرًا لك!');
    if (r.status === 'verified') setReports((m) => new globalThis.Map(m).set(r.id, r));
    setTimeout(() => setToast(null), 6000);
  };

  if (!MAPBOX_TOKEN || tokenRejected) return <MissingToken invalid={tokenRejected} />;

  return (
    <div className="public-map">
      <header className="map-header">
        <h1>رصد السيول</h1>
        <p>اضغط على الخريطة في موقع السيل لإرسال بلاغ</p>
        <div className="legend">
          {INTENSITY_COLORS.map((c, i) => (
            <span key={c}><i style={{ background: c }} />{i + 1}</span>
          ))}
          <small>شدة السيل</small>
        </div>
      </header>

      <Map
        ref={mapRef}
        mapboxAccessToken={MAPBOX_TOKEN}
        initialViewState={KSA_VIEW}
        maxBounds={[[KSA_BOUNDS[0][0] - 5, KSA_BOUNDS[0][1] - 5], [KSA_BOUNDS[1][0] + 5, KSA_BOUNDS[1][1] + 5]]}
        mapStyle={MAP_STYLE}
        style={{ position: 'absolute', inset: 0 }}
        interactiveLayerIds={['reports-circles']}
        onLoad={loadViewport}
        onMoveEnd={loadViewport}
        onClick={onClick}
        cursor={draft ? 'crosshair' : undefined}
        customAttribution={OSM_ATTRIBUTION}
        onError={(e) => {
          // Mapbox answers 401 for a missing/invalid/URL-restricted token
          if (e.error?.status === 401) setTokenRejected(true);
          else console.error(e.error);
        }}
      >
        <NavigationControl position="top-left" />
        <ValleyLayers />

        <Source id="reports" type="geojson" data={data}>
          <Layer
            id="reports-heat"
            type="heatmap"
            maxzoom={11}
            paint={{
              'heatmap-weight': ['interpolate', ['linear'], ['get', 'intensity'], 1, 0.2, 5, 1],
              'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 4, 12, 11, 30],
              'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 11, 0],
            }}
          />
          <Layer
            id="reports-circles"
            type="circle"
            minzoom={8}
            paint={{
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 10],
              'circle-color': ['match', ['get', 'intensity'],
                1, INTENSITY_COLORS[0], 2, INTENSITY_COLORS[1], 3, INTENSITY_COLORS[2],
                4, INTENSITY_COLORS[3], INTENSITY_COLORS[4]],
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 2,
            }}
          />
        </Source>

        {popup && (
          <Popup longitude={popup.longitude} latitude={popup.latitude} onClose={() => setPopup(null)} closeOnClick={false}>
            <strong>{popup.title}</strong>
            {popup.valley && <div>{popup.valley}</div>}
            <div>الشدة: {popup.intensity} / 5</div>
          </Popup>
        )}

        {draft && <Marker longitude={draft.longitude} latitude={draft.latitude} color="#dc2626" />}
      </Map>

      {draft && (
        <ReportForm
          position={draft}
          onPositionChange={setDraft}
          onCancel={() => setDraft(null)}
          onSubmitted={onSubmitted}
        />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

export function MissingToken({ invalid = false }) {
  return (
    <div className="missing-token">
      <h2>{invalid ? 'مفتاح Mapbox مرفوض' : 'مفتاح Mapbox غير موجود'}</h2>
      {invalid ? (
        <p>رفضت Mapbox المفتاح. تأكد أنه مفتاح عام يبدأ بـ <code>pk.</code>، وأن نطاق هذا الموقع مسموح في قيود المفتاح (URL restrictions).</p>
      ) : (
        <p>أضف <code>VITE_MAPBOX_TOKEN</code> إلى الملف <code>frontend/.env</code> ثم أعد تشغيل الخادم.</p>
      )}
    </div>
  );
}
