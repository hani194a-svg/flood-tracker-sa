import { activeClusters, getVerificationConfig } from './reports.js';

/**
 * Detects clusters that have crossed the alert threshold and emits each one once
 * (and again only when it grows). Keeps state in memory — fine for a single API
 * instance; move to Redis / a DB table when scaling horizontally.
 */
export function createClusterAlerter(emit) {
  // cluster_key → reporter_count at last alert
  const alerted = new Map();

  return async function checkClusters() {
    const cfg = await getVerificationConfig();
    const clusters = await activeClusters();
    const liveKeys = new Set();

    for (const c of clusters) {
      liveKeys.add(c.cluster_key);
      if (c.reporter_count < cfg.cluster_alert_min_reports) continue;
      const prev = alerted.get(c.cluster_key) ?? 0;
      if (c.reporter_count > prev) {
        alerted.set(c.cluster_key, c.reporter_count);
        emit({ ...c, escalated: prev > 0 });
      }
    }
    // forget clusters that have expired out of the time window
    for (const key of alerted.keys()) if (!liveKeys.has(key)) alerted.delete(key);
    return clusters;
  };
}
