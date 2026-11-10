import { StrictMode, useEffect, useState, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const PublicMap = lazy(() => import('./PublicMap.jsx'));
const AdminDashboard = lazy(() => import('./AdminDashboard.jsx'));

// Minimal hash router: #/ → public map, #/admin → dashboard
function App() {
  const [route, setRoute] = useState(window.location.hash);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash);
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <Suspense fallback={<div className="loading">جارٍ التحميل…</div>}>
      {route.startsWith('#/admin') ? <AdminDashboard /> : <PublicMap />}
    </Suspense>
  );
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
