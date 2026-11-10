-- Sample valley geometries for local development ONLY.
-- Coordinates are rough approximations — replace with authoritative data
-- (e.g. from the National Center for Meteorology / MEWA / OpenStreetMap waterway=wadi).
INSERT INTO public.valleys (name_ar, name_en, geom)
SELECT * FROM (VALUES
('وادي حنيفة', 'Wadi Hanifah', ST_Multi(ST_GeomFromText(
  'LINESTRING(46.560 24.960, 46.600 24.850, 46.640 24.760, 46.680 24.680, 46.720 24.600, 46.770 24.520, 46.830 24.450)', 4326))),
('وادي فاطمة', 'Wadi Fatimah', ST_Multi(ST_GeomFromText(
  'LINESTRING(39.950 21.430, 39.850 21.400, 39.750 21.370, 39.600 21.330, 39.450 21.300, 39.300 21.290)', 4326))),
('وادي بيش', 'Wadi Baysh', ST_Multi(ST_GeomFromText(
  'LINESTRING(42.900 17.500, 42.800 17.400, 42.700 17.300, 42.600 17.200, 42.500 17.100)', 4326)))
) AS s(name_ar, name_en, geom)
WHERE NOT EXISTS (SELECT 1 FROM public.valleys v WHERE v.name_en = s.name_en);
