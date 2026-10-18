import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAccount } from "../auth.js";

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function parseMonth(q: unknown): string | null {
  if (q === undefined || q === "") return monthStart();
  if (typeof q === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(q)) return q + "-01";
  return null;
}

export async function usageRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAccount);

  app.get("/usage", async (req, reply) => {
    const month = parseMonth((req.query as any).month);
    if (!month) return reply.code(400).send({ error: "invalid_month" });

    const result = await pool.query(
      `SELECT p.monthly_allowance,
              COALESCE(m.used, 0) AS used
       FROM accounts a
       JOIN plans p ON p.id = a.plan_id
       LEFT JOIN account_monthly_usage m
              ON m.account_id = a.id AND m.month = $2
       WHERE a.id = $1`,
      [req.account!.id, month],
    );
    const r = result.rows[0];
    const allowance = Number(r.monthly_allowance);
    const used = Number(r.used);
    return {
      month: month.slice(0, 7),
      allowance,
      used,
      remaining: Math.max(allowance - used, 0),
    };
  });

  app.get("/usage/users/:externalId", async (req, reply) => {
    const { externalId } = req.params as { externalId: string };
    const month = parseMonth((req.query as any).month);
    if (!month) return reply.code(400).send({ error: "invalid_month" });

    const result = await pool.query(
      `SELECT p.monthly_allowance,
              COALESCE(m.used, 0) AS used
       FROM users u
       JOIN plans p ON p.id = u.plan_id
       LEFT JOIN user_monthly_usage m
              ON m.user_id = u.id AND m.month = $3
       WHERE u.account_id = $1 AND u.external_id = $2`,
      [req.account!.id, externalId, month],
    );
    if (!result.rowCount) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    const r = result.rows[0];
    const allowance = Number(r.monthly_allowance);
    const used = Number(r.used);
    return {
      month: month.slice(0, 7),
      allowance,
      used,
      remaining: Math.max(allowance - used, 0),
    };
  });

  app.get("/history", async (req, reply) => {
    const q = req.query as {
      limit?: string;
      offset?: string;
      userId?: string;
      month?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
    const offset = Math.max(Number(q.offset) || 0, 0);

    const params: unknown[] = [req.account!.id];
    let where = "r.account_id = $1";
    if (q.userId) {
      params.push(q.userId);
      where += ` AND u.external_id = $${params.length}`;
    }
    if (q.month !== undefined && q.month !== "") {
      const month = parseMonth(q.month);
      if (!month) return reply.code(400).send({ error: "invalid_month" });
      params.push(month);
      where += ` AND r.month = $${params.length}`;
    }
    params.push(limit, offset);

    const result = await pool.query(
      `SELECT r.request_id, u.external_id AS user_id, r.units, r.accepted,
              r.rejected_rule, r.rejected_level, r.applied_limits, r.created_at
       FROM usage_requests r
       JOIN users u ON u.id = r.user_id
       WHERE ${where}
       ORDER BY r.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { limit, offset, items: result.rows };
  });
}