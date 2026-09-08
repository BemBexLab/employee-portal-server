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
    `SELECT e.monthly_salary::text, d.payroll_days,
            ROUND(e.monthly_salary / NULLIF(d.payroll_days, 0), 2)::text AS daily_rate,
            d.late_days, d.half_days, d.absent_days,
            d.late_half_day_deduction_days, d.total_deduction_days
     FROM public.deductions d
     JOIN public.employees e ON e.id = d.employee_id
     WHERE e.monthly_salary > 0
     LIMIT 5`,
  );
  console.log('rows with salary:'); console.table(r.rows);
  await pool.end();
})();
