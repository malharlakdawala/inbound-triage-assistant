/**
 * Loads .env.local then .env, matching Next.js precedence so the scripts and the
 * app read the same values. Imported for its side effect, before anything that
 * touches process.env — bare `dotenv/config` only reads `.env` and would leave
 * the scripts looking unconfigured while the app worked fine.
 */
import { config } from 'dotenv';

config({ path: '.env.local', quiet: true });
config({ quiet: true });
