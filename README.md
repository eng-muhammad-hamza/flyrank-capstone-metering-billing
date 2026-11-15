# Usage Metering & Billing Engine

[![Node.js](https://img.shields.io/badge/Node.js-v24.19+-green.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-purple.svg)](LICENSE)
[![Test Suite](https://img.shields.io/badge/Tests-14%20Passed-brightgreen.svg)]()

A robust, production-grade usage metering and subscription billing engine built with **Node.js, Express, TypeScript, and SQLite / PostgreSQL**, integrated with **Stripe test mode**.

Built for the **FlyRank Backend Internship Capstone**, this engine guarantees:
1. **Exactly-once metering**: Retries with the same `Idempotency-Key` never record duplicate charges or decrement quotas twice.
2. **Boundary-honest quota enforcement**: Accurately handles $N-1$, exactly $N$ (allowed), and $N+1$ (rejected with `429 Too Many Requests`).
3. **Delinquent state handling**: Blocked accounts return `402 Payment Required`.
4. **Deterministic money math**: Zero floating-point decimals. All amounts computed in integer **micro-units** ($1\text{ USD} = 1,000,000\text{ micro-units}$) and integer cents.
5. **AI token pricing**: Nuanced cost tiers where cached input tokens are cheaper and reasoning tokens count as output tokens.
6. **Stripe Test Mode Webhook Sync**: Cryptographically verified (`Stripe-Signature`), deduplicated webhook listener keeping subscriptions in sync.

---

## Architecture Overview

```
Client (SaaS Consumer)
  │
  ├─► POST /generate [Headers: X-Tenant-ID, Idempotency-Key]
  │     │
  │     ├── 1. Check Idempotency Repository (Key + Tenant)
  │     │      └─ If cached: Return stored status & body (No new event)
  │     │
  │     ├── 2. Evaluate Quota (QuotaService)
  │     │      ├─ If status != 'active' ──► HTTP 402 Payment Required
  │     │      ├─ If usage + delta > plan ─► HTTP 429 Too Many Requests
  │     │      └─ In quota ───────────────► Proceed
  │     │
  │     ├── 3. Calculate Token Cost (CostCalculator)
  │     │      └─ integer micro-units: fresh + cached + output + reasoning
  │     │
  │     └── 4. Atomic Transaction:
  │            ├─ Record API Call usage event
  │            ├─ Record AI Token usage event
  │            └─ Store Idempotency Record
  │
  ├─► GET /usage?tenant_id=...
  │     └─ Rollup monthly usage events ──► { used, limit, cost breakdown }
  │
Stripe Webhook Delivery (CLI or Test Mode)
  │
  └─► POST /webhooks/stripe [Header: Stripe-Signature, Raw Body]
        │
        ├── 1. Verify Cryptographic Signature (HMAC SHA-256)
        │      └─ Invalid/Forged ────────► HTTP 400 Bad Request
        │
        ├── 2. Check Deduplication Table (processed_webhooks)
        │      └─ Already processed ─────► HTTP 200 (Replay ignored)
        │
        └── 3. Update Database Subscription:
               ├─ checkout.session.completed ──► Upgrade Tenant Free -> Pro
               ├─ customer.subscription.updated ─► Sync status (active/past_due)
               └─ customer.subscription.deleted ─► Revert Tenant Pro -> Free
```

---

## Subscription Plans & Pricing Constants

### Plans

| Plan | Monthly Fee | API Calls Quota | AI Tokens Quota | Target Audience |
|---|---|---|---|---|
| **Free Tier** | $0.00 / month | **1,000 calls** / month | **100,000 tokens** / month | Free trial & hobby projects |
| **Pro Tier** | $29.00 / month | **50,000 calls** / month | **5,000,000 tokens** / month | Production & scale workloads |

### Pinned AI Token Pricing Rules
- **Fresh Input Tokens**: $0.25 / 1,000,000 tokens (250 micro-units per 1k tokens)
- **Cached Input Tokens**: $0.125 / 1,000,000 tokens (125 micro-units per 1k tokens — **50% discount**)
- **Output Tokens**: $1.00 / 1,000,000 tokens (1,000 micro-units per 1k tokens)
- **Reasoning ("Thinking") Tokens**: $1.00 / 1,000,000 tokens (1,000 micro-units per 1k tokens — **billed at output rate**)
- **Formula**:
$$\text{Cost} = \left\lceil \frac{\text{fresh} \times 250 + \text{cached} \times 125 + (\text{output} + \text{reasoning}) \times 1000}{1000} \right\rceil \text{ micro-units}$$

---

## Quick Start on a Clean Machine

### Prerequisites
- Node.js v20+ (v24.19+ recommended)
- npm v10+

### 1. Clone & Install
```bash
git clone https://github.com/eng-muhammad-hamza/flyrank-capstone-metering-billing.git
cd flyrank-capstone-metering-billing
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
*(Default settings use local SQLite with zero installation or credentials needed).*

### 3. Seed Database
```bash
npm run seed
```
Creates default database tables, indexes, plan definitions, and sample tenants (`tenant_default`, `tenant_pro`, `tenant_quota_test`, `tenant_delinquent`).

### 4. Run Server
```bash
npm start
```
The server starts on `http://localhost:3000`.

### 5. Run Tests
```bash
npm test
```
Executes all 14 unit and integration tests verifying all 5 acceptance probes in < 500ms.

---

## API Surface

### 1. Billable API Action (`POST /generate`)
Executes an AI simulation while recording usage, enforcing quota boundaries, and computing costs.
- **Headers**: `X-Tenant-ID: tenant_default`, `Idempotency-Key: your-uuid`
- **Body**:
```json
{
  "prompt": "Analyze dataset performance",
  "input_tokens": 1000,
  "cached_tokens": 500,
  "output_tokens": 400,
  "reasoning_tokens": 100
}
```
- **Responses**:
  - `200 OK`: Successful billable action recorded.
  - `429 Too Many Requests`: Monthly quota exceeded. Returns `Retry-After: 3600`.
  - `402 Payment Required`: Subscription delinquent (`past_due`, `unpaid`, or `canceled`).
  - `400 Bad Request`: Missing headers or malformed payload.

### 2. Usage Rollup (`GET /usage`)
Retrieves the aggregated billable consumption and costs for the tenant.
- **Query / Header**: `?tenant_id=tenant_default` or `X-Tenant-ID: tenant_default`
- **Response**:
```json
{
  "tenant_id": "tenant_default",
  "plan": { "id": "free", "api_call_quota": 1000, "token_quota": 100000 },
  "subscription_status": "active",
  "used": {
    "api_calls": 12,
    "tokens": { "total": 24000, "input": 12000, "cached_input": 6000, "output": 4800, "reasoning": 1200 }
  },
  "limit": { "api_calls": 1000, "tokens": 100000 },
  "cost": {
    "currency": "usd",
    "total_cents": 1,
    "total_micro_units": 9750
  }
}
```

### 3. Create Stripe Checkout Session (`POST /checkout/session`)
Generates a Stripe Checkout URL for upgrading to the Pro plan.
- **Body**:
```json
{
  "tenant_id": "tenant_default",
  "success_url": "http://localhost:3000/success",
  "cancel_url": "http://localhost:3000/cancel"
}
```

### 4. Stripe Webhook Listener (`POST /webhooks/stripe`)
Listens to Stripe events with HMAC SHA-256 signature verification and replay deduplication.
- **Forward with Stripe CLI**:
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
```
- **Trigger test event**:
```bash
stripe trigger checkout.session.completed
```

---

## Testing & Acceptance Probes Verification

| Probe | Check Description | Verification Method | Status |
|---|---|---|---|
| **PROBE 1** | Exactly-once metering with idempotency key | Automated Vitest in `test/billing_engine.test.ts` | **PASS** |
| **PROBE 2** | Quota boundary honesty ($N=1000 \to 200$, $N=1001 \to 429$) & 402 status | Automated Vitest in `test/billing_engine.test.ts` | **PASS** |
| **PROBE 3** | Stripe checkout webhook flips tenant Free $\to$ Pro and updates `/usage` | Automated Vitest in `test/billing_engine.test.ts` | **PASS** |
| **PROBE 4** | Forged signature rejected with 400; replayed webhook processed once | Automated Vitest in `test/billing_engine.test.ts` | **PASS** |
| **PROBE 5** | AI token pricing rules (cached cheaper, reasoning as output) verified | Automated Vitest in `test/billing_engine.test.ts` | **PASS** |

See [EVIDENCE.md](EVIDENCE.md) for full execution logs and curl transcripts.

---

## Honest Limitations

1. **Simulated AI Engine**: This service focuses on metering, quota enforcement, and money math. It does not invoke live LLM APIs; token counts are provided by caller simulation or synthetic benchmarks.
2. **Stripe Test Mode Only**: Production card processing and live Stripe API keys are deliberately omitted in adherence to $0 capstone rules.
3. **No Complex Multi-currency / Invoicing Tax Engines**: Currencies are fixed to USD; automatic sales tax (e.g. Stripe Tax / Avalara) and VAT reverse charges are out of scope.
