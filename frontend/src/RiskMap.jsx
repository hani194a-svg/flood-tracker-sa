import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Map, { Source, Layer, NavigationControl } from 'react-map-gl/mapbox';
import { io } from 'socket.io-client';
import 'mapbox-gl/dist/mapbox-gl.css';
import { api, socketUrl } from './lib/api.js';
import { MAPBOX_TOKEN, MAP_STYLE, OSM_ATTRIBUTION } from './lib/mapConfig.js';
import { LEVELS, levelAt, fmtHour, runTitle } from './lib/risk.js';
import RiskTimeline from './components/RiskTimeline.jsx';
import { MissingToken } from './PublicMap.jsx';

const API_URL = import.meta.env.VITE_API_URL || '';
const TERRAIN_ATTRIBUTION = `${OSM_ATTRIBUTION} · التضاريس: Copernicus GLO-30 · الغطاء الأرضي: ESA WorldCover · الطقس: Open-Meteo`;

export default function RiskMap() {
  const mapRef = useRef(null);
  const [runs, setRuns] = useState([]);
  const [runId, setRunId] = useState('latest');
  const [levels, setLevels] = useState(null);          // { run, start, hours, levels }
  const [streams, setStreams] = useState(null);
  const [zones, setZones] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [hour, setHour] = useState(0);
  const [selected, setSelected] = useState(null);      // timeline payload
  const [error, setError] = useState(null);
  const [tokenRejected, setTokenRejected] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [regions, setRegions] = useState([]);
  const [region, setRegion] = useState(() => {
    try { return localStorage.getItem('flood_region') || 'riyadh'; } catch { return 'riyadh'; }
  });
  const regionInfo = regions.find((r) => r.slug === region);

  useEffect(() => {
    api('/forecast/regions').then(setRegions).catch(() => setError('تعذّر تحميل المناطق'));
  }, []);

  const chooseRegion = (slug) => {
    setRegion(slug); setRunId('latest'); setSelected(null); setLevels(null); setStreams(null);
    try { localStorage.setItem('flood_region', slug); } catch { /* storage unavailable */ }
  };

  // move the map whenever the region (or its metadata) becomes known
  useEffect(() => {
    const v = regionInfo?.view;
    if (mapReady && v) mapRef.current?.getMap().flyTo({ center: [v[0], v[1]], zoom: v[2], duration: 1000 });
  }, [mapReady, regionInfo?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // static channel geometry (cached by the server with an ETag)
  useEffect(() => {
    fetch(`${API_URL}/api/forecast/regions/${region}/streams.geojson?minUpstream=2`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then(setStreams)
      .catch(() => setError('تعذّر تحميل شبكة الأودية. هل حُمّلت بيانات التضاريس؟ (analysis/load_db.py)'));
  }, [region]);

  const loadRuns = useCallback(async () => {
    try {
      const [live, scen, arch] = await Promise.all([
        api(`/forecast/runs?kind=forecast&limit=1&region=${region}`), api(`/forecast/runs?kind=scenario&limit=10&region=${region}`),
        api(`/forecast/runs?kind=archive&limit=5&region=${region}`),
      ]);
      // keep one run per scenario label (newest)
      const seen = new Set();
      const others = [...scen, ...arch].filter((r) => !seen.has(r.label) && seen.add(r.label));
      setRuns([...live, ...others]);
    } catch { setError('تعذّر الاتصال بالخادم'); }
  }, [region]);

  const loadRun = useCallback(async (id) => {
    try {
      const q = `?region=${region}`;
      const [lv, al, zn] = await Promise.all([
        api(`/forecast/runs/${id}/levels${q}`), api(`/forecast/runs/${id}/alerts${q}`),
        fetch(`${API_URL}/api/forecast/runs/${id}/zones.geojson${q}&minLevel=4`).then((r) => r.json()),
      ]);
      setLevels(lv); setAlerts(al.alerts); setZones(zn); setError(null);
      // start the slider at "now" for live forecasts, at the first risky hour for past events
      const nowH = Math.round((Date.now() - new Date(lv.start).getTime()) / 3.6e6);
      const firstRisk = Math.min(...Object.values(lv.levels).flat().map((s) => s[0]), lv.hours - 1);
      setHour(lv.run.kind === 'forecast' ? Math.max(0, Math.min(nowH, lv.hours - 1)) : Math.max(0, firstRisk));
    } catch (e) {
      setError(e.status === 404 ? `لا توجد توقعات بعد. شغّل analysis/forecast.py --region ${region}` : 'تعذّر تحميل التوقعات');
    }
  }, [region]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadRun(runId); setSelected(null); }, [runId, loadRun]);

  // a new live forecast → refresh if the user is looking at the live run
  useEffect(() => {
    const s = io(socketUrl, { transports: ['websocket'] });
    s.on('forecast:updated', (m) => {
      loadRuns();
      if (m.kind === 'forecast' && runId === 'latest') loadRun('latest');   // loadRun is region-scoped
    });
    return () => s.close();
  }, [runId, loadRun, loadRuns]);

  // paint levels for the selected hour with feature-state (no geometry re-upload)
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !mapReady || !levels || !streams || !map.getSource('streams')) return;
    map.removeFeatureState({ source: 'streams' });
    for (const [id, series] of Object.entries(levels.levels)) {
      const l = levelAt(series, hour);
      if (l > 1) map.setFeatureState({ source: 'streams', id: Number(id) }, { level: l });
    }
  }, [levels, streams, hour, mapReady]);

  const hourTime = levels ? new Date(new Date(levels.start).getTime() + hour * 3.6e6) : null;
  const countsNow = useMemo(() => {
    const c = { 2: 0, 3: 0, 4: 0, 5: 0 };
    if (levels) for (const s of Object.values(levels.levels)) { const l = levelAt(s, hour); if (l > 1) c[l]++; }
    return c;
  }, [levels, hour]);

  const openStream = async (id, lngLat) => {
    try {
      const t = await api(`/forecast/runs/${levels.run.id}/streams/${id}`);   // run id already pins the region
      setSelected(t);
      if (lngLat) mapRef.current?.getMap().flyTo({ center: lngLat, zoom: Math.max(mapRef.current.getMap().getZoom(), 12) });
    } catch { /* ignore */ }
  };

  if (!MAPBOX_TOKEN || tokenRejected) return <MissingToken invalid={tokenRejected} />;

  const lineColor = ['match', ['coalesce', ['feature-state', 'level'], 1],
    2, LEVELS[2].color, 3, LEVELS[3].color, 4, LEVELS[4].color, 5, LEVELS[5].color, '#3b82f6'];

  return (
    <div className="risk-page">
      <aside className="risk-panel">
        <header>
          <h1>توقعات السيول{regionInfo ? ` · ${regionInfo.name_ar}` : ''}</h1>
          <p className="muted">من الطقس المتوقع والتضاريس ونوع الأرض. البلاغات <a href="#/reports">صفحة مستقلة</a>.</p>
        </header>

        <div className="region-tabs" role="tablist" aria-label="المنطقة">
          {regions.map((r) => (
            <button key={r.slug} role="tab" aria-selected={r.slug === region} onClick={() => chooseRegion(r.slug)}>
              {r.name_ar}
              {r.latest?.max_level >= 3 && <i className="dot" style={{ background: LEVELS[r.latest.max_level].color }} />}
            </button>
          ))}
        </div>

        <label className="field">
          الفترة
          <select value={runId} onChange={(e) => setRunId(e.target.value)}>
            {runs.map((r) => (
              <option key={r.id} value={r.kind === 'forecast' ? 'latest' : r.id}>
                {runTitle(r)}{r.kind === 'forecast' ? ` (صدرت ${fmtHour(r.created_at)})` : ''}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="error">{error}</p>}

        {levels && (
          <>
            <div className="slider">
              <div className="slider-head">
                <strong>{fmtHour(hourTime)}</strong>
                <span className="muted">{levels.run.kind === 'forecast' && hourTime > new Date() ? 'متوقع' : ''}</span>
              </div>
              <input type="range" min={0} max={levels.hours - 1} value={hour} onChange={(e) => setHour(Number(e.target.value))}
                     aria-label="الوقت" />
              <div className="level-counts">
                {[5, 4, 3, 2].map((l) => (
                  <span key={l}><i style={{ background: LEVELS[l].color }} />{LEVELS[l].label} <b className="num">{countsNow[l]}</b></span>
                ))}
              </div>
            </div>

            <h2>التنبيهات {alerts.length ? <span className="num">({alerts.length})</span> : null}</h2>
            {!alerts.length && <p className="muted">لا توجد أودية بمستوى خطر مرتفع في هذه الفترة.</p>}
            <ul className="alert-list">
              {alerts.map((a) => (
                <li key={a.stream_id}>
                  <button onClick={() => openStream(a.stream_id, [a.lng, a.lat])}>
                    <span className="lvl" style={{ background: LEVELS[a.max_level].color }}>{LEVELS[a.max_level].label}</span>
                    <strong>{a.valley_name_ar || `مجرى بحوض ${Math.round(a.upstream_km2)} كم²`}</strong>
                    <span className="muted">
                      ذروة <span className="num">{Math.round(a.max_peak_m3s)}</span> م³/ث · {fmtHour(a.time_of_max)}
                      {Number(a.zone_built_km2) > 0.05 ? ' · مناطق عمرانية مهددة' : ''}
                      {a.truncated ? ' · الحوض يتجاوز المنطقة (تقدير أقل)' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {selected && (
          <section className="stream-detail">
            <h2>{selected.stream.valley_name_ar || 'المجرى المحدد'}</h2>
            <dl className="facts">
              <div><dt>مساحة الحوض</dt><dd className="num">{Number(selected.stream.upstream_km2).toFixed(1)} كم²</dd></div>
              <div><dt>زمن وصول المياه</dt><dd className="num">{Number(selected.stream.tc_h).toFixed(1)} ساعة</dd></div>
              <div><dt>رقم المنحنى (الجريان)</dt><dd className="num">{Number(selected.stream.cn_up).toFixed(0)}</dd></div>
              <div><dt>مبانٍ في منطقة الخطر</dt><dd className="num">{(Number(selected.stream.zone_built_km2) * 100).toFixed(0)} هكتار</dd></div>
            </dl>
            <RiskTimeline data={selected} currentTime={hourTime} />
          </section>
        )}

        <details className="method">
          <summary>كيف يُحسب الخطر</summary>
          <ol>
            <li>تُقسَّم المنطقة إلى {streams?.features.length ?? '…'} مجرى من نموذج الارتفاعات (دقة 30 م)، ولكل مجرى حوضه.</li>
            <li>يُحسب المطر المتوقع لكل ساعة على كامل الحوض، خلال نافذة تساوي زمن وصول المياه.</li>
            <li>الجريان السطحي بطريقة SCS حسب نوع الأرض (صخر، رمل، عمران) ورطوبة التربة من أمطار الأيام الخمسة السابقة.</li>
            <li>الذروة المتوقعة بالمتر المكعب في الثانية، ثم مستوى الخطر، ويُرفع درجة إذا كانت في منطقة الخطر مبانٍ.</li>
          </ol>
          <p className="muted">نموذج فرز سريع، لا يحسب السدود وقنوات التصريف التي بُنيت بعد 2011.</p>
        </details>
      </aside>

      <div className="risk-map">
        <Map
          ref={mapRef}
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={{ longitude: 46.70, latitude: 24.68, zoom: 9 }}
          mapStyle={MAP_STYLE}
          style={{ width: '100%', height: '100%' }}
          interactiveLayerIds={['streams-line']}
          customAttribution={TERRAIN_ATTRIBUTION}
          onLoad={() => setMapReady(true)}
          onClick={(e) => { const f = e.features?.[0]; if (f) openStream(f.id); }}
          onError={(e) => { if (e.error?.status === 401) setTokenRejected(true); }}
        >
          <NavigationControl position="top-left" />
          {zones && (
            <Source id="zones" type="geojson" data={zones}>
              <Layer id="zones-fill" type="fill" paint={{ 'fill-color': LEVELS[4].color, 'fill-opacity': 0.22 }} />
            </Source>
          )}
          {streams && (
            <Source id="streams" type="geojson" data={streams}>
              <Layer
                id="streams-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': lineColor,
                  'line-width': ['interpolate', ['linear'], ['get', 'upstream_km2'], 2, 1, 20, 2.5, 100, 4.5, 500, 7],
                  'line-opacity': ['case', ['>', ['coalesce', ['feature-state', 'level'], 1], 1], 1, 0.45],
                }}
              />
            </Source>
          )}
        </Map>
      </div>
    </div>
  );
}

