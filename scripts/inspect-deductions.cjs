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
  const exists = await p.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_schema='public' AND table_name='deductions'
     LIMIT 1`,
  );
  console.log('deductions exists:', exists.rows);

  if (exists.rows.length === 0) {
    const cols = await p.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema='public'
       ORDER BY table_name`,
    );
    console.log('public tables:', cols.rows.map((r) => r.table_name));
    await p.end();
    return;
  }

  const cols = await p.query(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name='deductions'
     ORDER BY ordinal_position`,
  );
  console.log('columns:', cols.rows);

  const sample = await p.query(`SELECT * FROM public.deductions LIMIT 20`);
  console.log('rows:', sample.rows);

  await p.end();
})();