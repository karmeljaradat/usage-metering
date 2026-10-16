import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";

export const app = buildApp();

let plansCache: any[] | null = null;

export async function planId(name: string) {
  if (!plansCache) {
    plansCache = (await app.inject({ method: "GET", url: "/plans" })).json();
  }
  return plansCache!.find((p) => p.name === name).id as string;
}

export async function newAccount(plan = "Starter") {
  const res = await app.inject({
    method: "POST",
    url: "/accounts",
    payload: { name: "test-" + randomUUID(), planId: await planId(plan) },
  });
  const body = res.json();
  return { id: body.id as string, key: body.apiKey as string };
}

export async function newUser(key: string, plan = "Basic", externalId = "u-" + randomUUID()) {
  const res = await app.inject({
    method: "POST",
    url: "/users",
    headers: { "x-api-key": key },
    payload: { externalId, planId: await planId(plan) },
  });
  if (res.statusCode !== 201) throw new Error("newUser failed: " + res.body);
  return externalId;
}

export async function newUserPlan(key: string, monthly: number, perRequest: number) {
  const res = await app.inject({
    method: "POST",
    url: "/custom-plans",
    headers: { "x-api-key": key },
    payload: {
      scope: "user",
      name: "plan-" + randomUUID(),
      monthlyAllowance: monthly,
      maxUnitsPerRequest: perRequest,
    },
  });
  return res.json().id as string;
}

export async function newUserOnPlan(key: string, customPlanId: string) {
  const externalId = "u-" + randomUUID();
  const res = await app.inject({
    method: "POST",
    url: "/users",
    headers: { "x-api-key": key },
    payload: { externalId, planId: customPlanId },
  });
  if (res.statusCode !== 201) throw new Error("newUserOnPlan failed: " + res.body);
  return externalId;
}

export async function consume(key: string, userId: string, requestId: string, units: number) {
  const res = await app.inject({
    method: "POST",
    url: "/consume",
    headers: { "x-api-key": key },
    payload: { userId, requestId, units },
  });
  return { status: res.statusCode, body: res.json() };
}

export async function get(key: string, url: string) {
  const res = await app.inject({ method: "GET", url, headers: { "x-api-key": key } });
  return { status: res.statusCode, body: res.json() };
}