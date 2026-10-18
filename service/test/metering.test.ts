import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../src/db.js";
import { runMigrations } from "../src/migrate.js";
import {
  app, consume, get, newAccount, newUser, newUserOnPlan, newUserPlan,
} from "./helpers.js";

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("API key", () => {
  it("rejects a missing or wrong key", async () => {
    const a = await app.inject({ method: "GET", url: "/account" });
    expect(a.statusCode).toBe(401);
    const b = await app.inject({ method: "GET", url: "/account", headers: { "x-api-key": "wrong" } });
    expect(b.statusCode).toBe(401);
  });

  it("accepts a valid key", async () => {
    const acc = await newAccount();
    const r = await get(acc.key, "/account");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(acc.id);
  });
});

describe("account isolation", () => {
  it("an account cannot read, consume from or modify another account's data", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const userA = await newUser(a.key);
    const planA = await newUserPlan(a.key, 100, 10);

    expect((await get(b.key, `/users/${userA}`)).status).toBe(404);
    expect((await consume(b.key, userA, "x1", 1)).status).toBe(404);
    expect((await get(b.key, `/usage/users/${userA}`)).status).toBe(404);

    const edit = await app.inject({
      method: "PUT",
      url: `/custom-plans/${planA}`,
      headers: { "x-api-key": b.key },
      payload: { monthlyAllowance: 999999 },
    });
    expect(edit.statusCode).toBe(404);

    // history does not leak
    await consume(a.key, userA, "r1", 1);
    const hist = await get(b.key, "/history");
    expect(hist.body.items).toHaveLength(0);
  });
});

describe("rejections", () => {
  it("per_request on the user", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic"); // 20 per request
    const r = await consume(acc.key, u, "r1", 21);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "per_request", rejectedLevel: "user" });
  });

  it("per_request on the account", async () => {
    const acc = await newAccount("Starter"); // 100 per request
    const u = await newUser(acc.key, "Premium"); // 200 per request
    const r = await consume(acc.key, u, "r1", 150);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "per_request", rejectedLevel: "account" });
  });

  it("monthly on the user, and a rejection does not consume allowance", async () => {
    const acc = await newAccount();
    const plan = await newUserPlan(acc.key, 100, 50);
    const u = await newUserOnPlan(acc.key, plan);

    expect((await consume(acc.key, u, "r1", 50)).body.accepted).toBe(true);
    expect((await consume(acc.key, u, "r2", 50)).body.accepted).toBe(true);
    const r = await consume(acc.key, u, "r3", 1);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "monthly", rejectedLevel: "user" });

    const usage = await get(acc.key, `/usage/users/${u}`);
    expect(usage.body).toMatchObject({ allowance: 100, used: 100, remaining: 0 });
  });

  it("monthly on the account", async () => {
    const acc = await newAccount("Starter"); // 10000 per month
    const a = await newUser(acc.key, "Premium");
    const b = await newUser(acc.key, "Premium");

    for (let i = 0; i < 60; i++) await consume(acc.key, a, `a${i}`, 100);
    for (let i = 0; i < 40; i++) await consume(acc.key, b, `b${i}`, 100);

    const r = await consume(acc.key, a, "over", 1);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "monthly", rejectedLevel: "account" });

    const usage = await get(acc.key, "/usage");
    expect(usage.body).toMatchObject({ allowance: 10000, used: 10000, remaining: 0 });
  });
});

describe("retry (idempotency)", () => {
  it("the same requestId is not counted twice", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic");

    const first = await consume(acc.key, u, "same", 10);
    const second = await consume(acc.key, u, "same", 10);
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.accepted).toBe(true);

    const usage = await get(acc.key, `/usage/users/${u}`);
    expect(usage.body.used).toBe(10);

    const hist = await get(acc.key, "/history");
    expect(hist.body.items).toHaveLength(1);
  });

  it("reusing a requestId with a different amount or user is a 409 and counts nothing", async () => {
    const acc = await newAccount();
    const u1 = await newUser(acc.key, "Basic");
    const u2 = await newUser(acc.key, "Basic");

    expect((await consume(acc.key, u1, "reused", 10)).status).toBe(200);

    const otherAmount = await consume(acc.key, u1, "reused", 11);
    expect(otherAmount.status).toBe(409);
    expect(otherAmount.body.error).toBe("request_id_conflict");

    const otherUser = await consume(acc.key, u2, "reused", 10);
    expect(otherUser.status).toBe(409);

    const usage = await get(acc.key, "/usage");
    expect(usage.body.used).toBe(10);
  });
});

