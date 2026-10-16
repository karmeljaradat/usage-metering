import Fastify from "fastify";
import { pool } from "./db.js";
import { accountRoutes } from "./routes/accounts.js";
import { userRoutes } from "./routes/users.js";
import { customPlanRoutes } from "./routes/plans.js";
import { consumeRoutes } from "./routes/consume.js";
import { usageRoutes } from "./routes/usage.js";

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health", async () => {
    const result = await pool.query("SELECT now() AS now");
    return { status: "ok", dbTime: result.rows[0].now };
  });

  app.register(accountRoutes);
  app.register(userRoutes);
  app.register(customPlanRoutes);
  app.register(consumeRoutes);
  app.register(usageRoutes);

  return app;
}