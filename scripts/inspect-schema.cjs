const fs = require('fs');
const path = require('path');
const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const c = url.replace(
  /([?&])sslmode=require(?=(&|$))/i,
  '$1sslmode=no-verify',
);
const p = new Pool({ connectionString: c, max: 1 });

(async () => {
  const tables = await p.query(
    `SELECT table_schema, table_name
     FROM information_schema.tables
     WHERE table_type='BASE TABLE'
       AND table_schema NOT IN ('pg_catalog', 'information_schema')
       AND table_schema NOT LIKE 'pg_toast%'
     ORDER BY table_schema, table_name`,
  );
  console.log('TABLES:', tables.rows);

  for (const t of tables.rows) {
    const cols = await p.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema=$1 AND table_name=$2
       ORDER BY ordinal_position`,
      [t.table_schema, t.table_name],
    );
    console.log(`\n[${t.table_schema}.${t.table_name}]`);
    console.log(cols.rows);
  }

  await p.end();
})();