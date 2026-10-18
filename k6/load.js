import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.API_URL || "http://service:3000";
const JSON_H = { "content-type": "application/json" };

export const options = {
  scenarios: {
    load: {
      executor: "constant-arrival-rate",
      rate: 200,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export function setup() {
  const plans = http.get(`${BASE}/plans`).json();
  const id = (n) => plans.find((p) => p.name === n).id;

  const acc = http
    .post(
      `${BASE}/accounts`,
      JSON.stringify({ name: "k6-" + Date.now(), planId: id("Pro") }),
      { headers: JSON_H },
    )
    .json();
  const headers = { ...JSON_H, "x-api-key": acc.apiKey };

  const users = [];
  for (let i = 0; i < 20; i++) {
    const externalId = "k6-user-" + i;
    http.post(
      `${BASE}/users`,
      JSON.stringify({ externalId, planId: id("Premium") }),
      { headers },
    );
    users.push(externalId);
  }
  return { headers, users };
}

export default function (data) {
  const user = data.users[Math.floor(Math.random() * data.users.length)];
  const res = http.post(
    `${BASE}/consume`,
    JSON.stringify({
      userId: user,
      requestId: `${__VU}-${__ITER}-${Date.now()}`,
      units: 5,
    }),
    { headers: data.headers },
  );
  check(res, { "status is 200 or 422": (r) => r.status === 200 || r.status === 422 });
}

export function teardown(data) {
  const u = http.get(`${BASE}/usage`, { headers: data.headers }).json();
  console.log(`FINAL account usage: ${JSON.stringify(u)}`);
}