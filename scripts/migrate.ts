/**
 * Applies supabase/migrations/*.sql over a direct Postgres connection.
 *
 * A direct connection is required because DDL cannot be issued through the
 * Supabase REST API — the service-role key authenticates against PostgREST, which
 * only speaks DML. So this needs DATABASE_URL (Supabase dashboard -> Connect ->
 * ORMs, or the session pooler string).
 *
 * If you would rather not put the database password on disk, skip this script and
 * paste the SQL straight into the Supabase SQL editor; the migration is written to
 * be idempotent, so running it twice is harmless either way.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      [
        'DATABASE_URL is not set, so migrations cannot be applied automatically.',
        '',
        'Either:',
        '  1. Add DATABASE_URL to .env.local (Supabase -> Connect -> ORMs), then re-run; or',
        '  2. Open the Supabase SQL editor and paste the contents of:',
        `       supabase/migrations/0001_triage.sql`,
        '',
        'The migration is idempotent — applying it twice changes nothing.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const client = new Client({
    connectionString: url,
    // Supabase requires TLS; its pooler presents a cert this client won't chain.
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`applying ${file} ... `);
      // Each migration runs in a transaction so a partial apply cannot happen.
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('commit');
        console.log('ok');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    console.log('\nAll migrations applied.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nMigration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
