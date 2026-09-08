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
  // Employees whose live salary differs from the historical deduction snapshot.
  const r = await pool.query(
    `SELECT d.employee_id::text AS employee_id,
            d.monthly_salary::text AS deduction_snapshot_salary,
            e.employee_code,
            e.monthly_salary::text AS live_employee_salary,
            d.payroll_cycle_month
     FROM public.deductions d
     JOIN public.employees e ON e.id = d.employee_id
     WHERE d.monthly_salary IS DISTINCT FROM e.monthly_salary
     LIMIT 20`,
  );
  console.log('historical snapshot mismatches:'); console.table(r.rows);
  await pool.end();
})();
