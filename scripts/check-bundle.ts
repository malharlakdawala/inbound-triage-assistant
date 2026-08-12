/**
 * Fails if the built Cloudflare Worker contains anything secret.
 *
 *   npm run check:bundle
 *
 * This exists because the leak it checks for actually happened.
 * `@opennextjs/cloudflare` serialises every variable Next.js loads into
 * `.open-next/cloudflare/next-env.mjs`, which is bundled into the deployed
 * Worker. Because Next.js auto-loads `.env.local`, putting a secret there ships
 * it to a public URL — with no warning, and `NEXT_PUBLIC_` prefixing has nothing
 * to do with it.
 *
 * Two checks, because either alone is insufficient:
 *   1. Exact match on the values currently in .env.secrets. Catches the real leak
 *      but only for secrets this machine happens to hold.
 *   2. Pattern match on well-known credential shapes. Catches a teammate's key,
 *      or one that was rotated after the build.
 *
 * Wired into `cf:build` so an unsafe artifact cannot be produced silently. A
 * documented security property that nothing verifies is a hope, not a property.
 */
import { config } from 'dotenv';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUNDLE_DIR = '.open-next';

/** Names whose values must never appear in the bundle. */
const SECRET_VAR_NAMES = [
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'TRIAGE_ADMIN_TOKEN',
  'DATABASE_URL',
];

/** Credential shapes worth flagging even if we do not hold the value locally. */
const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'Anthropic API key', re: /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/ },
  { label: 'OpenRouter API key', re: /sk-or-v1-[A-Za-z0-9]{32,}/ },
  { label: 'OpenAI API key', re: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { label: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { label: 'Postgres connection string with password', re: /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/ },
  // A service_role JWT is identifiable by its decoded payload claim.
  { label: 'service_role JWT', re: /"role"\s*:\s*"service_role"/ },
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) walk(full, out);
    else if (s.size < 20_000_000) out.push(full);
  }
  return out;
}

/** JWTs are base64 — decode payloads so a service_role claim cannot hide. */
function decodedJwtPayloads(text: string): string {
  const parts = text.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g) ?? [];
  return parts
    .map((jwt) => {
      const payload = jwt.split('.')[1];
      if (!payload) return '';
      try {
        return Buffer.from(payload, 'base64url').toString('utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

function main() {
  config({ path: '.env.secrets', quiet: true });

  const secretValues = SECRET_VAR_NAMES.map((name) => ({ name, value: process.env[name] ?? '' }))
    // Short values would match everywhere; only check things long enough to be a real secret.
    .filter((s) => s.value.length >= 12);

  const files = walk(BUNDLE_DIR);
  if (files.length === 0) {
    console.error(`No bundle found at ${BUNDLE_DIR}/. Run \`npm run cf:build\` first.`);
    process.exit(1);
  }

  const findings: string[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const { name, value } of secretValues) {
      if (text.includes(value)) findings.push(`${file}: contains the value of ${name}`);
    }

    const haystack = `${text}\n${decodedJwtPayloads(text)}`;
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(haystack)) findings.push(`${file}: matches ${label}`);
    }
  }

  const scanned = files.length;
  if (findings.length > 0) {
    console.error(`\nFAIL - secrets found in the build artifact (${scanned} files scanned):\n`);
    for (const f of [...new Set(findings)]) console.error(`  ${f}`);
    console.error(
      [
        '',
        'Do not deploy this build.',
        '',
        'Almost certainly a secret is in .env.local. Next.js auto-loads that file and',
        '@opennextjs/cloudflare writes everything it loads into',
        '.open-next/cloudflare/next-env.mjs, which ships inside the Worker.',
        '',
        'Move it to .env.secrets (loaded only by lib/load-env.ts, never by the build),',
        'then rebuild.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  console.log(`OK - no secrets in the build artifact (${scanned} files scanned).`);
  console.log('Checked: exact values from .env.secrets, plus known credential patterns');
  console.log('         and decoded JWT payloads for a service_role claim.');
}

main();
