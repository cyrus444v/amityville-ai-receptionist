-- Add email column to existing appointments table
-- Run this once in the Supabase SQL editor if the table already exists.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS email TEXT;
