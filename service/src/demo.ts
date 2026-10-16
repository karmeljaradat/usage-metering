const BASE = process.env.API_URL ?? "http://localhost:3000";

async function call(method: string, path: string, key?: string, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function show(title: string, r: { status: number; body: unknown }) {
  console.log(`\n▶ ${title}`);
  console.log(`  HTTP ${r.status}`, JSON.stringify(r.body));
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("server not reachable at " + BASE);
}

async function main() {
  await waitForServer();
  const run = Date.now().toString(36);

  const plans = (await call("GET", "/plans")).body as any[];
  const id = (n: string) => plans.find((p) => p.name === n).id as string;

  const acc = await call("POST", "/accounts", undefined, {
    name: "demo-" + run,
    planId: id("Starter"),
  });
  show("إنشاء حساب بخطة Starter", { status: acc.status, body: { ...acc.body, apiKey: "(hidden)" } });
  const key = acc.body.apiKey as string;

  show("إنشاء مستخدم بخطة Basic", await call("POST", "/users", key, { externalId: "alice", planId: id("Basic") }));

  show("1) طلب مقبول (10 وحدات)", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("2) نفس الطلب (retry): ما بينحسب مرتين", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("3) رفض per_request على المستخدم (25 > 20)", await call("POST", "/consume", key, { userId: "alice", requestId: "d2", units: 25 }));

  for (let i = 0; i < 49; i++) {
    await call("POST", "/consume", key, { userId: "alice", requestId: "fill" + i, units: 20 });
  }
  show("4) رفض monthly على المستخدم (استنفدنا 1000)", await call("POST", "/consume", key, { userId: "alice", requestId: "d3", units: 15 }));

  const gold = await call("POST", "/custom-plans", key, {
    scope: "user", name: "Gold", monthlyAllowance: 5000, maxUnitsPerRequest: 50,
  });
  show("5) إنشاء خطة custom (Gold)", gold);
  show("6) ترقية المستخدم لـ Gold", await call("PUT", "/users/alice/plan", key, { planId: gold.body.id }));
  show("7) نفس الطلب المرفوض صار مقبول بعد الترقية", await call("POST", "/consume", key, { userId: "alice", requestId: "d4", units: 15 }));

  show("استهلاك المستخدم", await call("GET", "/usage/users/alice", key));
  show("استهلاك الحساب", await call("GET", "/usage", key));
  show("آخر 3 سجلات", await call("GET", "/history?limit=3", key));

  const other = await call("POST", "/accounts", undefined, { name: "other-" + run, planId: id("Starter") });
  show("8) عزل الحسابات: حساب ثاني بيحاول يقرا مستخدم alice", await call("GET", "/users/alice", other.body.apiKey));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});