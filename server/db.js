import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Load server/.env regardless of CWD (local dev from repo root or server/)
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export default pool;
