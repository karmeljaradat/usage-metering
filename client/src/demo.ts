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
  console.log(`\n> ${title}`);
  console.log(`  HTTP ${r.status}`, JSON.stringify(r.body));
}

function section(title: string) {
  console.log(`\n========== ${title} ==========`);
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

  section("Account A: Starter (10000/month, 100 per request)");
  const acc = await call("POST", "/accounts", undefined, {
    name: "demo-" + run,
    planId: id("Starter"),
  });
  show("Create account (Starter)", { status: acc.status, body: { ...acc.body, apiKey: "(hidden)" } });
  const key = acc.body.apiKey as string;

  show("Create user alice (Basic: 1000/month, 20 per request)", await call("POST", "/users", key, { externalId: "alice", planId: id("Basic") }));
  show("Create user bob (Premium: 10000/month, 200 per request)", await call("POST", "/users", key, { externalId: "bob", planId: id("Premium") }));

  show("1) Accepted request (alice, 10 units)", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("2) Same requestId again (retry): not counted twice", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("3) Rejected by the USER per-request limit (alice, 25 > 20)", await call("POST", "/consume", key, { userId: "alice", requestId: "d2", units: 25 }));
  show("4) Rejected by the ACCOUNT per-request limit (bob, 150: his plan allows 200, the account only 100)", await call("POST", "/consume", key, { userId: "bob", requestId: "d3", units: 150 }));

  for (let i = 0; i < 49; i++) {
    await call("POST", "/consume", key, { userId: "alice", requestId: "fill" + i, units: 20 });
  }
  show("5) Rejected by the USER monthly allowance (alice used 990 of 1000, asks 15)", await call("POST", "/consume", key, { userId: "alice", requestId: "d4", units: 15 }));

  const gold = await call("POST", "/custom-plans", key, {
    scope: "user", name: "Gold", monthlyAllowance: 5000, maxUnitsPerRequest: 50,
  });
  show("6) Create custom user plan (Gold: 5000/month, 50 per request)", gold);
  show("7) Upgrade alice to Gold", await call("PUT", "/users/alice/plan", key, { planId: gold.body.id }));
  show("8) Same 15 units with a new requestId: now accepted (a retry of d4 would replay the stored rejection)", await call("POST", "/consume", key, { userId: "alice", requestId: "d5", units: 15 }));

  show("alice usage (used units were kept, no fresh allowance)", await call("GET", "/usage/users/alice", key));
  show("bob usage", await call("GET", "/usage/users/bob", key));
  show("Account usage (sum of accepted usage of all users)", await call("GET", "/usage", key));
  show("Last 3 history entries", await call("GET", "/history?limit=3", key));

  section("Account B: shared monthly allowance rejection");
  const accB = await call("POST", "/accounts", undefined, { name: "demo-b-" + run, planId: id("Starter") });
  const keyB = accB.body.apiKey as string;
  show("Create account B (Starter)", { status: accB.status, body: { ...accB.body, apiKey: "(hidden)" } });

  const tiny = await call("POST", "/custom-plans", keyB, {
    scope: "account", name: "Tiny", monthlyAllowance: 30, maxUnitsPerRequest: 20,
  });
  show("9) Create custom ACCOUNT plan (Tiny: 30/month, 20 per request)", tiny);
  show("10) Switch the account to Tiny", await call("PUT", "/account/plan", keyB, { planId: tiny.body.id }));
  show("Create user carol (Premium)", await call("POST", "/users", keyB, { externalId: "carol", planId: id("Premium") }));

  show("11) carol 20 units: accepted", await call("POST", "/consume", keyB, { userId: "carol", requestId: "b1", units: 20 }));
  show("12) carol 10 units: accepted (account is now at 30/30)", await call("POST", "/consume", keyB, { userId: "carol", requestId: "b2", units: 10 }));
  show("13) carol 5 units: rejected by the ACCOUNT monthly allowance (carol herself has plenty left)", await call("POST", "/consume", keyB, { userId: "carol", requestId: "b3", units: 5 }));
  show("carol usage", await call("GET", "/usage/users/carol", keyB));
  show("Account B usage", await call("GET", "/usage", keyB));

  show("14) Raise Tiny to 100/month (no client change, no redeploy)", await call("PUT", `/custom-plans/${tiny.body.id}`, keyB, { monthlyAllowance: 100 }));
  show("15) carol 5 units with a new requestId: accepted", await call("POST", "/consume", keyB, { userId: "carol", requestId: "b4", units: 5 }));

  section("Isolation");
  show("16) Account B tries to read alice (belongs to account A)", await call("GET", "/users/alice", keyB));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});