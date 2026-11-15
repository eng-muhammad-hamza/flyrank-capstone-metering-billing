import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { createApp } from '../src/app';
import { db } from '../src/database';
import { seed } from '../src/scripts/seed';
import { config } from '../src/config';
import { CostCalculator } from '../src/services/costCalculator';
import { PRICING_CONSTANTS } from '../src/config/pricing';
import { BackgroundJobs } from '../src/jobs';

function generateStripeSignature(payload: string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

describe('Usage Metering & Billing Engine - Complete Acceptance Suite', () => {
  let app: any;

  beforeAll(async () => {
    await db.init();
    await seed();
    app = createApp();
  });

  afterAll(async () => {
    await db.close();
  });

  // -----------------------------------------------------------------------------------
  // PROBE 1: Idempotency & Exactly-Once Metering
  // -----------------------------------------------------------------------------------
  describe('PROBE 1 — Exactly-once metering with idempotency key', () => {
    it('sends the same billable request twice with one idempotency key -> exactly 1 usage event, 2nd response mirrors 1st', async () => {
      const idempotencyKey = `idemp-probe1-${Date.now()}`;
      const tenantId = 'tenant_default';

      // Count events before
      const countBeforeRes = await db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ? AND idempotency_key = ?',
        [tenantId, idempotencyKey]
      );
      expect(Number(countBeforeRes?.count || 0)).toBe(0);

      const payload = {
        prompt: 'Generate an analysis report',
        input_tokens: 1000,
        cached_tokens: 500,
        output_tokens: 400,
        reasoning_tokens: 100,
      };

      // Request 1
      const res1 = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res1.body.status).toBe('success');
      expect(res1.body.idempotency_key).toBe(idempotencyKey);
      expect(res1.headers['idempotency-replayed']).toBeUndefined();

      // Request 2 (Retry with exact same idempotency key)
      const res2 = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.headers['idempotency-replayed']).toBe('true');
      expect(res2.body).toEqual(res1.body);

      // Verify DB: exactly 1 API call event and 1 Token event were recorded (total 2 rows for this key, NEVER 4)
      const countAfterRes = await db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ? AND idempotency_key = ?',
        [tenantId, idempotencyKey]
      );
      expect(Number(countAfterRes?.count || 0)).toBe(2); // 1 api_call row + 1 ai_token row
    });
  });

  // -----------------------------------------------------------------------------------
  // PROBE 2: Quota Enforcement & Boundary Honesty
  // -----------------------------------------------------------------------------------
  describe('PROBE 2 — Quota boundary honesty and 429/402 status codes', () => {
    it('drives a tenant to its exact quota limit: boundary succeeds, subsequent request returns 429', async () => {
      const tenantId = 'tenant_quota_test';

      // Free plan limit is 1,000 calls.
      // Reset usage events for this tenant
      await db.execute('DELETE FROM usage_events WHERE tenant_id = ?', [tenantId]);

      // Seed 999 events directly with quantity=999
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO usage_events (id, tenant_id, usage_type, quantity, cost_micro_units, timestamp)
         VALUES ('evt_test_fill_999', ?, 'api_call', 999, 0, ?)`,
        [tenantId, now]
      );

      // Verify current usage is exactly 999
      const usage999 = await request(app)
        .get('/usage')
        .set('X-Tenant-ID', tenantId);
      expect(usage999.status).toBe(200);
      expect(usage999.body.used.api_calls).toBe(999);
      expect(usage999.body.limit.api_calls).toBe(1000);

      // Exactly at boundary: 1000th call should SUCCEED
      const resBoundary = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .send({ input_tokens: 10, output_tokens: 10 });

      expect(resBoundary.status).toBe(200);
      expect(resBoundary.body.status).toBe('success');

      // Now usage is 1000 of 1000
      const usage1000 = await request(app)
        .get('/usage')
        .set('X-Tenant-ID', tenantId);
      expect(usage1000.body.used.api_calls).toBe(1000);

      // 1001st call MUST return 429 Too Many Requests
      const resExceeded = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .send({ input_tokens: 10, output_tokens: 10 });

      expect(resExceeded.status).toBe(429);
      expect(resExceeded.headers['retry-after']).toBe('3600');
      expect(resExceeded.body.error).toBe('QUOTA_EXCEEDED');
      expect(resExceeded.body.quota_type).toBe('api_calls');
      expect(resExceeded.body.current_usage).toBe(1000);
      expect(resExceeded.body.limit).toBe(1000);
      expect(resExceeded.body.message).toMatch(/Monthly API call quota/);
    });

    it('blocks request with 429 when AI token quota is exceeded', async () => {
      const tenantId = 'tenant_quota_test';
      // Reset usage events
      await db.execute('DELETE FROM usage_events WHERE tenant_id = ?', [tenantId]);

      // Free plan limit is 100,000 tokens. Request 100,001 tokens
      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .send({
          input_tokens: 80000,
          output_tokens: 20001,
        });

      expect(res.status).toBe(429);
      expect(res.body.error).toBe('QUOTA_EXCEEDED');
      expect(res.body.quota_type).toBe('ai_tokens');
      expect(res.body.limit).toBe(100000);
    });

    it('returns 402 Payment Required when subscription is past_due or canceled', async () => {
      const delinquentTenantId = 'tenant_delinquent';

      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', delinquentTenantId)
        .send({ input_tokens: 10, output_tokens: 10 });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('PAYMENT_REQUIRED');
      expect(res.body.message).toMatch(/An active subscription is required/);
    });
  });

  // -----------------------------------------------------------------------------------
  // PROBE 3: Stripe Checkout & Webhook Synchronization
  // -----------------------------------------------------------------------------------
  describe('PROBE 3 — Stripe test Checkout webhook flips tenant Free -> Pro and updates /usage', () => {
    it('processes checkout.session.completed webhook to upgrade tenant to Pro', async () => {
      const tenantId = 'tenant_default';

      // Reset subscription to Free plan first
      const now = new Date();
      const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      await db.execute(
        `UPDATE subscriptions SET plan_id = 'free', status = 'active', current_period_start = ?, current_period_end = ? WHERE tenant_id = ?`,
        [now.toISOString(), oneMonthLater.toISOString(), tenantId]
      );

      // Confirm tenant starts on Free tier (limit 1,000 calls, 100k tokens)
      const usageBefore = await request(app).get(`/usage?tenant_id=${tenantId}`);
      expect(usageBefore.status).toBe(200);
      expect(usageBefore.body.plan.id).toBe('free');
      expect(usageBefore.body.limit.api_calls).toBe(1000);
      expect(usageBefore.body.limit.tokens).toBe(100000);

      // Construct Stripe checkout.session.completed event
      const stripeEvent = {
        id: `evt_stripe_test_${Date.now()}`,
        object: 'event',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: `cs_test_${Date.now()}`,
            client_reference_id: tenantId,
            customer: 'cus_test_123',
            subscription: 'sub_test_pro_123',
            payment_status: 'paid',
            metadata: {
              tenant_id: tenantId,
            },
          },
        },
      };

      const payloadString = JSON.stringify(stripeEvent);
      const signature = generateStripeSignature(payloadString, config.stripe.webhookSecret);

      const webhookRes = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payloadString);

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.received).toBe(true);
      expect(webhookRes.body.event_type).toBe('checkout.session.completed');
      expect(webhookRes.body.processed).toBe(true);

      // Check /usage to verify limits flipped to Pro (50k calls, 5M tokens)
      const usageAfter = await request(app).get(`/usage?tenant_id=${tenantId}`);
      expect(usageAfter.status).toBe(200);
      expect(usageAfter.body.plan.id).toBe('pro');
      expect(usageAfter.body.limit.api_calls).toBe(50000);
      expect(usageAfter.body.limit.tokens).toBe(5000000);
    });

    it('processes customer.subscription.deleted to revert tenant to Free plan', async () => {
      const tenantId = 'tenant_default';
      const stripeSubId = 'sub_test_pro_123';

      const stripeEvent = {
        id: `evt_stripe_del_${Date.now()}`,
        object: 'event',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            id: stripeSubId,
            customer: 'cus_test_123',
            status: 'canceled',
          },
        },
      };

      const payloadString = JSON.stringify(stripeEvent);
      const signature = generateStripeSignature(payloadString, config.stripe.webhookSecret);

      const webhookRes = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payloadString);

      expect(webhookRes.status).toBe(200);
      expect(webhookRes.body.processed).toBe(true);

      // Check /usage to verify tenant reverted to Free plan
      const usageAfter = await request(app).get(`/usage?tenant_id=${tenantId}`);
      expect(usageAfter.body.plan.id).toBe('free');
      expect(usageAfter.body.limit.api_calls).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------------------
  // PROBE 4: Webhook Security — Forgery & Deduplication
  // -----------------------------------------------------------------------------------
  describe('PROBE 4 — Forged webhook returns 400; replayed event processed once', () => {
    it('rejects forged webhook with bad signature with HTTP 400 without state changes', async () => {
      const payloadString = JSON.stringify({
        id: 'evt_forged_attack_1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_forged' } },
      });

      const badSignature = 't=123456789,v1=bad_forged_hex_signature';

      const res = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', badSignature)
        .send(payloadString);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_SIGNATURE');

      // Verify event was not recorded in processed_webhooks
      const checkDb = await db.queryOne(
        'SELECT * FROM processed_webhooks WHERE event_id = ?',
        ['evt_forged_attack_1']
      );
      expect(checkDb).toBeNull();
    });

    it('deduplicates replayed webhook event: processed once, replay ignored', async () => {
      const eventId = `evt_replay_test_${Date.now()}`;
      const stripeEvent = {
        id: eventId,
        object: 'event',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_pro_123',
            status: 'active',
          },
        },
      };

      const payloadString = JSON.stringify(stripeEvent);
      const signature = generateStripeSignature(payloadString, config.stripe.webhookSecret);

      // First delivery
      const res1 = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payloadString);

      expect(res1.status).toBe(200);
      expect(res1.body.processed).toBe(true);

      // Replayed delivery (e.g. network retry or Stripe retry)
      const res2 = await request(app)
        .post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(payloadString);

      expect(res2.status).toBe(200);
      expect(res2.body.processed).toBe(false);
      expect(res2.body.reason).toBe('duplicate_event');

      // Verify DB row exists exactly once
      const countRes = await db.queryOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM processed_webhooks WHERE event_id = ?',
        [eventId]
      );
      expect(Number(countRes?.count || 0)).toBe(1);
    });
  });

  // -----------------------------------------------------------------------------------
  // PROBE 5: AI Token Pricing Rules & Money Math
  // -----------------------------------------------------------------------------------
  describe('PROBE 5 — AI token pricing rules (cached input cheaper, reasoning as output)', () => {
    it('calculates correct itemized costs according to pinned pricing constants', () => {
      // 10,000 fresh input tokens:
      // Rate: 250 micro-units / 1k => 10 * 250 = 2,500 micro-units
      //
      // 10,000 cached input tokens (cheaper, 50% discount):
      // Rate: 125 micro-units / 1k => 10 * 125 = 1,250 micro-units
      //
      // 5,000 output tokens:
      // Rate: 1,000 micro-units / 1k => 5 * 1000 = 5,000 micro-units
      //
      // 2,000 reasoning tokens (billed as output):
      // Rate: 1,000 micro-units / 1k => 2 * 1000 = 2,000 micro-units
      //
      // Total Micro-units: 2500 + 1250 + 5000 + 2000 = 10,750 micro-units ($0.01075)
      // Total Cents: Math.ceil(10750 / 10000) = 2 cents

      const cost = CostCalculator.calculateTokenCost({
        input_tokens: 10000,
        cached_tokens: 10000,
        output_tokens: 5000,
        reasoning_tokens: 2000,
      });

      expect(cost.breakdown.fresh_input_cost_micro_units).toBe(2500);
      expect(cost.breakdown.cached_input_cost_micro_units).toBe(1250);
      expect(cost.breakdown.output_cost_micro_units).toBe(5000);
      expect(cost.breakdown.reasoning_cost_micro_units).toBe(2000);

      expect(cost.cost_micro_units).toBe(10750);
      expect(cost.cost_cents).toBe(2);
      expect(cost.total_tokens).toBe(27000);

      // Verify that cached input tokens are strictly cheaper than fresh input tokens
      expect(cost.breakdown.cached_input_cost_micro_units).toBeLessThan(
        cost.breakdown.fresh_input_cost_micro_units
      );

      // Verify that reasoning tokens are billed at exactly the output rate
      const reasoningCostPerToken =
        cost.breakdown.reasoning_cost_micro_units / cost.breakdown.reasoning_tokens;
      const outputCostPerToken =
        cost.breakdown.output_cost_micro_units / cost.breakdown.output_tokens;
      expect(reasoningCostPerToken).toBe(outputCostPerToken);
    });

    it('matches /usage rollup endpoint totals with pinned pricing constants', async () => {
      const tenantId = 'tenant_pro';

      // Clear existing usage for tenant_pro
      await db.execute('DELETE FROM usage_events WHERE tenant_id = ?', [tenantId]);

      // Generate a billable action with specific token counts
      const res = await request(app)
        .post('/generate')
        .set('X-Tenant-ID', tenantId)
        .send({
          input_tokens: 20000,     // 20 * 250 = 5,000 micro-units
          cached_tokens: 10000,    // 10 * 125 = 1,250 micro-units
          output_tokens: 4000,     // 4 * 1000 = 4,000 micro-units
          reasoning_tokens: 1000,  // 1 * 1000 = 1,000 micro-units
        });

      expect(res.status).toBe(200);
      expect(res.body.cost.micro_units).toBe(11250); // 5000 + 1250 + 4000 + 1000

      // Read GET /usage and verify exact match
      const usageRes = await request(app).get(`/usage?tenant_id=${tenantId}`);
      expect(usageRes.status).toBe(200);
      expect(usageRes.body.used.api_calls).toBe(1);
      expect(usageRes.body.used.tokens.input).toBe(20000);
      expect(usageRes.body.used.tokens.cached_input).toBe(10000);
      expect(usageRes.body.used.tokens.output).toBe(4000);
      expect(usageRes.body.used.tokens.reasoning).toBe(1000);
      expect(usageRes.body.cost.total_micro_units).toBe(11250);
      expect(usageRes.body.cost.breakdown.cached_input_tokens_micro_units).toBe(1250);
      expect(usageRes.body.cost.breakdown.reasoning_tokens_micro_units).toBe(1000);
    });
  });

  // -----------------------------------------------------------------------------------
  // Shared Requirement 2: Boundary Validation
  // -----------------------------------------------------------------------------------
  describe('Boundary Validation & Clean 4xx responses', () => {
    it('returns 400 on missing tenant ID without throwing 500', async () => {
      const res = await request(app).post('/generate').send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('BAD_REQUEST');
    });

    it('returns 404 on unknown route with clean JSON', async () => {
      const res = await request(app).get('/unknown-endpoint');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    it('returns 200 on /health and /plans endpoints', async () => {
      const healthRes = await request(app).get('/health');
      expect(healthRes.status).toBe(200);
      expect(healthRes.body.status).toBe('ok');

      const plansRes = await request(app).get('/plans');
      expect(plansRes.status).toBe(200);
      expect(plansRes.body.plans.free.apiCallQuota).toBe(1000);
      expect(plansRes.body.plans.pro.apiCallQuota).toBe(50000);
    });
  });

  // -----------------------------------------------------------------------------------
  // Shared Requirement 3: Background Jobs
  // -----------------------------------------------------------------------------------
  describe('Background Jobs with Retries and Alerts', () => {
    it('runs usage aggregation background job successfully', async () => {
      const jobs = new BackgroundJobs();
      const result = await jobs.runUsageRollupJob(3);
      expect(result.processedTenants).toBeGreaterThan(0);
      expect(result.errors.length).toBe(0);
    });
  });
});