describe("concurrency", () => {
  it("20 concurrent requests against an allowance of 100: exactly 10 are accepted", async () => {
    const acc = await newAccount();
    const plan = await newUserPlan(acc.key, 100, 10);
    const u = await newUserOnPlan(acc.key, plan);

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => consume(acc.key, u, `c${i}`, 10)),
    );
    const accepted = results.filter((r) => r.body.accepted).length;
    expect(accepted).toBe(10);

    const usage = await get(acc.key, `/usage/users/${u}`);
    expect(usage.body.used).toBe(100);
  });

  it("the same requestId sent concurrently is counted once", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => consume(acc.key, u, "dup", 10)),
    );
    expect(results.filter((r) => !r.body.duplicate)).toHaveLength(1);

    const usage = await get(acc.key, `/usage/users/${u}`);
    expect(usage.body.used).toBe(10);
  });
});

describe("history and usage queries", () => {
  it("pagination and user filter", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic");
    for (let i = 0; i < 5; i++) await consume(acc.key, u, `h${i}`, 1);

    const page1 = await get(acc.key, "/history?limit=2&offset=0");
    const page2 = await get(acc.key, "/history?limit=2&offset=2");
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items).toHaveLength(2);
    expect(page1.body.items[0].request_id).toBe("h4");
    expect(page2.body.items[0].request_id).toBe("h2");

    const filtered = await get(acc.key, `/history?userId=${u}`);
    expect(filtered.body.items).toHaveLength(5);
  });

  it("month filter on history and usage; invalid month is a 400", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic");
    await consume(acc.key, u, "m1", 3);

    const current = new Date().toISOString().slice(0, 7);
    expect((await get(acc.key, `/history?month=${current}`)).body.items).toHaveLength(1);
    expect((await get(acc.key, "/history?month=2020-01")).body.items).toHaveLength(0);

    const oldUsage = await get(acc.key, "/usage?month=2020-01");
    expect(oldUsage.status).toBe(200);
    expect(oldUsage.body.used).toBe(0);

    expect((await get(acc.key, "/usage?month=abc")).status).toBe(400);
    expect((await get(acc.key, "/usage?month=2026-13")).status).toBe(400);
    expect((await get(acc.key, `/usage/users/${u}?month=nope`)).status).toBe(400);
    expect((await get(acc.key, "/history?month=nope")).status).toBe(400);
  });
});

describe("plan changes", () => {
  it("switching the account plan changes the limits for upcoming requests", async () => {
    const acc = await newAccount("Starter");
    const u = await newUser(acc.key, "Premium");

    const before = await consume(acc.key, u, "r1", 150);
    expect(before.body).toMatchObject({ rejectedRule: "per_request", rejectedLevel: "account" });

    const created = await app.inject({
      method: "POST",
      url: "/custom-plans",
      headers: { "x-api-key": acc.key },
      payload: { scope: "account", name: "Big", monthlyAllowance: 10000, maxUnitsPerRequest: 500 },
    });
    const planId = created.json().id;

    const sw = await app.inject({
      method: "PUT",
      url: "/account/plan",
      headers: { "x-api-key": acc.key },
      payload: { planId },
    });
    expect(sw.statusCode).toBe(200);

    const after = await consume(acc.key, u, "r2", 150);
    expect(after.body.accepted).toBe(true);
  });

  it("cannot assign another account's plan, or a user plan to the account", async () => {
    const a = await newAccount();
    const b = await newAccount();

    const planB = await app.inject({
      method: "POST",
      url: "/custom-plans",
      headers: { "x-api-key": b.key },
      payload: { scope: "account", name: "Secret", monthlyAllowance: 999999, maxUnitsPerRequest: 9999 },
    });
    const r1 = await app.inject({
      method: "PUT",
      url: "/account/plan",
      headers: { "x-api-key": a.key },
      payload: { planId: planB.json().id },
    });
    expect(r1.statusCode).toBe(400);

    const userPlan = await newUserPlan(a.key, 100, 10);
    const r2 = await app.inject({
      method: "PUT",
      url: "/account/plan",
      headers: { "x-api-key": a.key },
      payload: { planId: userPlan },
    });
    expect(r2.statusCode).toBe(400);
  });

  it("lowering the allowance below usage: remaining is zero and requests are rejected", async () => {
    const acc = await newAccount();
    const plan = await newUserPlan(acc.key, 100, 50);
    const u = await newUserOnPlan(acc.key, plan);

    expect((await consume(acc.key, u, "r1", 50)).body.accepted).toBe(true);
    expect((await consume(acc.key, u, "r2", 30)).body.accepted).toBe(true); // used = 80

    const edit = await app.inject({
      method: "PUT",
      url: `/custom-plans/${plan}`,
      headers: { "x-api-key": acc.key },
      payload: { monthlyAllowance: 50 },
    });
    expect(edit.statusCode).toBe(200);

    const usage = await get(acc.key, `/usage/users/${u}`);
    expect(usage.body).toMatchObject({ allowance: 50, used: 80, remaining: 0 });

    const r = await consume(acc.key, u, "r3", 1);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "monthly", rejectedLevel: "user" });

    const hist = await get(acc.key, "/history?limit=10");
    const old = hist.body.items.find((i: any) => i.request_id === "r1");
    expect(old.applied_limits.user.monthly).toBe(100);
  });
});