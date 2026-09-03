const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
const c = url.replace(
  /([?&])sslmode=require(?=(&|$))/i,
  '$1sslmode=no-verify',
);
const pool = new Pool({ connectionString: c, max: 1 });
(async () => {
  const r = await pool.query(
    `SELECT monthly_salary::text, payroll_days, daily_rate::text, deduction_amount::text,
            late_days, half_days, absent_days, late_half_day_deduction_days, total_deduction_days
     FROM public.deductions
     WHERE monthly_salary > 0
     LIMIT 5`,
  );
  console.log('rows with salary:'); console.table(r.rows);
  await pool.end();
})();