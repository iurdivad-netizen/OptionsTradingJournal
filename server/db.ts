import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";

// node-postgres rather than the Neon serverless driver, so the same build talks
// to a plain PostgreSQL server (what DEPLOYMENT_GUIDE.md sets up) as well as a
// hosted one over TCP.
//
// The connection is optional: with no DATABASE_URL the app falls back to
// in-memory storage, so it still runs out of the box with nothing to configure.
export const databaseUrl = process.env.DATABASE_URL;

export const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      // Hosted providers generally require TLS; a local server generally has
      // none, and rejecting its self-signed certificate would block startup.
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
    })
  : null;

export const db = pool ? drizzle(pool, { schema }) : null;
