import { IDatabase } from '../database';
import {
  Tenant,
  Plan,
  Subscription,
  UsageEvent,
  IdempotencyRecord,
  ProcessedWebhook,
  UsageType,
} from '../models/types';

export class TenantRepository {
  constructor(private db: IDatabase) {}

  async findById(id: string): Promise<Tenant | null> {
    return this.db.queryOne<Tenant>('SELECT * FROM tenants WHERE id = ?', [id]);
  }

  async create(tenant: { id: string; name: string; email: string }): Promise<Tenant> {
    await this.db.execute(
      'INSERT INTO tenants (id, name, email) VALUES (?, ?, ?)',
      [tenant.id, tenant.name, tenant.email]
    );
    const created = await this.findById(tenant.id);
    return created!;
  }

  async list(): Promise<Tenant[]> {
    return this.db.query<Tenant>('SELECT * FROM tenants ORDER BY created_at ASC');
  }
}

export class PlanRepository {
  constructor(private db: IDatabase) {}

  async findById(id: string): Promise<Plan | null> {
    return this.db.queryOne<Plan>('SELECT * FROM plans WHERE id = ?', [id]);
  }

  async upsert(plan: Plan): Promise<void> {
    const existing = await this.findById(plan.id);
    if (existing) {
      await this.db.execute(
        'UPDATE plans SET name = ?, monthly_fee_cents = ?, api_call_quota = ?, token_quota = ? WHERE id = ?',
        [plan.name, plan.monthly_fee_cents, plan.api_call_quota, plan.token_quota, plan.id]
      );
    } else {
      await this.db.execute(
        'INSERT INTO plans (id, name, monthly_fee_cents, api_call_quota, token_quota) VALUES (?, ?, ?, ?, ?)',
        [plan.id, plan.name, plan.monthly_fee_cents, plan.api_call_quota, plan.token_quota]
      );
    }
  }

  async list(): Promise<Plan[]> {
    return this.db.query<Plan>('SELECT * FROM plans');
  }
}

export class SubscriptionRepository {
  constructor(private db: IDatabase) {}

  async findByTenantId(tenantId: string): Promise<Subscription | null> {
    return this.db.queryOne<Subscription>(
      'SELECT * FROM subscriptions WHERE tenant_id = ?',
      [tenantId]
    );
  }

  async findByStripeSubscriptionId(stripeSubId: string): Promise<Subscription | null> {
    return this.db.queryOne<Subscription>(
      'SELECT * FROM subscriptions WHERE stripe_subscription_id = ?',
      [stripeSubId]
    );
  }

