import { useState } from 'react';
import { api } from '../lib/api.js';

const ERRORS = {
  too_many_reports: 'أرسلت بلاغات كثيرة. حاول بعد قليل.',
  duplicate_report: 'أرسلت بلاغًا لنفس الموقع قبل قليل.',
  validation_failed: 'تحقق من البيانات المدخلة.',
};

export default function ReportForm({ position, onPositionChange, onCancel, onSubmitted }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [intensity, setIntensity] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const useMyLocation = () => {
    if (!navigator.geolocation) return setError('المتصفح لا يدعم تحديد الموقع');
    navigator.geolocation.getCurrentPosition(
      (p) => onPositionChange({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      () => setError('تعذّر تحديد موقعك'),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api('/reports', { method: 'POST', body: { title, description, intensity, ...position }, token: null });
      onSubmitted(r);
    } catch (err) {
      const d = err.body?.details;
      setError(d?.location === 'location must be inside Saudi Arabia'
        ? 'الموقع يجب أن يكون داخل المملكة'
        : ERRORS[err.message] || 'تعذّر إرسال البلاغ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="sheet" onSubmit={submit}>
      <h2>بلاغ سيل جديد</h2>
      <div className="coords">
        <span dir="ltr">{position.latitude.toFixed(5)}, {position.longitude.toFixed(5)}</span>
        <button type="button" className="btn-link" onClick={useMyLocation}>استخدم موقعي</button>
      </div>

      <label>
        العنوان
        <input value={title} onChange={(e) => setTitle(e.target.value)} minLength={3} maxLength={200} required
               placeholder="مثال: جريان قوي في الوادي" />
      </label>

      <label>
        التفاصيل (اختياري)
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} />
      </label>

      <fieldset className="intensity">
        <legend>الشدة</legend>
        {[1, 2, 3, 4, 5].map((n) => (
          <label key={n} className={n === intensity ? 'active' : ''}>
            <input type="radio" name="intensity" value={n} checked={n === intensity} onChange={() => setIntensity(n)} />
            {n}
          </label>
        ))}
      </fieldset>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'جارٍ الإرسال…' : 'إرسال البلاغ'}</button>
        <button type="button" className="btn" onClick={onCancel}>إلغاء</button>
      </div>
    </form>
  );
}
