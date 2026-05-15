-- ============================================================
-- AI Receptionist – Supabase Schema
-- Run this in your Supabase SQL editor to initialize the database.
-- ============================================================

-- Appointments
CREATE TABLE IF NOT EXISTS appointments (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_name      TEXT        NOT NULL,
  phone            TEXT        NOT NULL,
  service_id       TEXT,
  service_name     TEXT        NOT NULL,
  appointment_date DATE        NOT NULL,
  appointment_time TIME        NOT NULL,
  duration_minutes INTEGER     NOT NULL DEFAULT 60,
  timezone         TEXT        NOT NULL DEFAULT 'America/New_York',
  google_event_id  TEXT,
  status           TEXT        NOT NULL DEFAULT 'confirmed'
                               CHECK (status IN ('confirmed', 'cancelled', 'rescheduled')),
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Callbacks
CREATE TABLE IF NOT EXISTS callbacks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_name  TEXT        NOT NULL,
  phone        TEXT        NOT NULL,
  reason       TEXT,
  status       TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'completed', 'missed')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_appointments_phone          ON appointments(phone);
CREATE INDEX IF NOT EXISTS idx_appointments_date           ON appointments(appointment_date);
CREATE INDEX IF NOT EXISTS idx_appointments_status         ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_google_event   ON appointments(google_event_id);
CREATE INDEX IF NOT EXISTS idx_callbacks_phone             ON callbacks(phone);
CREATE INDEX IF NOT EXISTS idx_callbacks_status            ON callbacks(status);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER appointments_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER callbacks_updated_at
  BEFORE UPDATE ON callbacks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
