import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.API_URL || "http://service:3000";
const JSON_H = { "content-type": "application/json" };
const ACCOUNTS = Number(__ENV.ACCOUNTS || 20);
const USERS_PER_ACCOUNT = Number(__ENV.USERS_PER_ACCOUNT || 5);
const RATE = Number(__ENV.RATE || 200);
const DURATION = __ENV.DURATION || "30s";

export const options = {
  scenarios: {
    load: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
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
  const run = Date.now();

  const accounts = [];
  for (let a = 0; a < ACCOUNTS; a++) {
    const acc = http
      .post(
        `${BASE}/accounts`,
        JSON.stringify({ name: `k6-${run}-${a}`, planId: id("Pro") }),
        { headers: JSON_H },
      )
      .json();
    const headers = { ...JSON_H, "x-api-key": acc.apiKey };
    const users = [];
    for (let i = 0; i < USERS_PER_ACCOUNT; i++) {
      const externalId = `u-${i}`;
      http.post(
        `${BASE}/users`,
        JSON.stringify({ externalId, planId: id("Premium") }),
        { headers },
      );
      users.push(externalId);
    }
    accounts.push({ headers, users });
  }
  return { accounts };
}

export default function (data) {
  const acc = data.accounts[Math.floor(Math.random() * data.accounts.length)];
  const user = acc.users[Math.floor(Math.random() * acc.users.length)];
  const res = http.post(
    `${BASE}/consume`,
    JSON.stringify({
      userId: user,
      requestId: `${__VU}-${__ITER}-${Date.now()}`,
      units: 5,
    }),
    { headers: acc.headers },
  );
  check(res, { "status is 200 or 422": (r) => r.status === 200 || r.status === 422 });
}
export function teardown(data) {
  let total = 0;
  let overLimit = 0;
  for (const acc of data.accounts) {
    const u = http.get(`${BASE}/usage`, { headers: acc.headers }).json();
    total += u.used;
    if (u.used > u.allowance) overLimit++;
  }
  console.log(`FINAL total units consumed: ${total}, accounts over limit: ${overLimit}`);
}