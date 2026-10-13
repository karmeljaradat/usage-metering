import { readdir, readFile } from "node:fs/promises";
import { pool } from "./db.js";

const dir = new URL("../migrations/", import.meta.url);

export async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    const done = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [file],
    );
    if (done.rowCount) continue;

    const sql = await readFile(new URL(file, dir), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`applied migration ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}