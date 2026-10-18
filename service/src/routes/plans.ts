import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAccount } from "../auth.js";

const planBody = {
  type: "object",
  required: ["scope", "name", "monthlyAllowance", "maxUnitsPerRequest"],
  properties: {
    scope: { type: "string", enum: ["account", "user"] },
    name: { type: "string", minLength: 1 },
    monthlyAllowance: { type: "integer", minimum: 0 },
    maxUnitsPerRequest: { type: "integer", minimum: 1 },
  },
} as const;

export async function customPlanRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAccount);

  app.post("/custom-plans", { schema: { body: planBody } }, async (req, reply) => {
    const b = req.body as {
      scope: "account" | "user";
      name: string;
      monthlyAllowance: number;
      maxUnitsPerRequest: number;
    };
    try {
      const result = await pool.query(
        `INSERT INTO plans (account_id, scope, name, monthly_allowance, max_units_per_request)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, scope, name, monthly_allowance, max_units_per_request`,
        [req.account!.id, b.scope, b.name, b.monthlyAllowance, b.maxUnitsPerRequest],
      );
      return reply.code(201).send(result.rows[0]);
    } catch (err: any) {
      if (err.code === "23505") {
        return reply.code(409).send({ error: "plan_name_exists" });
      }
      throw err;
    }
  });

  app.get("/custom-plans", async (req) => {
    const result = await pool.query(
      `SELECT id, scope, name, monthly_allowance, max_units_per_request
       FROM plans WHERE account_id = $1 ORDER BY created_at`,
      [req.account!.id],
    );
    return result.rows;
  });

  app.put(
    "/custom-plans/:id",
    {
      schema: {
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            monthlyAllowance: { type: "integer", minimum: 0 },
            maxUnitsPerRequest: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as {
        name?: string;
        monthlyAllowance?: number;
        maxUnitsPerRequest?: number;
      };
      const result = await pool.query(
        `UPDATE plans SET
           name = COALESCE($3, name),
           monthly_allowance = COALESCE($4, monthly_allowance),
           max_units_per_request = COALESCE($5, max_units_per_request),
           updated_at = now()
         WHERE id = $1 AND account_id = $2
         RETURNING id, scope, name, monthly_allowance, max_units_per_request`,
        [id, req.account!.id, b.name ?? null, b.monthlyAllowance ?? null, b.maxUnitsPerRequest ?? null],
      );
      if (!result.rowCount) {
        return reply.code(404).send({ error: "plan_not_found" });
      }
      return result.rows[0];
    },
  );
}