  async upsert(subscription: {
    id: string;
    tenant_id: string;
    plan_id: 'free' | 'pro';
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
    status: string;
    current_period_start: string;
    current_period_end: string;
  }): Promise<Subscription> {
    const existing = await this.findByTenantId(subscription.tenant_id);
    if (existing) {
      await this.db.execute(
        `UPDATE subscriptions 
         SET plan_id = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), 
             stripe_subscription_id = COALESCE(?, stripe_subscription_id),
             status = ?, current_period_start = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ?`,
        [
          subscription.plan_id,
          subscription.stripe_customer_id || null,
          subscription.stripe_subscription_id || null,
          subscription.status,
          subscription.current_period_start,
          subscription.current_period_end,
          subscription.tenant_id,
        ]
      );
    } else {
      await this.db.execute(
        `INSERT INTO subscriptions 
         (id, tenant_id, plan_id, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          subscription.id,
          subscription.tenant_id,
          subscription.plan_id,
          subscription.stripe_customer_id || null,
          subscription.stripe_subscription_id || null,
          subscription.status,
          subscription.current_period_start,
          subscription.current_period_end,
        ]
      );
    }
    const updated = await this.findByTenantId(subscription.tenant_id);
    return updated!;
  }
}

export class UsageRepository {
  constructor(private db: IDatabase) {}

  async record(event: {
    id: string;
    tenant_id: string;
    usage_type: UsageType;
    quantity: number;
    input_tokens?: number;
    cached_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    cost_micro_units: number;
    idempotency_key?: string | null;
    timestamp?: string;
  }): Promise<UsageEvent> {
    const timestamp = event.timestamp || new Date().toISOString();
    await this.db.execute(
      `INSERT INTO usage_events 
       (id, tenant_id, usage_type, quantity, input_tokens, cached_tokens, output_tokens, reasoning_tokens, cost_micro_units, idempotency_key, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.tenant_id,
        event.usage_type,
        event.quantity,
        event.input_tokens || 0,
        event.cached_tokens || 0,
        event.output_tokens || 0,
        event.reasoning_tokens || 0,
        event.cost_micro_units,
        event.idempotency_key || null,
        timestamp,
      ]
    );

    const created = await this.db.queryOne<UsageEvent>(
      'SELECT * FROM usage_events WHERE id = ?',
      [event.id]
    );
    return created!;
  }

  async getAggregatedUsage(
    tenantId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<{
    api_calls: number;
    total_tokens: number;
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    total_cost_micro_units: number;
  }> {
    const row = await this.db.queryOne<{
      api_calls: number;
      total_tokens: number;
      input_tokens: number;
      cached_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      total_cost_micro_units: number;
    }>(
      `SELECT 
         COALESCE(SUM(CASE WHEN usage_type = 'api_call' THEN quantity ELSE 0 END), 0) AS api_calls,
         COALESCE(SUM(CASE WHEN usage_type = 'ai_token' THEN quantity ELSE 0 END), 0) AS total_tokens,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(cost_micro_units), 0) AS total_cost_micro_units
       FROM usage_events
       WHERE tenant_id = ? 
         AND (datetime(timestamp) >= datetime(?) OR timestamp >= ?)
         AND (datetime(timestamp) <= datetime(?) OR timestamp <= ?)`,
      [tenantId, periodStart, periodStart, periodEnd, periodEnd]
    );

    return {
      api_calls: Number(row?.api_calls || 0),
      total_tokens: Number(row?.total_tokens || 0),
      input_tokens: Number(row?.input_tokens || 0),
      cached_tokens: Number(row?.cached_tokens || 0),
      output_tokens: Number(row?.output_tokens || 0),
      reasoning_tokens: Number(row?.reasoning_tokens || 0),
      total_cost_micro_units: Number(row?.total_cost_micro_units || 0),
    };
  }

  async countEventsByTenant(tenantId: string): Promise<number> {
    const res = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = ?',
      [tenantId]
    );
    return Number(res?.count || 0);
  }
}

export class IdempotencyRepository {
  constructor(private db: IDatabase) {}

  async find(key: string, tenantId: string): Promise<IdempotencyRecord | null> {
    return this.db.queryOne<IdempotencyRecord>(
      'SELECT * FROM idempotency_records WHERE idempotency_key = ? AND tenant_id = ?',
      [key, tenantId]
    );
  }

  async save(record: {
    idempotency_key: string;
    tenant_id: string;
    request_hash: string;
    response_status: number;
    response_body: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO idempotency_records 
       (idempotency_key, tenant_id, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?)`,
      [
        record.idempotency_key,
        record.tenant_id,
        record.request_hash,
        record.response_status,
        record.response_body,
      ]
    );
  }
}

export class WebhookRepository {
  constructor(private db: IDatabase) {}

  async isProcessed(eventId: string): Promise<boolean> {
    const row = await this.db.queryOne<ProcessedWebhook>(
      'SELECT event_id FROM processed_webhooks WHERE event_id = ?',
      [eventId]
    );
    return row !== null;
  }

  async markProcessed(eventId: string, eventType: string, status: string = 'success'): Promise<void> {
    await this.db.execute(
      'INSERT INTO processed_webhooks (event_id, event_type, status) VALUES (?, ?, ?)',
      [eventId, eventType, status]
    );
  }
}
