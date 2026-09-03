const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { Pool } = require('pg');
const c = process.env.DATABASE_URL.replace(
  /([?&])sslmode=require(?=(&|$))/i,
  '$1sslmode=no-verify',
);
const pool = new Pool({ connectionString: c, max: 1 });
(async () => {
  const r = await pool.query(
    `SELECT employee_code, name, monthly_salary::text
     FROM public.employees
     WHERE is_active = true
     ORDER BY employee_code
     LIMIT 10`,
  );
  console.log('employees:'); console.table(r.rows);
  await pool.end();
})();