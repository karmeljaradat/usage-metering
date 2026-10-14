import { createHash, randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool } from "./db.js";

export function generateApiKey() {
  return "um_" + randomBytes(24).toString("hex");
}

export function hashKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

declare module "fastify" {
  interface FastifyRequest {
    account?: { id: string; name: string; planId: string };
  }
}

export async function requireAccount(req: FastifyRequest, reply: FastifyReply) {
  const key = req.headers["x-api-key"];
  if (typeof key !== "string" || key.length === 0) {
    return reply.code(401).send({ error: "missing_api_key" });
  }

  const result = await pool.query(
    "SELECT id, name, plan_id FROM accounts WHERE api_key_hash = $1",
    [hashKey(key)],
  );
  if (!result.rowCount) {
    return reply.code(401).send({ error: "invalid_api_key" });
  }

  const row = result.rows[0];
  req.account = { id: row.id, name: row.name, planId: row.plan_id };
}