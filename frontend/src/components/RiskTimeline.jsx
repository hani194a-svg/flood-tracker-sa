import { LEVELS, fmtHour } from '../lib/risk.js';

/**
 * Hourly basin rain (bars) with the forecast risk band underneath.
 * Data: GET /api/forecast/runs/:run/streams/:id
 */
export default function RiskTimeline({ data, currentTime }) {
  const rain = data.rain.filter((r) => new Date(r.t) >= new Date(data.run.start_time));
  if (!rain.length) return <p className="muted">لا توجد بيانات أمطار لهذه الفترة.</p>;

  const W = 640, H = 170, padL = 34, padR = 8, padT = 10, band = 14, padB = 28;
  const t0 = new Date(rain[0].t).getTime();
  const t1 = Math.max(new Date(rain.at(-1).t).getTime(), ...data.risk.map((r) => new Date(r.t).getTime())) + 3.6e6;
  const x = (t) => padL + ((new Date(t).getTime() - t0) / (t1 - t0)) * (W - padL - padR);
  const maxMm = Math.max(5, ...rain.map((r) => r.mm));
  const chartH = H - padT - padB - band - 6;
  const y = (mm) => padT + chartH - (mm / maxMm) * chartH;
  const barW = Math.max(1, (W - padL - padR) / ((t1 - t0) / 3.6e6) - 1);
  const ticks = [0, maxMm / 2, maxMm].map((v) => Math.round(v * 10) / 10);
  const dayTicks = [];
  for (let t = Math.ceil(t0 / 8.64e7) * 8.64e7; t < t1; t += 8.64e7) dayTicks.push(t);

  return (
    <figure className="timeline">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="الأمطار على الحوض ومستوى الخطر لكل ساعة" dir="ltr">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="grid" />
            <text x={padL - 4} y={y(v) + 3} textAnchor="end" className="tick">{v}</text>
          </g>
        ))}
        {rain.map((r) => r.mm > 0 && (
          <rect key={r.t} x={x(r.t)} y={y(r.mm)} width={barW} height={y(0) - y(r.mm)} className="rain-bar">
            <title>{`${fmtHour(r.t)}: ${r.mm} ملم`}</title>
          </rect>
        ))}
        <rect x={padL} y={H - padB - band} width={W - padL - padR} height={band} fill={LEVELS[1].color} opacity="0.25" />
        {data.risk.map((r) => (
          <rect key={r.t} x={x(r.t)} y={H - padB - band} width={Math.max(barW, 2)} height={band} fill={LEVELS[r.level].color}>
            <title>{`${fmtHour(r.t)}: ${LEVELS[r.level].label} · ذروة ${r.peak_m3s} م³/ث`}</title>
          </rect>
        ))}
        {currentTime && <line x1={x(currentTime)} x2={x(currentTime)} y1={padT} y2={H - padB} className="now-line" />}
        {dayTicks.map((t) => (
          <text key={t} x={x(t)} y={H - 8} textAnchor="middle" className="tick">
            {new Date(t).toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric' })}
          </text>
        ))}
        <text x={padL} y={padT - 1} className="tick">ملم/ساعة</text>
      </svg>
      <figcaption className="muted">الأعمدة: المطر المتوسط على كامل الحوض. الشريط السفلي: مستوى الخطر في وقت الذروة المتوقع.</figcaption>
    </figure>
  );
}
