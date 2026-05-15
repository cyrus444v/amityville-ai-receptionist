import { Router, Request, Response } from 'express';
import { searchServices, getAllServices, buildSpokenServiceList } from '../services/knowledge';
import { config } from '../config';
import { z } from 'zod';

const router = Router();

// POST /search-services
router.post('/search-services', (req: Request, res: Response) => {
  const schema = z.object({ query: z.string().min(1, 'Query is required') });
  const parsed = schema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Missing required field: query' });
  }

  const results = searchServices(parsed.data.query);
  const serviceNames = results.map((s) => s.name);
  const spokenSummary = buildSpokenServiceList(results);

  return res.json({
    success: true,
    count: results.length,
    matches: results,
    service_names: serviceNames,
    spoken_summary: spokenSummary,
  });
});

// GET /services
router.get('/services', (_req: Request, res: Response) => {
  return res.json({ success: true, services: getAllServices() });
});

// GET /clinic-info
router.get('/clinic-info', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    clinic: {
      name:          config.business.name,
      timezone:      config.business.timezone,
      phone:         config.business.phone,
      address:       config.business.address,
      website:       config.business.website,
      business_hours: config.business.businessHours,
    },
  });
});

export default router;
