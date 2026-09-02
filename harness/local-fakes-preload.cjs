/**
 * Development-only module interception.
 *
 * Replaces the three external boundaries — Sheets, Calendar, mailer — with the
 * in-memory doubles from harness/fake-google.ts *before* the app requires them,
 * so `src/` needs no dev switch and production code has no bypass to abuse.
 *
 * Load it with `node -r ts-node/register -r ./harness/local-fakes-preload.cjs`.
 * It refuses to run when NODE_ENV=production so it can never be preloaded into
 * a real deployment.
 */

'use strict';

if (process.env.NODE_ENV === 'production') {
  throw new Error('local-fakes-preload.cjs must never be loaded in production.');
}

const Module = require('module');
const path = require('path');

const fakes = require(path.resolve(__dirname, 'fake-google.ts'));

const projectRoot = path.resolve(__dirname, '..');
const targets = new Map([
  [path.join(projectRoot, 'src', 'db', 'client'), (original) => ({
    ...original,
    initSheets: (...args) => fakes.sheetsFake.initSheets(...args),
    appendRow: (...args) => fakes.sheetsFake.appendRow(...args),
    getRows: (...args) => fakes.sheetsFake.getRows(...args),
    updateRowAtIndex: (...args) => fakes.sheetsFake.updateRowAtIndex(...args),
  })],
  [path.join(projectRoot, 'src', 'services', 'calendar'), (original) => ({
    ...original,
    isSlotAvailable: (...args) => fakes.calendarFake.isSlotAvailable(...args),
    getAvailableSlots: (...args) => fakes.calendarFake.getAvailableSlots(...args),
    createCalendarEvent: (...args) => fakes.calendarFake.createCalendarEvent(...args),
    updateCalendarEvent: (...args) => fakes.calendarFake.updateCalendarEvent(...args),
    cancelCalendarEvent: (...args) => fakes.calendarFake.cancelCalendarEvent(...args),
    checkFreeBusy: (...args) => fakes.calendarFake.checkFreeBusy(...args),
  })],
  [path.join(projectRoot, 'src', 'services', 'email'), (original) => ({
    ...original,
    sendBookingConfirmation: (...args) => fakes.mailerFake.sendBookingConfirmation(...args),
  })],
]);

const originalLoad = Module._load;
const patched = new Set();

Module._load = function load(request, parent, isMain) {
  const original = originalLoad.call(this, request, parent, isMain);
  if (!parent || typeof request !== 'string' || !request.startsWith('.')) return original;

  const resolvedNoExt = path
    .resolve(path.dirname(parent.filename), request)
    .replace(/\.(ts|js)$/, '');
  const decorate = targets.get(resolvedNoExt);
  if (!decorate) return original;

  patched.add(path.relative(projectRoot, resolvedNoExt));
  return decorate(original);
};

process.on('exit', () => {
  if (patched.size < targets.size) {
    // Surfaced loudly: a silently unpatched boundary would mean the local server
    // tried to reach the real Google APIs.
    console.error(
      `[local-fakes] WARNING: only patched ${[...patched].join(', ') || 'nothing'} — expected all three boundaries.`,
    );
  }
});

module.exports = { fakes };
