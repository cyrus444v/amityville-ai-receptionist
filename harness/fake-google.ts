/**
 * In-memory stand-ins for the three external boundaries the voice agent
 * touches: the appointment spreadsheet, Google Calendar, and the confirmation
 * mailer.
 *
 * These exist so the full request path — HTTP, tool auth, rate limiting,
 * idempotency, validation, booking service, coordination store — can be driven
 * end to end offline. Nothing here contacts Google, Retell, AWS, or any
 * network. The column layout is imported from the real persistence module so
 * the fakes cannot drift from production's schema.
 */

/**
 * The column layout is duplicated here on purpose rather than imported from
 * src/db/client, because that module is the one under test-double. A spec
 * asserts these maps stay identical to the production APPT/CB maps, so a
 * schema change breaks the harness loudly instead of silently.
 */
export const HARNESS_APPT = {
  id: 0,
  caller_name: 1,
  phone: 2,
  email: 3,
  date_of_birth: 4,
  is_new_patient: 5,
  service_name: 6,
  appointment_date: 7,
  appointment_time: 8,
  duration_minutes: 9,
  timezone: 10,
  status: 11,
  notes: 12,
  google_event_id: 13,
  created_at: 14,
  updated_at: 15,
  referral_source: 16,
} as const;

export const HARNESS_CB = {
  id: 0,
  caller_name: 1,
  phone: 2,
  status: 3,
  created_at: 4,
  updated_at: 5,
} as const;

export const HARNESS_SHEET_APPOINTMENTS = 'Appointments';
export const HARNESS_SHEET_CALLBACKS = 'Callbacks';

const APPT = HARNESS_APPT;
const CB = HARNESS_CB;
const SHEET_APPOINTMENTS = HARNESS_SHEET_APPOINTMENTS;
const SHEET_CALLBACKS = HARNESS_SHEET_CALLBACKS;

export interface SheetRow {
  rowIndex: number;
  values: string[];
}

type Row = (string | number | null)[];

function toStrings(values: Row): string[] {
  return values.map((value) => (value ?? '').toString());
}

class FakeSheets {
  private sheets = new Map<string, string[][]>();

  failNextUpdate = false;

  failNextAppend = false;

  readonly writes: Array<{ sheet: string; kind: 'append' | 'update'; rowIndex?: number }> = [];

  reset(): void {
    this.sheets = new Map([
      [SHEET_APPOINTMENTS, []],
      [SHEET_CALLBACKS, []],
    ]);
    this.failNextUpdate = false;
    this.failNextAppend = false;
    this.writes.length = 0;
  }

  /** Seed an existing appointment without going through the booking service. */
  seedAppointment(row: Partial<Record<keyof typeof APPT, string>>): string {
    const values = new Array<string>(Object.keys(APPT).length).fill('');
    for (const [field, value] of Object.entries(row)) {
      values[APPT[field as keyof typeof APPT]] = value ?? '';
    }
    this.rows(SHEET_APPOINTMENTS).push(values);
    return values[APPT.id];
  }

  seedCallback(row: Partial<Record<keyof typeof CB, string>>): void {
    const values = new Array<string>(Object.keys(CB).length).fill('');
    for (const [field, value] of Object.entries(row)) {
      values[CB[field as keyof typeof CB]] = value ?? '';
    }
    this.rows(SHEET_CALLBACKS).push(values);
  }

  private rows(sheetName: string): string[][] {
    let rows = this.sheets.get(sheetName);
    if (!rows) {
      rows = [];
      this.sheets.set(sheetName, rows);
    }
    return rows;
  }

  snapshot(sheetName: string): string[][] {
    return this.rows(sheetName).map((row) => [...row]);
  }

  initSheets = async (): Promise<void> => {
    this.rows(SHEET_APPOINTMENTS);
    this.rows(SHEET_CALLBACKS);
  };

  appendRow = async (sheetName: string, values: Row): Promise<void> => {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('harness sheets append failure');
    }
    this.rows(sheetName).push(toStrings(values));
    this.writes.push({ sheet: sheetName, kind: 'append' });
  };

  getRows = async (sheetName: string): Promise<SheetRow[]> => this.rows(sheetName)
    .map((values, index) => ({ rowIndex: index + 2, values: [...values] }));

  updateRowAtIndex = async (sheetName: string, rowIndex: number, values: Row): Promise<void> => {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error('harness sheets update failure');
    }
    const rows = this.rows(sheetName);
    const target = rowIndex - 2;
    if (target < 0 || target >= rows.length) throw new Error(`harness sheets row ${rowIndex} does not exist`);
    rows[target] = toStrings(values);
    this.writes.push({ sheet: sheetName, kind: 'update', rowIndex });
  };
}

