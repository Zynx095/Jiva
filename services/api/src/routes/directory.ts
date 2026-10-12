import { Router } from 'express';
import type { FacilityCategory } from '@jiva/domain-models';
import { loadDirectory, nearbyFacilities } from '../directory';

const CATEGORIES: FacilityCategory[] = ['HOSPITAL', 'SPECIALTY_HOSPITAL', 'MATERNITY_HOME', 'HEALTH_CENTRE', 'CLINIC', 'NURSING_HOME', 'DIAGNOSTIC_CENTRE', 'UNKNOWN'];

const parseCategories = (raw: unknown): FacilityCategory[] | null => {
  if (raw === undefined || raw === '') return [];
  const list = String(raw).split(',').map(s => s.trim().toUpperCase());
  return list.every(c => (CATEGORIES as string[]).includes(c)) ? (list as FacilityCategory[]) : null;
};

const NOT_CONNECTED = 'Public directory listing. Not connected to JIVA: no acceptance channel; services, beds and capacity are unknown.';

/**
 * Public facility directory (any authenticated role: it contains only public listing data).
 *   GET /api/directory/facilities?category=HOSPITAL,MATERNITY_HOME&located=true
 *   GET /api/directory/facilities/near?lat=12.97&lng=77.59&limit=5&category=HOSPITAL
 */
export function directoryRouter(): Router {
  const router = Router();

  router.get('/directory/facilities', (req, res) => {
    const dir = loadDirectory();
    if (!dir) return res.status(503).json({ error: 'directory_unavailable', message: 'The facility directory has not been built (npm run directory:build).' });
    const categories = parseCategories(req.query.category);
    if (!categories) return res.status(400).json({ error: 'validation_failed', issues: [{ path: 'category', message: `One of ${CATEGORIES.join(', ')}` }] });
    const located = req.query.located === 'true';
    const facilities = dir.facilities.filter(f => (!categories.length || categories.includes(f.category)) && (!located || !!f.location));
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ buildId: dir.buildId, osmSnapshot: dir.osmSnapshot, sources: dir.sources, counts: dir.counts, note: NOT_CONNECTED, facilities });
  });

  router.get('/directory/facilities/near', (req, res) => {
    if (!loadDirectory()) return res.status(503).json({ error: 'directory_unavailable' });
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
    const categories = parseCategories(req.query.category);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || !Number.isInteger(limit) || limit < 1 || limit > 25 || !categories) {
      return res.status(400).json({ error: 'validation_failed', message: 'lat, lng (degrees), limit (1–25) and category are required/validated.' });
    }
    const results = nearbyFacilities({ latitude: lat, longitude: lng }, { limit, categories });
    res.json({ basis: 'STRAIGHT_LINE_DISTANCE', note: NOT_CONNECTED, results });
  });

  return router;
}
