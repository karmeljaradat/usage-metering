import Fastify from "fastify";
import { pool } from "./db.js";
import { runMigrations } from "./migrate.js";

const app = Fastify({ logger: true });

app.get("/health", async () => {
  const result = await pool.query("SELECT now() AS now");
  return { status: "ok", dbTime: result.rows[0].now };
});

await runMigrations();

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });