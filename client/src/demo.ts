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
  show("Create account (Starter)", { status: acc.status, body: { ...acc.body, apiKey: "(hidden)" } });
  const key = acc.body.apiKey as string;

  show("Create user (Basic)", await call("POST", "/users", key, { externalId: "alice", planId: id("Basic") }));

  show("1) Accepted request (10 units)", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("2) Same request again (retry): not counted twice", await call("POST", "/consume", key, { userId: "alice", requestId: "d1", units: 10 }));
  show("3) Rejected per_request on user (25 > 20)", await call("POST", "/consume", key, { userId: "alice", requestId: "d2", units: 25 }));

  for (let i = 0; i < 49; i++) {
    await call("POST", "/consume", key, { userId: "alice", requestId: "fill" + i, units: 20 });
  }
  show("4) Rejected monthly on user (1000 exhausted)", await call("POST", "/consume", key, { userId: "alice", requestId: "d3", units: 15 }));

  const gold = await call("POST", "/custom-plans", key, {
    scope: "user", name: "Gold", monthlyAllowance: 5000, maxUnitsPerRequest: 50,
  });
  show("5) Create custom plan (Gold)", gold);
  show("6) Upgrade user to Gold", await call("PUT", "/users/alice/plan", key, { planId: gold.body.id }));
  show("7) Same request now accepted after upgrade", await call("POST", "/consume", key, { userId: "alice", requestId: "d4", units: 15 }));

  show("User usage", await call("GET", "/usage/users/alice", key));
  show("Account usage", await call("GET", "/usage", key));
  show("Last 3 history entries", await call("GET", "/history?limit=3", key));

  const other = await call("POST", "/accounts", undefined, { name: "other-" + run, planId: id("Starter") });
  show("8) Account isolation: other account reads alice", await call("GET", "/users/alice", other.body.apiKey));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
