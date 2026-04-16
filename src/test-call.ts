// File header: smoke test that calls the local server with a mock grant.
// Real integration: the grant would come from MoltPe's issue_spend_grant MCP tool.

import "dotenv/config";

const base = process.env.RESOURCE_SERVER_URL ?? "http://localhost:4402";

const res = await fetch(`${base}/weather?city=Bengaluru`, {
  headers: {
    "Authorization": `Bearer ${process.env.DEMO_GRANT_TOKEN ?? "mock.jwt.token"}`,
    "X-Payment-Proof": "demo-proof",
  },
});

console.log(`status: ${res.status}`);
console.log(await res.text());
