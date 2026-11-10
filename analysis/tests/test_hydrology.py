"""python -m unittest discover -s analysis/tests"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hydrology import scs_runoff, adjust_cn, classify, run_model  # noqa: E402


class SCS(unittest.TestCase):
    def test_textbook_value(self):
        # P = 5 in, CN = 80 → S = 2.5 in, Ia = 0.5 in, Q = 4.5² / 7 = 2.893 in = 73.5 mm
        self.assertAlmostEqual(float(scs_runoff(np.array(127.0), np.array(80.0))), 73.48, delta=0.05)

    def test_no_runoff_below_initial_abstraction(self):
        # CN 80 → S = 63.5 mm, Ia = 12.7 mm
        self.assertEqual(float(scs_runoff(np.array(12.0), np.array(80.0))), 0.0)

    def test_amc(self):
        cn = np.array([80.0, 80.0, 80.0])
        out = adjust_cn(cn, np.array([0.0, 20.0, 40.0]))
        self.assertLess(out[0], 80)          # dry
        self.assertEqual(out[1], 80)         # normal
        self.assertGreater(out[2], 80)       # wet
        self.assertAlmostEqual(out[0], 63.0, delta=1.0)   # AMC-I table: 63; Chow (1988) formula: 63.7


class Levels(unittest.TestCase):
    def test_classify_and_exposure(self):
        peak = np.array([0, 10, 50, 150, 400.0])
        q = np.zeros(5)
        np.testing.assert_array_equal(classify(peak, q, np.zeros(5, bool)), [1, 2, 3, 4, 5])
        np.testing.assert_array_equal(classify(peak, q, np.ones(5, bool)), [1, 3, 4, 5, 5])

    def test_runoff_depth_alone_raises_level(self):
        self.assertEqual(int(classify(np.array([0.0]), np.array([30.0]), np.array([False]))[0]), 4)


class Model(unittest.TestCase):
    def _run(self, mm_per_h, hours, ant_h=120):
        rain = np.zeros((1, ant_h + hours + 6))
        rain[0, ant_h:ant_h + hours] = mm_per_h
        w = np.array([[50.0]])
        return run_model(rain, w, np.array([50.0]), np.array([2.0]), np.array([85.0]), np.array([0.0]), ant_h)

    def test_more_rain_more_risk(self):
        light, heavy = self._run(3, 3), self._run(30, 3)
        self.assertEqual(light["level"].max(), 1)
        self.assertGreater(heavy["level"].max(), 3)
        self.assertGreater(heavy["peak"].max(), light["peak"].max())

    def test_wet_antecedent_increases_runoff(self):
        base = np.zeros((1, 140)); base[0, 120:123] = 20
        wet = base.copy(); wet[0, 60:70] = 5   # 50 mm two days earlier
        args = (np.array([[50.0]]), np.array([50.0]), np.array([2.0]), np.array([85.0]), np.array([0.0]), 120)
        self.assertGreater(run_model(wet, *args)["runoff"].max(), run_model(base, *args)["runoff"].max())


if __name__ == "__main__":
    unittest.main()
