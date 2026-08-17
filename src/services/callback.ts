import crypto from 'crypto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { appendRow, getRows, CB, SHEET_CALLBACKS } from '../db/client';
import { config } from '../config';
import { logger } from '../utils/logger';
import { normalisePhone } from '../utils/parse-datetime';
import type { Callback } from '../types';
import { acquireCoordinationKeys, coordinationKey, releaseCoordinationKeys } from './coordination';

dayjs.extend(utc);
dayjs.extend(timezone);

function rowToCallback(values: string[]): Callback {
  return {
    id: values[CB.id] ?? '',
    caller_name: values[CB.caller_name] ?? '',
    phone: values[CB.phone] ?? '',
    status: (values[CB.status] as Callback['status']) || 'pending',
    created_at: values[CB.created_at] ?? '',
    updated_at: values[CB.updated_at] ?? '',
  };
}

function callbackIdentity(phone: string, date: string): string {
  return crypto.createHash('sha256').update(`${normalisePhone(phone)}|${date}`).digest('hex');
}

const callbackWrites = new Map<string, Promise<{ success: boolean; callback?: Callback; message: string }>>();

export async function createCallback(params: {
  caller_name: string;
  phone: string;
}): Promise<{ success: boolean; callback?: Callback; message: string }> {
  const today = dayjs().tz(config.business.timezone).format('YYYY-MM-DD');
  const identity = callbackIdentity(params.phone, today);
  const existingWrite = callbackWrites.get(identity);
  if (existingWrite) return existingWrite;

  const write = createCallbackOnce(params, today).finally(() => {
    if (callbackWrites.get(identity) === write) callbackWrites.delete(identity);
  });
  callbackWrites.set(identity, write);
  return write;
}

async function createCallbackOnce(
  params: { caller_name: string; phone: string },
  today: string,
): Promise<{ success: boolean; callback?: Callback; message: string }> {
  const identity = callbackIdentity(params.phone, today);
  const owner = crypto.randomUUID();
  const key = coordinationKey('callback-write', identity);
  const expiresAt = dayjs.tz(today, config.business.timezone).add(2, 'day').valueOf();
  const claimed = await acquireCoordinationKeys([key], owner, expiresAt);

  let rows: Awaited<ReturnType<typeof getRows>>;
  try {
    rows = await getRows(SHEET_CALLBACKS);
  } catch (err) {
    logger.error('Failed to check callback idempotency', { error: (err as Error).message });
    if (claimed) await releaseCoordinationKeys([key], owner);
    return { success: false, message: 'Failed to verify callback state.' };
  }

  const duplicate = rows.find(({ values }) => {
    const createdDate = values[CB.created_at]
      ? dayjs(values[CB.created_at]).tz(config.business.timezone).format('YYYY-MM-DD')
      : '';
    return (values[CB.status] ?? '') === 'pending'
      && callbackIdentity(values[CB.phone] ?? '', createdDate) === identity;
  });
  if (duplicate) {
    return {
      success: true,
      callback: rowToCallback(duplicate.values),
      message: 'This callback request is already pending.',
    };
  }
  if (!claimed) {
    return { success: true, message: 'This callback request is already pending.' };
  }

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
    await releaseCoordinationKeys([key], owner);
    return { success: false, message: 'Failed to save callback request.' };
  }

  logger.info('Callback created');

  return {
    success: true,
    callback,
    message: `Callback request saved for ${params.caller_name}. We will call you back as soon as possible.`,
  };
}