interface FakeEvent {
  id: string;
  date: string;
  time: string;
  durationMinutes: number;
  cancelled: boolean;
}

class FakeCalendar {
  private events = new Map<string, FakeEvent>();

  private counter = 0;

  /** Slots the harness declares occupied regardless of stored events. */
  readonly blockedSlots = new Set<string>();

  failNextWrite = false;

  /** Simulates a Calendar read outage, which should drive the agent to a callback. */
  failNextRead = false;

  readonly operations: string[] = [];

  reset(): void {
    this.events.clear();
    this.counter = 0;
    this.blockedSlots.clear();
    this.failNextWrite = false;
    this.failNextRead = false;
    this.operations.length = 0;
  }

  block(date: string, time: string): void {
    this.blockedSlots.add(`${date}T${time}`);
  }

  activeEvents(): FakeEvent[] {
    return [...this.events.values()].filter((event) => !event.cancelled);
  }

  event(id: string): FakeEvent | undefined {
    return this.events.get(id);
  }

  isSlotAvailable = async (date: string, time: string): Promise<boolean> => {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error('harness calendar read failure');
    }
    this.operations.push(`isSlotAvailable:${date}T${time}`);
    if (this.blockedSlots.has(`${date}T${time}`)) return false;
    return !this.activeEvents().some((event) => event.date === date && event.time === time);
  };

  getAvailableSlots = async (date: string): Promise<string[]> => {
    this.operations.push(`getAvailableSlots:${date}`);
    const candidates = ['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00'];
    const taken = new Set([
      ...this.activeEvents().filter((event) => event.date === date).map((event) => event.time),
      ...[...this.blockedSlots]
        .filter((slot) => slot.startsWith(`${date}T`))
        .map((slot) => slot.split('T')[1]),
    ]);
    return candidates.filter((slot) => !taken.has(slot));
  };

  createCalendarEvent = async (params: {
    summary: string;
    description: string;
    date: string;
    startTime: string;
    durationMinutes: number;
    tz: string;
  }): Promise<string> => {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('harness calendar create failure');
    }
    this.counter += 1;
    const id = `harness-event-${this.counter}`;
    this.events.set(id, {
      id,
      date: params.date,
      time: params.startTime,
      durationMinutes: params.durationMinutes,
      cancelled: false,
    });
    this.operations.push(`createCalendarEvent:${id}`);
    return id;
  };

  updateCalendarEvent = async (
    eventId: string,
    date: string,
    time: string,
    durationMinutes: number,
  ): Promise<void> => {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('harness calendar update failure');
    }
    const event = this.events.get(eventId);
    if (!event) throw new Error(`harness calendar has no event ${eventId}`);
    event.date = date;
    event.time = time;
    event.durationMinutes = durationMinutes;
    this.operations.push(`updateCalendarEvent:${eventId}`);
  };

  cancelCalendarEvent = async (eventId: string): Promise<void> => {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('harness calendar cancel failure');
    }
    const event = this.events.get(eventId);
    if (!event) throw new Error(`harness calendar has no event ${eventId}`);
    event.cancelled = true;
    this.operations.push(`cancelCalendarEvent:${eventId}`);
  };

  checkFreeBusy = async (): Promise<[]> => [];
}

class FakeMailer {
  readonly sent: Array<{ to: string; service: string; date: string; time: string }> = [];

  reset(): void {
    this.sent.length = 0;
  }

  sendBookingConfirmation = async (params: {
    to: string;
    caller_name: string;
    service: string;
    date: string;
    time: string;
    duration_minutes: number;
  }): Promise<void> => {
    this.sent.push({
      to: params.to,
      service: params.service,
      date: params.date,
      time: params.time,
    });
  };
}

export const sheetsFake = new FakeSheets();
export const calendarFake = new FakeCalendar();
export const mailerFake = new FakeMailer();

export function resetFakes(): void {
  sheetsFake.reset();
  calendarFake.reset();
  mailerFake.reset();
}

resetFakes();
