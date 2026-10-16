import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAccount } from "../auth.js";

type Limits = {
  user: { monthly: number; perRequest: number };
  account: { monthly: number; perRequest: number };
};

function monthStart(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

export async function consumeRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireAccount);

  app.post(
    "/consume",
    {
      schema: {
        body: {
          type: "object",
          required: ["userId", "requestId", "units"],
          properties: {
            userId: { type: "string", minLength: 1 },
            requestId: { type: "string", minLength: 1 },
            units: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      const { userId, requestId, units } = req.body as {
        userId: string;
        requestId: string;
        units: number;
      };
      const accountId = req.account!.id;
      const month = monthStart();

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        await client.query(
          `INSERT INTO account_monthly_usage (account_id, month)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [accountId, month],
        );
        const acc = await client.query(
          `SELECT used FROM account_monthly_usage
           WHERE account_id = $1 AND month = $2 FOR UPDATE`,
          [accountId, month],
        );
        const accountUsed = Number(acc.rows[0].used);

        const prev = await client.query(
          `SELECT accepted, rejected_rule, rejected_level, units
           FROM usage_requests WHERE account_id = $1 AND request_id = $2`,
          [accountId, requestId],
        );
        if (prev.rowCount) {
          await client.query("COMMIT");
          const p = prev.rows[0];
          return reply.code(p.accepted ? 200 : 422).send({
            accepted: p.accepted,
            units: Number(p.units),
            rejectedRule: p.rejected_rule,
            rejectedLevel: p.rejected_level,
            duplicate: true,
          });
        }

        const u = await client.query(
          `SELECT u.id, p.monthly_allowance, p.max_units_per_request
           FROM users u JOIN plans p ON p.id = u.plan_id
           WHERE u.account_id = $1 AND u.external_id = $2`,
          [accountId, userId],
        );
        if (!u.rowCount) {
          await client.query("ROLLBACK");
          return reply.code(404).send({ error: "user_not_found" });
        }
        const ap = await client.query(
          `SELECT monthly_allowance, max_units_per_request
           FROM plans WHERE id = $1`,
          [req.account!.planId],
        );

        const limits: Limits = {
          user: {
            monthly: Number(u.rows[0].monthly_allowance),
            perRequest: Number(u.rows[0].max_units_per_request),
          },
          account: {
            monthly: Number(ap.rows[0].monthly_allowance),
            perRequest: Number(ap.rows[0].max_units_per_request),
          },
        };

        await client.query(
          `INSERT INTO user_monthly_usage (user_id, month)
           VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [u.rows[0].id, month],
        );
        const uu = await client.query(
          `SELECT used FROM user_monthly_usage
           WHERE user_id = $1 AND month = $2`,
          [u.rows[0].id, month],
        );
        const userUsed = Number(uu.rows[0].used);

        let rule: string | null = null;
        let level: string | null = null;
        if (units > limits.user.perRequest) {
          rule = "per_request"; level = "user";
        } else if (units > limits.account.perRequest) {
          rule = "per_request"; level = "account";
        } else if (userUsed + units > limits.user.monthly) {
          rule = "monthly"; level = "user";
        } else if (accountUsed + units > limits.account.monthly) {
          rule = "monthly"; level = "account";
        }

        const accepted = rule === null;

        if (accepted) {
          await client.query(
            `UPDATE account_monthly_usage SET used = used + $3
             WHERE account_id = $1 AND month = $2`,
            [accountId, month, units],
          );
          await client.query(
            `UPDATE user_monthly_usage SET used = used + $3
             WHERE user_id = $1 AND month = $2`,
            [u.rows[0].id, month, units],
          );
        }

        await client.query(
          `INSERT INTO usage_requests
             (account_id, user_id, request_id, units, accepted,
              rejected_rule, rejected_level, month, applied_limits)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [accountId, u.rows[0].id, requestId, units, accepted,
           rule, level, month, JSON.stringify(limits)],
        );

        await client.query("COMMIT");
        return reply.code(accepted ? 200 : 422).send({
          accepted,
          units,
          rejectedRule: rule,
          rejectedLevel: level,
          duplicate: false,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );
}