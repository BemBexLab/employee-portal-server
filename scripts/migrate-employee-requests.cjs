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
  CREATE TYPE "RequestKind" AS ENUM ('LEAVE', 'REMOTE_WORK');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "RequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LeaveCategory" AS ENUM (
    'ANNUAL_LEAVE', 'SICK_LEAVE', 'CASUAL_LEAVE', 'UNPAID_LEAVE'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "employee_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "kind" "RequestKind" NOT NULL,
  "leave_category" "LeaveCategory",
  "from_date" date NOT NULL,
  "to_date" date NOT NULL,
  "reason" text NOT NULL,
  "note" text,
  "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
  "submitted_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "decided_by" uuid REFERENCES "users"("id"),
  CONSTRAINT "employee_requests_date_range_check" CHECK ("from_date" <= "to_date")
);

CREATE INDEX IF NOT EXISTS "employee_requests_employee_submitted_idx"
  ON "employee_requests" ("employee_id", "submitted_at" DESC);

CREATE INDEX IF NOT EXISTS "employee_requests_org_status_idx"
  ON "employee_requests" ("organization_id", "status");
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