try {
  process.loadEnvFile(".env");
} catch {}
process.env.DATABASE_URL ??= "postgres://metering:metering@localhost:5432/metering";