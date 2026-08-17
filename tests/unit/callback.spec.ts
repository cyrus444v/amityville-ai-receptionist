import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db/client', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/client')>('../../src/db/client');
  return { ...actual, appendRow: vi.fn(), getRows: vi.fn() };
});

import { appendRow, CB, getRows } from '../../src/db/client';
import { createCallback } from '../../src/services/callback';
import { resetMemoryCoordinationForTests } from '../../src/services/coordination';

describe('callback idempotency', () => {
  beforeEach(() => {
    resetMemoryCoordinationForTests();
    vi.setSystemTime(new Date('2026-08-18T12:00:00.000Z'));
    vi.mocked(getRows).mockResolvedValue([]);
  });

  it('writes a callback once and returns the pending row on retry', async () => {
    const input = { caller_name: 'Fixture Caller', phone: '5551234567' };
    const first = await createCallback(input);
    expect(first.success).toBe(true);
    const row = vi.mocked(appendRow).mock.calls[0][1].map(String);
    vi.mocked(getRows).mockResolvedValue([{ rowIndex: 2, values: row }]);

    const second = await createCallback(input);
    expect(second.success).toBe(true);
    expect(second.callback?.id).toBe(row[CB.id]);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callback retries', async () => {
    let release!: (rows: []) => void;
    vi.mocked(getRows).mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const first = createCallback({ caller_name: 'Fixture Caller', phone: '5551234567' });
    const second = createCallback({ caller_name: 'Fixture Caller', phone: '5551234567' });
    release([]);
    const [a, b] = await Promise.all([first, second]);
    expect(a.callback?.id).toBe(b.callback?.id);
    expect(appendRow).toHaveBeenCalledTimes(1);
  });
});
