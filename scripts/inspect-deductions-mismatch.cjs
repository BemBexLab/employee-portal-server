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
  // Employees in deductions table whose own monthly_salary is non-zero in employees but zero in deductions
  const r = await pool.query(
    `SELECT d.employee_id::text AS employee_id,
            d.monthly_salary::text AS d_salary,
            e.employee_code,
            e.monthly_salary::text AS e_salary,
            d.payroll_cycle_month
     FROM public.deductions d
     JOIN public.employees e ON e.id = d.employee_id
     WHERE d.monthly_salary = 0
       AND e.monthly_salary > 0
     LIMIT 3`,
  );
  console.log('mismatch rows:'); console.table(r.rows);
  await pool.end();
})();