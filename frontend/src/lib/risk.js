// Risk levels shared by the map, alerts and charts.
export const LEVELS = {
  1: { label: 'لا خطر يُذكر', color: '#94a3b8' },
  2: { label: 'منخفض', color: '#eab308' },
  3: { label: 'متوسط', color: '#f97316' },
  4: { label: 'مرتفع', color: '#dc2626' },
  5: { label: 'شديد', color: '#7e22ce' },
};

/** Level of a reach at a given hour index from a sparse [[h, level, peak], …] series. */
export function levelAt(series, hour) {
  if (!series) return 1;
  let best = 1;
  for (const [h, lvl] of series) if (h === hour && lvl > best) best = lvl;
  return best;
}

export const maxLevel = (series) => (series ? Math.max(1, ...series.map((s) => s[1])) : 1);

export const fmtHour = (iso) =>
  new Date(iso).toLocaleString('ar-SA', { weekday: 'short', hour: 'numeric', day: 'numeric', month: 'short' });

export const runTitle = (run) =>
  run.kind === 'forecast' ? 'التوقعات الحالية' : run.label || (run.kind === 'archive' ? 'حدث سابق' : 'سيناريو');
