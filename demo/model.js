// ═══ MODEL (port of analysis/hydrology.py — keep in sync) ═══
const PEAK_M3S = [5, 25, 100, 300];
const RUNOFF_MM = [2, 10, 25, 50];
const EXPOSED_BUILT_KM2 = 0.05;
const AMC_DRY_MM = 12.7, AMC_WET_MM = 28.0;
// numpy.round = round half to even
function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
function adjustCn(cn, ant) {
  let c = cn;
  if (ant < AMC_DRY_MM) c = cn / (2.281 - 0.01281 * cn);
  else if (ant > AMC_WET_MM) c = cn / (0.427 + 0.00573 * cn);
  return Math.min(99, Math.max(30, c));
}
function scsRunoff(p, cn) {
  const s = 25400 / cn - 254, ia = 0.2 * s;
  return p > ia ? (p - ia) ** 2 / (p + 0.8 * s) : 0;
}
function classify(peak, q, exposed) {
  let lp = 1, lr = 1;
  for (const t of PEAK_M3S) if (peak >= t) lp++;   // = np.searchsorted(side="right")
  for (const t of RUNOFF_MM) if (q >= t) lr++;
  let l = Math.max(lp, lr);
  if (l >= 2 && exposed) l++;
  return Math.min(5, l);
}
/**
 * rain: Float64Array[] per rain point (hourly mm), nAnt history hours.
 * streams: [{a, tc, cn, b, w:[[pointIdx, km2], …]}]
 * returns per stream: {basin:Float64Array(H), level:Int8Array(H'), peak, runoff, window, off}
 */
function runModel(rain, streams, nAnt) {
  const H = rain[0].length;
  return streams.map((s) => {
    const wsum = s.w.reduce((t, [, a]) => t + a, 0) || 1e-9;
    const basin = new Float64Array(H);
    for (const [p, a] of s.w) { const r = rain[p]; for (let h = 0; h < H; h++) basin[h] += r[h] * a; }
    const csum = new Float64Array(H + 1);
    for (let h = 0; h < H; h++) { basin[h] /= wsum; csum[h + 1] = csum[h] + basin[h]; }
    const d = Math.min(24, Math.max(1, roundHalfEven(s.tc)));
    const tp = d / 2 + 0.6 * s.tc;
    const exposed = s.b >= EXPOSED_BUILT_KM2;
    const n = H - nAnt;
    const level = new Int8Array(n), peak = new Float64Array(n), runoff = new Float64Array(n), win = new Float64Array(n);
    for (let h = nAnt; h < H; h++) {
      const lo = Math.max(0, h + 1 - d);
      const w = csum[h + 1] - csum[lo];
      const ant = csum[lo] - csum[Math.max(0, lo - 120)];
      const q = scsRunoff(w, adjustCn(s.cn, ant));
      const qp = 0.208 * s.a * q / tp;
      const i = h - nAnt;
      win[i] = w; runoff[i] = q; peak[i] = qp; level[i] = classify(qp, q, exposed);
    }
    return { basin, level, peak, runoff, window: win, off: roundHalfEven(tp) };
  });
}
// ═══ END MODEL ═══
