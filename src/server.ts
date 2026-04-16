// File header: reference x402 API server accepting MoltPe+Grantex-gated calls.
// Middleware order matters:
//   1. Grantex: verify the JWT grant, enforce scope + budget. Reject BEFORE charging.
//   2. x402: MoltPe-side paywall — returns 402 if no payment proof, 200 + data on success.
// Both checks happen server-side; the client never has to prove anything twice.

import "dotenv/config";
import express from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";

const app = express();
app.use(express.json());

const JWKS = createRemoteJWKSet(
  new URL(process.env.GRANTEX_JWKS_URI ?? "https://api.grantex.dev/.well-known/jwks.json"),
);
const ISSUER = process.env.GRANTEX_ISSUER ?? "https://api.grantex.dev";
const ENDPOINT_ID = "weather"; // scope key this API registers as

const PRICE_USDC = 0.005;

// ---- Grantex verification middleware ------------------------------------
// Rejects the call before MoltPe ever signs a payment if the grant is:
//   - missing / malformed
//   - expired or revoked (jose checks the JWKS; revocation list is polled)
//   - missing the scope for this endpoint
//   - over-budget for this call
async function requireGrant(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const auth = req.header("authorization");
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_grant", hint: "Attach a Grantex grant JWT" });
    return;
  }
  const token = auth.slice("Bearer ".length);

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ISSUER,
      audience: "moltpe",
    });

    const scopes = (payload.scope as string | undefined)?.split(" ") ?? [];
    const hasScope = scopes.some((s) => s.startsWith(`x402:call:`) && s.includes(ENDPOINT_ID));
    if (!hasScope) {
      res.status(403).json({ error: "out_of_scope", required: `x402:call:*${ENDPOINT_ID}*` });
      return;
    }

    const budget = (payload.budget as { currency: string; remaining: number } | undefined);
    if (!budget || budget.currency !== "USDC" || budget.remaining < PRICE_USDC) {
      res.status(402).json({ error: "budget_exhausted", priceUsdc: PRICE_USDC });
      return;
    }

    (req as any).grant = { id: payload.jti, agentDid: payload.sub, payload };
    next();
  } catch (err: any) {
    res.status(401).json({ error: "invalid_grant", detail: err?.message });
  }
}

// ---- x402 paywall middleware --------------------------------------------
// Minimal reference. In production you'd use @coinbase/x402 or equivalent.
function x402Paywall(priceUsdc: number) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const proof = req.header("x-payment-proof"); // MoltPe gateway attaches this after signing.
    if (!proof) {
      res.status(402).json({
        scheme: "x402",
        priceUsdc,
        asset: "USDC",
        chain: "arc",
        payTo: process.env.PAYEE_ADDRESS ?? "0xPayee",
      });
      return;
    }
    // TODO: verify `proof` on-chain or via MoltPe's facilitator. Omitted for the reference.
    res.setHeader("x-moltpe-paid-usdc", priceUsdc.toString());
    next();
  };
}

// ---- The actual paid endpoint -------------------------------------------
app.get("/weather", requireGrant, x402Paywall(PRICE_USDC), (req, res) => {
  const city = String(req.query.city ?? "Bengaluru");
  // Fake data for the reference server.
  const tempC = 22 + Math.floor(Math.random() * 12);
  res.json({ city, tempC, unit: "C", source: "moltpe-grantex-example" });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.RESOURCE_SERVER_PORT ?? 4402);
app.listen(port, () => {
  console.log(`weather x402 api listening :${port}`);
  console.log(`  grant verification: jose + Grantex JWKS (${process.env.GRANTEX_JWKS_URI})`);
});
