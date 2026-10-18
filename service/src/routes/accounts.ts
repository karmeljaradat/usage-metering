import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { generateApiKey, hashKey, requireAccount } from "../auth.js";

export async function accountRoutes(app: FastifyInstance) {
  app.get("/plans", async () => {
    const result = await pool.query(
      `SELECT id, scope, name, monthly_allowance, max_units_per_request
       FROM plans WHERE account_id IS NULL ORDER BY scope, monthly_allowance`,
    );
    return result.rows;
  });

  app.post(
    "/accounts",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "planId"],
          properties: {
            name: { type: "string", minLength: 1 },
            planId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) => {
      const { name, planId } = req.body as { name: string; planId: string };

      const plan = await pool.query(
        "SELECT id FROM plans WHERE id = $1 AND scope = 'account' AND account_id IS NULL",
        [planId],
      );
      if (!plan.rowCount) {
        return reply.code(400).send({ error: "invalid_plan" });
      }

      const apiKey = generateApiKey();
      const result = await pool.query(
        `INSERT INTO accounts (name, plan_id, api_key_hash)
         VALUES ($1, $2, $3) RETURNING id, name, plan_id, created_at`,
        [name, planId, hashKey(apiKey)],
      );

      return reply.code(201).send({ ...result.rows[0], apiKey });
    },
  );

  app.get("/account", { preHandler: requireAccount }, async (req) => {
    const result = await pool.query(
      `SELECT a.id, a.name, a.created_at,
              p.id AS plan_id, p.name AS plan_name,
              p.monthly_allowance, p.max_units_per_request
       FROM accounts a JOIN plans p ON p.id = a.plan_id
       WHERE a.id = $1`,
      [req.account!.id],
    );
    return result.rows[0];
  });

  app.put(
    "/account/plan",
    {
      preHandler: requireAccount,
      schema: {
        body: {
          type: "object",
          required: ["planId"],
          properties: { planId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const { planId } = req.body as { planId: string };
      const accountId = req.account!.id;

      const plan = await pool.query(
        `SELECT id FROM plans
         WHERE id = $1 AND scope = 'account'
           AND (account_id IS NULL OR account_id = $2)`,
        [planId, accountId],
      );
      if (!plan.rowCount) {
        return reply.code(400).send({ error: "invalid_plan" });
      }

      await pool.query("UPDATE accounts SET plan_id = $1 WHERE id = $2", [
        planId,
        accountId,
      ]);
      return { id: accountId, plan_id: planId };
    },
  );
}