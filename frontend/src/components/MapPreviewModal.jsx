import { useEffect } from 'react';
import Map, { Marker, NavigationControl } from 'react-map-gl/mapbox';
import ValleyLayers from './ValleyLayers.jsx';
import { MAPBOX_TOKEN, intensityColor, OSM_ATTRIBUTION } from '../lib/mapConfig.js';
import { ConfidenceBadge, StatusBadge } from './Badges.jsx';

export default function MapPreviewModal({ report, onClose, onDecide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{report.title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="إغلاق">×</button>
        </header>

        <div className="mini-map">
          <Map
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={{ longitude: report.longitude, latitude: report.latitude, zoom: 13 }}
            mapStyle="mapbox://styles/mapbox/satellite-streets-v12"
            style={{ width: '100%', height: '100%' }}
            customAttribution={OSM_ATTRIBUTION}
          >
            <NavigationControl position="top-left" />
            <ValleyLayers />
            <Marker longitude={report.longitude} latitude={report.latitude} anchor="center">
              <div className="pulse-marker" style={{ '--c': intensityColor(report.intensity) }} />
            </Marker>
          </Map>
        </div>

        <dl className="facts">
          <div><dt>الحالة</dt><dd><StatusBadge status={report.status} auto={report.auto_verified} /></dd></div>
          <div><dt>درجة الثقة</dt><dd><ConfidenceBadge score={report.confidence_score} /></dd></div>
          <div><dt>الوادي</dt><dd>{report.valley_name_ar || '—'}</dd></div>
          <div><dt>البعد عن أقرب وادٍ</dt><dd>{report.valley_distance_m != null ? `${Math.round(report.valley_distance_m)} م` : '—'}</dd></div>
          <div><dt>بلاغات داعمة</dt><dd>{report.corroboration_count}</dd></div>
          <div><dt>ثقة المُبلِّغ</dt><dd>{report.reporter_trust != null ? `${Math.round(report.reporter_trust * 100)}%` : 'مجهول'}</dd></div>
          <div><dt>الشدة</dt><dd>{report.intensity} / 5</dd></div>
          <div><dt>الإحداثيات</dt><dd dir="ltr">{report.latitude.toFixed(5)}, {report.longitude.toFixed(5)}</dd></div>
        </dl>
        {report.description && <p className="description">{report.description}</p>}

        <footer>
          <button className="btn btn-success" disabled={report.status === 'verified' && Boolean(report.reviewed_by)}
                  onClick={() => onDecide(report.id, 'verified')}>اعتماد</button>
          <button className="btn btn-danger" disabled={report.status === 'rejected'}
                  onClick={() => onDecide(report.id, 'rejected')}>رفض</button>
        </footer>
      </div>
    </div>
  );
}
