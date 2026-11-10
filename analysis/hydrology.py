"""Rainfall → runoff → peak discharge → risk level. Pure functions, no I/O.

Method (a screening model in the spirit of flash-flood guidance, not a hydraulic simulation):
  1. Basin rain: area-weighted hourly rain over each reach's whole upstream basin.
  2. Critical window d = time of concentration (1–24 h): rain over the last d hours.
  3. Antecedent moisture: 5-day prior rain shifts the curve number (SCS AMC I/II/III).
  4. Runoff depth Q: SCS curve-number equation, Ia = 0.2 S.
  5. Peak flow: SCS triangular unit hydrograph, qp = 0.208 · A · Q / Tp, Tp = d/2 + 0.6·Tc.
  6. Level 1–5 from the larger of the peak-flow and runoff-depth classes, +1 when the
     reach's flood-prone zone contains built-up land (exposure), capped at 5.
"""
from __future__ import annotations

import numpy as np

# thresholds (lower bounds) for levels 2..5
PEAK_M3S = (5.0, 25.0, 100.0, 300.0)
RUNOFF_MM = (2.0, 10.0, 25.0, 50.0)
EXPOSED_BUILT_KM2 = 0.05        # ≥ 5 ha of buildings/roads inside the HAND zone
AMC_DRY_MM, AMC_WET_MM = 12.7, 28.0   # 5-day antecedent rain (dormant-season SCS values)

LEVELS_AR = {1: "لا خطر يُذكر", 2: "منخفض", 3: "متوسط", 4: "مرتفع", 5: "شديد"}


def adjust_cn(cn: np.ndarray, antecedent_mm: np.ndarray) -> np.ndarray:
    """SCS antecedent moisture condition: dry (I) lowers CN, wet (III) raises it."""
    cn_dry = cn / (2.281 - 0.01281 * cn)
    cn_wet = cn / (0.427 + 0.00573 * cn)
    out = np.where(antecedent_mm < AMC_DRY_MM, cn_dry, cn)
    out = np.where(antecedent_mm > AMC_WET_MM, cn_wet, out)
    return np.clip(out, 30, 99)


def scs_runoff(p_mm: np.ndarray, cn: np.ndarray) -> np.ndarray:
    s = 25400.0 / cn - 254.0
    ia = 0.2 * s
    return np.where(p_mm > ia, (p_mm - ia) ** 2 / (p_mm + 0.8 * s), 0.0)


def classify(peak: np.ndarray, runoff: np.ndarray, exposed: np.ndarray) -> np.ndarray:
    lp = 1 + np.searchsorted(PEAK_M3S, peak, side="right")
    lr = 1 + np.searchsorted(RUNOFF_MM, runoff, side="right")
    lvl = np.maximum(lp, lr)
    lvl = np.where((lvl >= 2) & exposed, lvl + 1, lvl)
    return np.clip(lvl, 1, 5).astype(np.int16)


def run_model(rain: np.ndarray, weights: np.ndarray, area_km2: np.ndarray, tc_h: np.ndarray,
              cn: np.ndarray, built_km2: np.ndarray, n_antecedent: int):
    """
    rain:        (P, H) hourly rain per rain point; the first `n_antecedent` hours are history
    weights:     (S, P) upstream area of reach s represented by rain point p (km²)
    returns dict of (S, H') arrays for the forecast hours H' = H - n_antecedent:
        basin_rain_hourly, window_rain, runoff, peak, level, peak_offset_h (S,)
    """
    S, H = weights.shape[0], rain.shape[1]
    basin = (weights @ rain) / np.maximum(weights.sum(axis=1, keepdims=True), 1e-9)   # (S, H) mm/h
    csum = np.concatenate([np.zeros((S, 1)), np.cumsum(basin, axis=1)], axis=1)        # (S, H+1)

    d = np.clip(np.round(tc_h), 1, 24).astype(int)                                     # (S,)
    t = np.arange(H)
    # rain over the last d hours ending at each hour
    lo = np.clip(t[None, :] + 1 - d[:, None], 0, None)
    window = csum[np.arange(S)[:, None], t[None, :] + 1] - csum[np.arange(S)[:, None], lo]
    # antecedent: rain in the 5 days before the window
    ant_hi = lo
    ant_lo = np.clip(ant_hi - 120, 0, None)
    antecedent = csum[np.arange(S)[:, None], ant_hi] - csum[np.arange(S)[:, None], ant_lo]

    cn_eff = adjust_cn(np.repeat(cn[:, None], H, axis=1), antecedent)
    q = scs_runoff(window, cn_eff)
    tp = d / 2 + 0.6 * tc_h                                                              # (S,) hours
    peak = 0.208 * area_km2[:, None] * q / tp[:, None]
    level = classify(peak, q, (built_km2 >= EXPOSED_BUILT_KM2)[:, None])

    sl = slice(n_antecedent, None)
    return {
        "basin_rain_hourly": basin[:, sl], "window_rain": window[:, sl], "runoff": q[:, sl],
        "peak": peak[:, sl], "level": level[:, sl], "peak_offset_h": np.round(tp).astype(int),
    }
