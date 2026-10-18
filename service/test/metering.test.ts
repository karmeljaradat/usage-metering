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
  it("بيرفض بدون مفتاح أو بمفتاح غلط", async () => {
    const a = await app.inject({ method: "GET", url: "/account" });
    expect(a.statusCode).toBe(401);
    const b = await app.inject({ method: "GET", url: "/account", headers: { "x-api-key": "wrong" } });
    expect(b.statusCode).toBe(401);
  });

  it("بيقبل مفتاح صحيح", async () => {
    const acc = await newAccount();
    const r = await get(acc.key, "/account");
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(acc.id);
  });
});

describe("عزل الحسابات", () => {
  it("حساب ما بيشوف ولا بيستهلك ولا بيعدّل بيانات حساب ثاني", async () => {
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

    // السجل ما بيتسرّب
    await consume(a.key, userA, "r1", 1);
    const hist = await get(b.key, "/history");
    expect(hist.body.items).toHaveLength(0);
  });
});

describe("حالات الرفض", () => {
  it("per_request على المستخدم", async () => {
    const acc = await newAccount();
    const u = await newUser(acc.key, "Basic"); // 20 لكل طلب
    const r = await consume(acc.key, u, "r1", 21);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "per_request", rejectedLevel: "user" });
  });

  it("per_request على الحساب", async () => {
    const acc = await newAccount("Starter"); // 100 لكل طلب
    const u = await newUser(acc.key, "Premium"); // 200 لكل طلب
    const r = await consume(acc.key, u, "r1", 150);
    expect(r.body).toMatchObject({ accepted: false, rejectedRule: "per_request", rejectedLevel: "account" });
  });

  it("monthly على المستخدم، والرفض ما بينحسب من الرصيد", async () => {
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

  it("monthly على الحساب", async () => {
    const acc = await newAccount("Starter"); // 10000 شهرياً
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
  it("نفس الـ requestId ما بينحسب مرتين", async () => {
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
});

describe("التزامن", () => {
  it("20 طلب متزامن على رصيد 100: بالضبط 10 بينقبلوا", async () => {
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

  it("نفس الـ requestId بشكل متزامن بينحسب مرة وحدة", async () => {
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

describe("History", () => {
  it("pagination وفلتر المستخدم", async () => {
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
});
describe("تغيير الخطط", () => {
  it("تغيير خطة الحساب بيغيّر الحدود للطلبات الجاية", async () => {
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

  it("ما بتقدر تعيّن خطة حساب ثاني أو خطة مستخدم على الحساب", async () => {
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

  it("تخفيض الحد تحت الاستهلاك: المتبقي صفر والطلبات بتنرفض", async () => {
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