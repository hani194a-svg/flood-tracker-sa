import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import 'mapbox-gl/dist/mapbox-gl.css';
import { api, auth, socketUrl, ApiError } from './lib/api.js';
import { MAPBOX_TOKEN } from './lib/mapConfig.js';
import MapPreviewModal from './components/MapPreviewModal.jsx';
import { ConfidenceBadge, StatusBadge } from './components/Badges.jsx';

const FILTERS = [
  { value: '', label: 'الكل' },
  { value: 'pending', label: 'قيد المراجعة' },
  { value: 'verified', label: 'معتمد' },
  { value: 'rejected', label: 'مرفوض' },
];

const fmtTime = (iso) => new Date(iso).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' });

export default function AdminDashboard() {
  const [token, setToken] = useState(auth.token);
  const logout = () => { auth.token = null; setToken(null); };
  return token ? <Dashboard token={token} onLogout={logout} /> : <Login onLogin={(t) => { auth.token = t; setToken(t); }} />;
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email, password }, token: null });
      if (user.role !== 'admin') return setError('هذا الحساب لا يملك صلاحية المشرف');
      onLogin(token);
    } catch {
      setError('البريد أو كلمة المرور غير صحيحة');
    }
  };

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <h1>لوحة المشرفين</h1>
        <label>البريد الإلكتروني<input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>كلمة المرور<input type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <p className="error">{error}</p>}
        <button className="btn btn-primary" type="submit">دخول</button>
      </form>
    </div>
  );
}

