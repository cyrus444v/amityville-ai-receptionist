import crypto from 'crypto';
import { appendRow, CB, SHEET_CALLBACKS } from '../db/client';
import { logger } from '../utils/logger';
import type { Callback } from '../types';

export async function createCallback(params: {
  caller_name: string;
  phone: string;
}): Promise<{ success: boolean; callback?: Callback; message: string }> {
  const now = new Date().toISOString();
  const callback: Callback = {
    id:          crypto.randomUUID(),
    caller_name: params.caller_name,
    phone:       params.phone,
    status:      'pending',
    created_at:  now,
    updated_at:  now,
  };

  const row: (string | number | null)[] = new Array(6).fill('');
  row[CB.id]          = callback.id;
  row[CB.caller_name] = callback.caller_name;
  row[CB.phone]       = callback.phone;
  row[CB.status]      = callback.status;
  row[CB.created_at]  = callback.created_at;
  row[CB.updated_at]  = callback.updated_at;

  try {
    await appendRow(SHEET_CALLBACKS, row);
  } catch (err) {
    logger.error('Failed to save callback', { error: (err as Error).message });
    return { success: false, message: 'Failed to save callback request.' };
  }

  logger.info('Callback created');

  return {
    success: true,
    callback,
    message: `Callback request saved for ${params.caller_name}. We will call you back as soon as possible.`,
  };
}
