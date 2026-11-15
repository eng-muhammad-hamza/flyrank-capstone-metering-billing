# Usage Metering & Billing Engine — Design Document

## 1. Problem Statement
Modern multi-tenant SaaS products require a robust, fault-tolerant metering and subscription billing engine to accurately track usage, enforce plan quotas before execution, calculate costs (incorporating nuanced AI token pricing categories), and synchronize billing state with Stripe subscriptions. 
In production, distributed networks exhibit retries and out-of-order webhook deliveries. A naive implementation risks double-counting billable actions, granting unauthorized quota access, or drifting from payment provider truth. This system guarantees exactly-once metering semantics, strictly validated quota boundaries (returning HTTP 429 and 402), deterministic integer-based money math, and cryptographically verified webhook synchronization.

---

## 2. Data Model

### `tenants`
- `id` (TEXT, PK): Unique tenant identifier (e.g. `tenant_abc123`).
- `name` (TEXT): Name of tenant organization.
- `email` (TEXT): Tenant billing email.
- `created_at` (TIMESTAMP): Record creation timestamp.

### `plans`
- `id` (TEXT, PK): Plan tier (`free`, `pro`).
- `name` (TEXT): Human-readable name.
- `api_call_quota` (INTEGER): Monthly included API calls (Free: 1,000; Pro: 50,000).
- `token_quota` (INTEGER): Monthly included AI tokens (Free: 100,000; Pro: 5,000,000).
- `base_fee_cents` (INTEGER): Monthly recurring fee in integer cents ($0 vs $2900).
- `currency` (TEXT): `usd`.

### `subscriptions`
- `id` (TEXT, PK): Subscription ID (e.g. `sub_xyz`).
- `tenant_id` (TEXT, FK -> tenants.id, UNIQUE): Tenant ownership.
- `plan_id` (TEXT, FK -> plans.id): Current plan.
- `stripe_customer_id` (TEXT, NULLABLE): Stripe Customer ID.
- `stripe_subscription_id` (TEXT, NULLABLE, UNIQUE): Stripe Subscription ID.
- `status` (TEXT): `active`, `past_due`, `canceled`, `unpaid`.
- `current_period_start` (TIMESTAMP): Billing cycle start.
- `current_period_end` (TIMESTAMP): Billing cycle end.
- `updated_at` (TIMESTAMP): Last state sync timestamp.

### `usage_events`
- `id` (TEXT, PK): Event identifier (e.g. `evt_...`).
- `tenant_id` (TEXT, FK -> tenants.id, INDEX): Tenant attribution.
- `usage_type` (TEXT): `api_call` or `ai_token`.
- `quantity` (INTEGER): Primary billable count.
- `input_tokens` (INTEGER): Fresh prompt input tokens.
- `cached_tokens` (INTEGER): Cached input tokens (discounted).
- `output_tokens` (INTEGER): Generated output tokens.
- `reasoning_tokens` (INTEGER): Internal reasoning tokens (billed at output rate).
- `cost_micro_units` (INTEGER): Calculated cost in micro-dollars (1 USD = 1,000,000 micro-units).
- `idempotency_key` (TEXT, NULLABLE): Client idempotency key.
- `timestamp` (TIMESTAMP, INDEX): Event creation timestamp.

### `idempotency_records`
- `idempotency_key` (TEXT, PK): Unique idempotency key.
- `tenant_id` (TEXT, INDEX): Scoped tenant ID.
- `request_hash` (TEXT): SHA256 of request payload for collision detection.
- `response_status` (INTEGER): Cached HTTP status code (e.g. 200).
- `response_body` (TEXT): Cached JSON response payload.
- `created_at` (TIMESTAMP): Time of execution.

### `processed_webhooks`
- `event_id` (TEXT, PK): Stripe Event ID (e.g. `evt_stripe123`).
- `event_type` (TEXT): Stripe event type (e.g. `checkout.session.completed`).
- `processed_at` (TIMESTAMP): Deduplication timestamp.
- `status` (TEXT): Processing outcome (`success`, `ignored`).

---

## 3. API Surface

| Endpoint | Method | Purpose & Contract |
|---|---|---|
| `/health` | `GET` | Health check & system status. Returns `{ status: "ok" }`. |
| `/generate` | `POST` | Dummy billable AI execution. Requires `X-Tenant-ID` and optional `Idempotency-Key` header. Checks quota $\rightarrow$ records usage $\rightarrow$ calculates cost $\rightarrow$ returns simulated response. |
| `/usage` | `GET` | Current billing period usage rollup. Requires `X-Tenant-ID` header or `?tenant_id=...` parameter. Returns used quantities, plan limits, and accrued costs. |
| `/checkout/session` | `POST` | Creates Stripe Checkout Session for tenant plan upgrade to Pro. Body: `{ tenant_id, success_url, cancel_url }`. Returns `{ checkout_url, session_id }`. |
| `/webhooks/stripe` | `POST` | Stripe webhook ingest. Validates `Stripe-Signature` using raw body. Deduplicates event IDs. Dispatches subscription state updates. |

---

## 4. Layer Sketch

