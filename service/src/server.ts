import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";

await runMigrations();

const app = buildApp();
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });