import Fastify from "fastify";
import { pool } from "./db.js";
import { accountRoutes } from "./routes/accounts.js";
import { userRoutes } from "./routes/users.js";

export function buildApp() {
  const app = Fastify({ logger: true });

  app.get("/health", async () => {
    const result = await pool.query("SELECT now() AS now");
    return { status: "ok", dbTime: result.rows[0].now };
  });

  app.register(accountRoutes);
  app.register(userRoutes);

  return app;
}