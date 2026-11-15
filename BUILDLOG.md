# BUILDLOG.md — AI-Usage and Implementation Log

## Overview
This log documents the design, implementation, AI-assisted development, corrections, and engineering decisions throughout the build of the **Usage Metering & Billing Engine** capstone.

---

## Phase 1: Architecture & Design
- **What was planned**: Multi-tenant database schema, Stripe webhook and checkout flows, integer micro-unit currency calculation, quota boundary checking, and idempotency key handling.
- **Where AI helped**: Drafted the initial multi-tenant schema and identified edge-case status codes (HTTP 402 for unpaid/past_due subscriptions vs. HTTP 429 for quota-exceeded requests).
- **Where AI was wrong / What was adjusted**:
  - *Initial proposal*: AI initially suggested storing costs as floating-point decimals (`0.00025` per token).
  - *Correction*: Rejected floating-point storage due to IEEE-754 precision inaccuracies. Migrated money math strictly to integer micro-units ($1\text{ USD} = 1,000,000\text{ micro-units}$) and integer cents.
  - *Initial proposal*: AI treated reasoning tokens as a separate free classification.
  - *Correction*: Per the capstone brief and real-world billing specs (e.g. Gemini/OpenAI reasoning tokens), reasoning tokens must be billed as output tokens at the higher output rate.

---

## Phase 2: Core Metering & Quotas
- **What was built**: `MeterService`, `QuotaService`, `CostCalculator`, atomic database transactions, idempotency table.
- **Where AI helped**: Generated Zod schemas for input validation and TypeScript types for usage events.
- **Where AI was wrong / What was adjusted**:
  - *Initial proposal*: Checking quota after recording usage.
  - *Correction*: Quota MUST be checked before recording billable action to avoid race conditions and over-allocation.
  - *Boundary verification*: Ensured exact boundary condition: at 1,000 of 1,000 requests, the 1,000th request succeeds; the 1,001st request returns HTTP 429 with clear explanation and `Retry-After` header.

---

## Phase 3: Stripe Integration
- **What was built**: Test-mode Stripe checkout session creation, cryptographically signed webhook endpoint (`/webhooks/stripe`), event deduplication table, and subscription state sync.
- **Where AI helped**: Outlined the Stripe webhook signature verification boilerplates.
- **Where AI was wrong / What was adjusted**:
  - *Initial proposal*: Parsing JSON body before signature verification.
  - *Correction*: Stripe webhook signature verification requires the raw, unparsed request payload buffer. Configured `express.raw({ type: 'application/json' })` exclusively for the webhook route to prevent hash mismatches.
  - *Deduplication*: Added persistent `processed_webhooks` table to guarantee idempotency under webhook replays (`stripe trigger` or retries).

---

## Phase 4: Cost Rollup & Verification
- **What was built**: Token pricing formulas with cached-input discount and reasoning token rules, background rollup and reconciliation jobs.
- **Evidence generation**: Executed automated probes matching PROBE 1 to PROBE 5. Documented verified outputs in `EVIDENCE.md`.