function Dashboard({ token, onLogout }) {
  const [status, setStatus] = useState('pending');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('confidence');
  const [data, setData] = useState({ total: 0, reports: [] });
  const [clusters, setClusters] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [live, setLive] = useState(false);
  const [error, setError] = useState(null);
  const filtersRef = useRef({ status, search, sort });
  filtersRef.current = { status, search, sort };

  const handleAuthError = useCallback((e) => {
    if (e instanceof ApiError && (e.status === 401 || e.status === 403)) onLogout();
    else setError('تعذّر الاتصال بالخادم');
  }, [onLogout]);

  const load = useCallback(async () => {
    const q = new URLSearchParams({ sort, limit: '200' });
    if (status) q.set('status', status);
    if (search.trim()) q.set('search', search.trim());
    try {
      setData(await api(`/reports?${q}`, { token }));
      setError(null);
    } catch (e) { handleAuthError(e); }
  }, [status, search, sort, token, handleAuthError]);

  const loadClusters = useCallback(async () => {
    try { setClusters(await api('/reports/clusters', { token })); } catch (e) { handleAuthError(e); }
  }, [token, handleAuthError]);

  useEffect(() => {
    const t = setTimeout(load, search ? 300 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [load, search]);

  useEffect(() => { loadClusters(); }, [loadClusters]);

  // Real-time: merge pushes into the current list without refetching
  useEffect(() => {
    const s = io(socketUrl, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => setLive(true));
    s.on('disconnect', () => setLive(false));

    const upsert = (r, isNew) => {
      const f = filtersRef.current;
      const matches = !f.status || r.status === f.status;
      setData((d) => {
        const exists = d.reports.some((x) => x.id === r.id);
        let reports = d.reports;
        if (exists) reports = matches ? reports.map((x) => (x.id === r.id ? r : x)) : reports.filter((x) => x.id !== r.id);
        else if (matches) reports = [{ ...r, _new: isNew }, ...reports];
        if (f.sort === 'confidence') reports = [...reports].sort((a, b) => (b.confidence_score ?? -1) - (a.confidence_score ?? -1));
        return { total: d.total + (reports.length - d.reports.length), reports };
      });
      setSelected((sel) => (sel?.id === r.id ? r : sel));
    };

    s.on('report:new', (r) => { upsert(r, true); loadClusters(); });
    s.on('report:updated', (r) => upsert(r, false));
    s.on('cluster:alert', (c) => {
      setAlerts((a) => [c, ...a.filter((x) => x.cluster_key !== c.cluster_key)].slice(0, 5));
      loadClusters();
    });
    return () => s.close();
  }, [token, loadClusters]);

  const decide = async (id, newStatus) => {
    try {
      const r = await api(`/reports/${id}/status`, { method: 'PATCH', body: { status: newStatus }, token });
      setSelected(r.status === 'rejected' ? null : r);
      load();
    } catch (e) { handleAuthError(e); }
  };

  return (
    <div className="admin">
      <nav className="topbar">
        <h1>لوحة رصد السيول</h1>
        <span className={`live ${live ? 'on' : ''}`}>{live ? 'مباشر' : 'غير متصل'}</span>
        <a href="#/" className="btn-link">الخريطة العامة</a>
        <button className="btn" onClick={onLogout}>خروج</button>
      </nav>

      {!MAPBOX_TOKEN && <div className="banner warn">أضف VITE_MAPBOX_TOKEN لتفعيل معاينة الخريطة.</div>}
      {error && <div className="banner error">{error}</div>}

      {alerts.map((a) => (
        <div key={a.cluster_key} className="banner alert" role="alert">
          <strong>{a.escalated ? 'تصاعد' : 'تنبيه'}:</strong>{' '}
          {a.reporter_count} مُبلِّغين مستقلين {a.valley_name_ar ? `في ${a.valley_name_ar}` : 'في منطقة واحدة'}
          {' '}· أعلى شدة {a.max_intensity}/5
          <button className="btn-icon" onClick={() => setAlerts((x) => x.filter((y) => y !== a))} aria-label="إغلاق">×</button>
        </div>
      ))}

      <main className="admin-main">
        <section className="card">
          <div className="toolbar">
            <div className="tabs" role="tablist">
              {FILTERS.map((f) => (
                <button key={f.value} role="tab" aria-selected={status === f.value}
                        className={status === f.value ? 'active' : ''} onClick={() => setStatus(f.value)}>
                  {f.label}
                </button>
              ))}
            </div>
            <input className="search" type="search" placeholder="بحث بالعنوان أو الوصف أو الوادي…"
                   value={search} onChange={(e) => setSearch(e.target.value)} />
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="confidence">الأعلى ثقة أولًا</option>
              <option value="newest">الأحدث أولًا</option>
            </select>
          </div>

          <p className="muted">{data.total} بلاغ</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>البلاغ</th><th>الوادي</th><th>الشدة</th><th>الثقة</th><th>داعمة</th><th>الحالة</th><th>الوقت</th><th />
                </tr>
              </thead>
              <tbody>
                {data.reports.map((r) => (
                  <tr key={r.id} className={r._new ? 'row-new' : ''}>
                    <td>
                      <strong>{r.title}</strong>
                      {r.description && <div className="muted clamp">{r.description}</div>}
                    </td>
                    <td>{r.valley_name_ar || <span className="muted">خارج الأودية</span>}</td>
                    <td>{r.intensity}</td>
                    <td><ConfidenceBadge score={r.confidence_score} /></td>
                    <td>{r.corroboration_count}</td>
                    <td><StatusBadge status={r.status} auto={r.auto_verified} /></td>
                    <td className="nowrap">{fmtTime(r.created_at)}</td>
                    <td><button className="btn btn-sm" onClick={() => setSelected(r)}>معاينة على الخريطة</button></td>
                  </tr>
                ))}
                {!data.reports.length && (
                  <tr><td colSpan={8} className="empty">لا توجد بلاغات</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="card clusters">
          <h2>تجمعات نشطة</h2>
          <p className="muted">بلاغات متقاربة خلال الساعة الأخيرة</p>
          {clusters.length === 0 && <p className="empty">لا توجد تجمعات</p>}
          <ul>
            {clusters.map((c) => (
              <li key={c.cluster_key}>
                <strong>{c.valley_name_ar || 'منطقة بلا وادٍ مسجّل'}</strong>
                <span>{c.report_count} بلاغ · {c.reporter_count} مُبلِّغ · شدة {c.max_intensity}</span>
                <span className="muted">متوسط الثقة {c.avg_confidence ?? '—'}</span>
              </li>
            ))}
          </ul>
        </aside>
      </main>

      {selected && MAPBOX_TOKEN && (
        <MapPreviewModal report={selected} onClose={() => setSelected(null)} onDecide={decide} />
      )}
    </div>
  );
}
