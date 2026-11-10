const STATUS = {
  pending: { label: 'قيد المراجعة', cls: 'badge-pending' },
  verified: { label: 'معتمد', cls: 'badge-verified' },
  rejected: { label: 'مرفوض', cls: 'badge-rejected' },
};

export function StatusBadge({ status, auto }) {
  const s = STATUS[status] || STATUS.pending;
  return (
    <span className={`badge ${s.cls}`}>
      {s.label}
      {auto && status === 'verified' ? ' · تلقائي' : ''}
    </span>
  );
}

export function ConfidenceBadge({ score }) {
  if (score == null) return <span className="badge">—</span>;
  const level = score >= 80 ? 'high' : score >= 50 ? 'mid' : 'low';
  return (
    <span className={`confidence confidence-${level}`} title="درجة الثقة (0–100)">
      <span className="bar"><span style={{ width: `${score}%` }} /></span>
      {Math.round(score)}
    </span>
  );
}
