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

(async () => {
  const r = await p.query(
    `SELECT t.typname, e.enumlabel
     FROM pg_type t
     JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname IN ('AttendanceStatus','AttendanceStatusOverride','UserRole','DeviceStatus')
     ORDER BY t.typname, e.enumsortorder`,
  );
  console.log(r.rows);
  await p.end();
})();