import { getSupabaseClient } from '../db/client';
import { logger } from '../utils/logger';
import type { Callback } from '../types';

export async function createCallback(params: {
  caller_name: string;
  phone: string;
  reason?: string;
}): Promise<{ success: boolean; callback?: Callback; message: string }> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from('callbacks')
    .insert({
      caller_name: params.caller_name,
      phone:       params.phone,
      reason:      params.reason ?? null,
      status:      'pending',
    })
    .select()
    .single();

  if (error) {
    logger.error('Failed to save callback', { error: error.message });
    return { success: false, message: 'Failed to save callback request.' };
  }

  logger.info('Callback created');

  return {
    success: true,
    callback: data as Callback,
    message: `Callback request saved for ${params.caller_name}. We will call you back as soon as possible.`,
  };
}