```
                        +--------------------------+
                        |  Incoming HTTP Requests  |
                        +--------------------------+
                                     |
                                     v
                        +--------------------------+
                        |  Middleware & Validation |
                        |  - Raw Body for Stripe   |
                        |  - Zod Request Schema    |
                        |  - Tenant ID Header/Auth |
                        +--------------------------+
                                     |
                                     v
                        +--------------------------+
                        |       Controllers        |
                        | (Metering, Usage, Stripe)|
                        +--------------------------+
                                     |
         +---------------------------+---------------------------+
         |                           |                           |
         v                           v                           v
+-----------------+         +-----------------+         +-----------------+
|  QuotaService   |         |  MeterService   |         |  StripeService  |
| - Boundary check|         | - Idempotency   |         | - Webhook verify|
| - 429/402 codes |         | - Deduplication |         | - Plan sync     |
+-----------------+         | - Cost compute  |         +-----------------+
         |                  +-----------------+                  |
         +---------------------------+---------------------------+
                                     |
                                     v
                        +--------------------------+
                        |   Repository Layer       |
                        |   - Atomic Transactions  |
                        |   - SQLite / PostgreSQL  |
                        +--------------------------+
                                     |
                                     v
                        +--------------------------+
                        |      Background Jobs     |
                        | - Usage Rollup/Aggregate |
                        | - Stripe Reconciliation  |
                        +--------------------------+
```

---

## 5. Idempotency Strategy
1. The client supplies an `Idempotency-Key` header with each mutating billable request (`POST /generate`).
2. Within an atomic database transaction:
   - Query `idempotency_records` for `(tenant_id, idempotency_key)`.
   - If present: verify payload consistency (SHA256 request hash). Return the previously stored `response_status` and `response_body` immediately. No new usage event is inserted, and no quota is decremented.
   - If absent: evaluate quota $\rightarrow$ simulate workload $\rightarrow$ compute token breakdown & cost $\rightarrow$ insert `usage_events` row $\rightarrow$ insert `idempotency_records` row $\rightarrow$ commit transaction.
3. If an unhandled failure occurs mid-processing, the transaction rolls back, leaving no half-recorded usage.

---

## 6. Token Pricing Rules & Money Math
Floating-point numbers are prohibited. Costs are tracked as integer **micro-units** ($1\text{ USD} = 1,000,000\text{ micro-units}$, $1\text{ cent} = 10,000\text{ micro-units}$) and reported in integer cents with micro-unit precision:
- **Base API Calls**: Included in base subscription tier up to quota limit ($0 additional per call in-quota).
- **AI Tokens**:
  - Fresh Input Tokens: $0.25 / 1,000,000 tokens ($250 micro-units per 1,000 tokens).
  - Cached Input Tokens: $0.125 / 1,000,000 tokens ($125 micro-units per 1,000 tokens — 50% discount).
  - Output Tokens: $1.00 / 1,000,000 tokens ($1,000 micro-units per 1,000 tokens).
  - Reasoning ("Thinking") Tokens: Billed at the output token rate ($1,000 micro-units per 1,000 tokens).
- **Cost Calculation Formula**:
$$\text{Cost} = \left\lceil \frac{\text{input} \times 250 + \text{cached} \times 125 + (\text{output} + \text{reasoning}) \times 1000}{1000} \right\rceil \text{ micro-units}$$

---

## 7. Quota Enforcement Logic & Status Codes
Before executing a billable request:
1. Lookup the tenant's current active subscription and associated plan.
2. If subscription status is `unpaid`, `past_due`, or `canceled`: return **HTTP 402 Payment Required** with code `PAYMENT_REQUIRED` and upgrade checkout link.
3. Query the aggregated usage in the current billing period:
   $$\text{Used API Calls} = \sum \text{api\_calls}, \quad \text{Used Tokens} = \sum \text{total\_tokens}$$
4. Evaluate requested delta:
   - If $\text{Used API Calls} + 1 > \text{Plan Quota}$: reject with **HTTP 429 Too Many Requests**, payload detailing `quota_exceeded: "api_calls"`, current usage, limit, and `Retry-After: 3600` header.
   - If $\text{Used Tokens} + \text{Requested Tokens} > \text{Plan Token Quota}$: reject with **HTTP 429 Too Many Requests**, payload detailing `quota_exceeded: "ai_tokens"`, current usage, limit, and `Retry-After: 3600` header.
5. Exact boundary behavior:
   - When used is $N - 1$, a request for 1 unit succeeds (reaching exactly $N$).
   - Subsequent requests when used $\ge N$ fail with HTTP 429.

---

## 8. Stripe Subscription Lifecycle
1. **Checkout**: Backend creates a Stripe Checkout session with `client_reference_id = tenant_id` and metadata `tenant_id`.
2. **Webhook Verification**: Signature verified using `stripe.webhooks.constructEvent()` against `STRIPE_WEBHOOK_SECRET`. Invalid signature immediately returns **HTTP 400**.
3. **Webhook Deduplication**: Event ID recorded in `processed_webhooks`. Duplicate events immediately return **HTTP 200** without re-executing logic.
4. **Lifecycle Events**:
   - `checkout.session.completed`: Upgrades tenant subscription to `pro` with status `active`.
   - `customer.subscription.updated`: Syncs status changes (`active`, `past_due`).
   - `customer.subscription.deleted`: Reverts tenant subscription to `free` plan.

---

## 9. Explicit Non-Goals
1. **Real Payment Execution**: Production payment cards, live Stripe API keys, and real-money transactions are strictly out of scope; system operates exclusively in Stripe Test Mode.
2. **Real LLM Model Inference**: System meters token units and simulates AI responses without calling OpenAI/Anthropic/Gemini APIs; no AI API keys required.
3. **Complex Invoicing and Sales Tax**: Invoicing, credit memos, tax calculations (Avalara/Stripe Tax), and multi-currency exchange rate conversions are out of scope.
