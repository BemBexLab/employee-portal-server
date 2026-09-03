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
    `SELECT status::text AS status, COUNT(*)::int AS n
     FROM daily_attendance
     GROUP BY status
     ORDER BY n DESC`,
  );
  console.log('Daily attendance status counts:');
  console.log(r.rows);

  const r2 = await p.query(
    `SELECT employee_id::text AS employee_id, status::text AS status, COUNT(*)::int AS n
     FROM daily_attendance
     GROUP BY employee_id, status
     ORDER BY employee_id, status`,
  );
  console.log('\nPer employee:');
  console.log(r2.rows);

  await p.end();
})();