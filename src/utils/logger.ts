type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const SENSITIVE_KEYS = new Set([
  'phone', 'email', 'privatekey', 'key', 'token', 'password', 'secret',
  'date_of_birth', 'dateofbirth', 'dob', 'stored_phones', 'storedphones',
  'body', 'request_body', 'requestbody', 'raw_body', 'rawbody',
  'caller_name', 'callername', 'full_name', 'fullname',
]);

function sanitizeString(value: string): string {
  const withoutEmails = value.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    '[REDACTED_EMAIL]',
  );

  return withoutEmails.replace(/\+?\d[\d().\s-]{5,}\d/g, (candidate) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(candidate.trim())) return candidate;
    const digitCount = candidate.replace(/\D/g, '').length;
    return digitCount >= 7 ? '[REDACTED_PHONE]' : candidate;
  });
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/-/g, '_');
      const collapsedKey = normalizedKey.replace(/_/g, '');
      const sensitive = SENSITIVE_KEYS.has(normalizedKey)
        || SENSITIVE_KEYS.has(collapsedKey)
        || ['phone', 'email', 'secret', 'token', 'password', 'privatekey'].some((part) => collapsedKey.includes(part));
      out[key] = sensitive ? '[REDACTED]' : sanitizeValue(nested);
    }
    return out;
  }
  return value;
}

export function sanitizeLogMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return sanitizeValue(meta) as Record<string, unknown>;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (meta) entry.meta = sanitizeLogMeta(meta);

  const line = JSON.stringify(entry);
  level === 'error' ? console.error(line) : console.log(line);
}

export const logger = {
  info:  (msg: string, meta?: Record<string, unknown>) => log('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
};
