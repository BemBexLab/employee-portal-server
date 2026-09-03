const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL missing');
const c = url.replace(
  /([?&])sslmode=require(?=(&|$))/i,
  '$1sslmode=no-verify',
);
const p = new Pool({ connectionString: c, max: 1 });

const ddl = `
DO $$ BEGIN
  CREATE TYPE "CorrectionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ComplaintType" AS ENUM (
    'INCORRECT_CHECK_IN',
    'INCORRECT_CHECK_OUT',
    'INCORRECT_STATUS',
    'MISSING_ATTENDANCE',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "attendance_corrections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "daily_attendance_id" uuid REFERENCES "daily_attendance"("id") ON DELETE SET NULL,
  "complaint_type" "ComplaintType" NOT NULL,
  "expected_check_in" time,
  "expected_check_out" time,
  "description" text NOT NULL,
  "status" "CorrectionStatus" NOT NULL DEFAULT 'PENDING',
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "decided_by" uuid REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "attendance_corrections_employee_submitted_idx"
  ON "attendance_corrections" ("employee_id", "submitted_at" DESC);

CREATE INDEX IF NOT EXISTS "attendance_corrections_org_status_idx"
  ON "attendance_corrections" ("organization_id", "status");
`;

(async () => {
  try {
    await p.query(ddl);
    console.log('Schema applied.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await p.end();
  }
})();