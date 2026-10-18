import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";

async function migrateWithRetry(attempts = 30) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await runMigrations();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      console.log(`database not ready (attempt ${i}/${attempts}), retrying...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

await migrateWithRetry();

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });