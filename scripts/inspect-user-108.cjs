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
    `SELECT e.employee_code, u.email, u.role, u.is_active, LEFT(u.password_hash, 12) AS hash_prefix
     FROM public.employees e
     LEFT JOIN public.users u ON u.employee_id = e.id
     WHERE e.employee_code = '108'`,
  );
  console.log(r.rows);
  await pool.end();
})();