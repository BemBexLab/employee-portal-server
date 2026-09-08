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
const c = url.replace(/([?&])sslmode=require(?=(&|$))/i, '$1sslmode=no-verify');
const p = new Pool({ connectionString: c, max: 1 });

const ddl = `
CREATE TABLE IF NOT EXISTS "request_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "request_id" uuid NOT NULL REFERENCES "employee_requests"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "employee_id" uuid NOT NULL REFERENCES "employees"("id") ON DELETE CASCADE,
  "original_name" text NOT NULL,
  "stored_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "size_bytes" bigint NOT NULL,
  "storage_path" text,
  "content" bytea,
  "uploaded_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "request_attachments_request_idx"
  ON "request_attachments" ("request_id");

CREATE INDEX IF NOT EXISTS "request_attachments_expires_idx"
  ON "request_attachments" ("expires_at");

ALTER TABLE "request_attachments"
  ALTER COLUMN "storage_path" DROP NOT NULL;

ALTER TABLE "request_attachments"
  ADD COLUMN IF NOT EXISTS "content" bytea;
`;

(async () => {
  try {
    await p.query(ddl);
    const legacy = await p.query(
      `SELECT id, storage_path
       FROM request_attachments
       WHERE content IS NULL AND storage_path IS NOT NULL`,
    );
    let migrated = 0;
    for (const row of legacy.rows) {
      try {
        const content = await fs.promises.readFile(row.storage_path);
        await p.query(
          `UPDATE request_attachments
           SET content = $1, storage_path = NULL
           WHERE id = $2`,
          [content, row.id],
        );
        migrated += 1;
      } catch {
        // The old VPS-local file may no longer be present.
      }
    }
    console.log('request_attachments schema applied.');
    if (legacy.rows.length > 0) {
      console.log(
        `Migrated ${migrated}/${legacy.rows.length} legacy attachment(s).`,
      );
    }
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await p.end();
  }
})();
