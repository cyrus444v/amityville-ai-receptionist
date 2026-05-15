import { Router, Request, Response } from 'express';
import { CreateCallbackSchema } from '../utils/validation';
import { createCallback } from '../services/callback';
import { normalisePhone } from '../utils/parse-datetime';
import { logger } from '../utils/logger';

const router = Router();

// POST /create-callback
router.post('/create-callback', async (req: Request, res: Response) => {
  const body = { ...req.body };
  if (body.phone) body.phone = normalisePhone(body.phone) ?? body.phone;

  const parsed = CreateCallbackSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: parsed.error.flatten() });
  }

  try {
    const result = await createCallback(parsed.data);
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    logger.error('create-callback failed', { error: (err as Error).message });
    return res.status(500).json({ success: false, message: 'Failed to save callback request. Please try again.' });
  }
});

export default router;
