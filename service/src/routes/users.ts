import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAccount } from "../auth.js";

export async function userRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAccount);

  // تسجيل مستخدم تحت الحساب (بخطة user جاهزة أو custom تابعة لنفس الحساب)
  app.post(
    "/users",
    {
      schema: {
        body: {
          type: "object",
          required: ["externalId", "planId"],
          properties: {
            externalId: { type: "string", minLength: 1 },
            planId: { type: "string", format: "uuid" },
          },
        },
      },
    },
    async (req, reply) => {
      const { externalId, planId } = req.body as {
        externalId: string;
        planId: string;
      };
      const accountId = req.account!.id;

      const plan = await pool.query(
        `SELECT id FROM plans
         WHERE id = $1 AND scope = 'user'
           AND (account_id IS NULL OR account_id = $2)`,
        [planId, accountId],
      );
      if (!plan.rowCount) {
        return reply.code(400).send({ error: "invalid_plan" });
      }

      try {
        const result = await pool.query(
          `INSERT INTO users (account_id, external_id, plan_id)
           VALUES ($1, $2, $3)
           RETURNING id, external_id, plan_id, created_at`,
          [accountId, externalId, planId],
        );
        return reply.code(201).send(result.rows[0]);
      } catch (err: any) {
        if (err.code === "23505") {
          return reply.code(409).send({ error: "user_already_exists" });
        }
        throw err;
      }
    },
  );

  // عرض مستخدم
  app.get("/users/:externalId", async (req, reply) => {
    const { externalId } = req.params as { externalId: string };
    const result = await pool.query(
      `SELECT u.id, u.external_id, u.created_at,
              p.id AS plan_id, p.name AS plan_name,
              p.monthly_allowance, p.max_units_per_request
       FROM users u JOIN plans p ON p.id = u.plan_id
       WHERE u.account_id = $1 AND u.external_id = $2`,
      [req.account!.id, externalId],
    );
    if (!result.rowCount) {
      return reply.code(404).send({ error: "user_not_found" });
    }
    return result.rows[0];
  });

  // تغيير خطة مستخدم
  app.put(
    "/users/:externalId/plan",
    {
      schema: {
        body: {
          type: "object",
          required: ["planId"],
          properties: { planId: { type: "string", format: "uuid" } },
        },
      },
    },
    async (req, reply) => {
      const { externalId } = req.params as { externalId: string };
      const { planId } = req.body as { planId: string };
      const accountId = req.account!.id;

      const plan = await pool.query(
        `SELECT id FROM plans
         WHERE id = $1 AND scope = 'user'
           AND (account_id IS NULL OR account_id = $2)`,
        [planId, accountId],
      );
      if (!plan.rowCount) {
        return reply.code(400).send({ error: "invalid_plan" });
      }

      const result = await pool.query(
        `UPDATE users SET plan_id = $1
         WHERE account_id = $2 AND external_id = $3
         RETURNING id, external_id, plan_id`,
        [planId, accountId, externalId],
      );
      if (!result.rowCount) {
        return reply.code(404).send({ error: "user_not_found" });
      }
      return result.rows[0];
    },
  );
}