/**
 * Environment loading for the local scripts.
 *
 * The split between `.env.local` and `.env.secrets` is a deployment-safety
 * decision, not a style one.
 *
 * `@opennextjs/cloudflare` serialises everything Next.js loads into
 * `.open-next/cloudflare/next-env.mjs` and ships that file inside the Worker.
 * Next.js auto-loads `.env.local`, so anything in it lands in the deployed
 * bundle — regardless of whether it is prefixed `NEXT_PUBLIC_`. During this
 * build that silently baked a live Anthropic key, an OpenRouter key, the
 * Supabase service-role key and the admin token into the artifact.
 *
 * So:
 *   .env.local    - values that are safe to publish. Next.js loads it; the
 *                   bundle contains it. Read-path Supabase values only.
 *   .env.secrets  - everything secret. Next.js does not know this filename, so
 *                   it is never bundled. Only this module loads it, and only the
 *                   local scripts import this module.
 *
 * `npm run check:bundle` enforces the invariant by scanning the built Worker for
 * the secret values and failing if it finds any.
 *
 * Imported for its side effect, before anything that reads process.env. Bare
 * `dotenv/config` would only read `.env` and leave the scripts unconfigured.
 */
import { config } from 'dotenv';

// Secrets first so they win, then public values, then any plain .env.
config({ path: '.env.secrets', quiet: true });
config({ path: '.env.local', quiet: true });
config({ quiet: true });
