import { google } from 'googleapis';
import { config } from '../config';

// Column index constants — must match the header row written by initSheets
export const APPT = {
  id: 0,
  caller_name: 1,
  phone: 2,
  email: 3,
  service_name: 4,
  appointment_date: 5,
  appointment_time: 6,
  duration_minutes: 7,
  timezone: 8,
  status: 9,
  notes: 10,
  google_event_id: 11,
  created_at: 12,
  updated_at: 13,
} as const;

export const CB = {
  id: 0,
  caller_name: 1,
  phone: 2,
  reason: 3,
  status: 4,
  created_at: 5,
  updated_at: 6,
} as const;

export const SHEET_APPOINTMENTS = 'Appointments';
export const SHEET_CALLBACKS = 'Callbacks';

const APPT_HEADERS = [
  'id', 'caller_name', 'phone', 'email', 'service_name',
  'appointment_date', 'appointment_time', 'duration_minutes', 'timezone',
  'status', 'notes', 'google_event_id', 'created_at', 'updated_at',
];

const CB_HEADERS = [
  'id', 'caller_name', 'phone', 'reason', 'status', 'created_at', 'updated_at',
];

function getAuth() {
  return new google.auth.JWT({
    email: config.google.serviceAccountEmail,
    key: config.google.privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

export async function initSheets(): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = config.google.spreadsheetId;
  if (!spreadsheetId) throw new Error('GOOGLE_SPREADSHEET_ID is not set.');

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const existingTitles = new Set(meta.data.sheets?.map((s) => s.properties?.title) ?? []);

  const toCreate = [SHEET_APPOINTMENTS, SHEET_CALLBACKS].filter((t) => !existingTitles.has(t));
  if (toCreate.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: toCreate.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }

  // Write headers to any sheet whose first row is empty
  const headerChecks: Array<{ sheet: string; headers: string[] }> = [
    { sheet: SHEET_APPOINTMENTS, headers: APPT_HEADERS },
    { sheet: SHEET_CALLBACKS,    headers: CB_HEADERS },
  ];

  const toWrite: Array<{ range: string; values: string[][] }> = [];
  for (const { sheet, headers } of headerChecks) {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheet}!A1:A1`,
    });
    if (!res.data.values || res.data.values.length === 0) {
      toWrite.push({ range: `${sheet}!A1`, values: [headers] });
    }
  }

  if (toWrite.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: toWrite,
      },
    });
  }
}

export async function appendRow(
  sheetName: string,
  values: (string | number | null)[],
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: config.google.spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values.map((v) => v ?? '')] },
  });
}

// Returns data rows (header row excluded). rowIndex is 1-based sheet row number.
export async function getRows(
  sheetName: string,
): Promise<Array<{ rowIndex: number; values: string[] }>> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.spreadsheetId,
    range: `${sheetName}!A:Z`,
  });
  const all = res.data.values ?? [];
  return all.slice(1).map((row, i) => ({
    rowIndex: i + 2, // +1 skip header, +1 because sheets rows are 1-based
    values: row as string[],
  }));
}

// Overwrite an entire row at a 1-based sheet row index
export async function updateRowAtIndex(
  sheetName: string,
  rowIndex: number,
  values: (string | number | null)[],
): Promise<void> {
  const sheets = getSheets();
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.spreadsheetId,
    range: `${sheetName}!A${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [values.map((v) => v ?? '')] },
  });
}
