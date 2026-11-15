export interface Tenant {
  id: string;
  name: string;
  email: string;
  created_at: string;
}

export interface Plan {
  id: 'free' | 'pro';
  name: string;
  monthly_fee_cents: number;
  api_call_quota: number;
  token_quota: number;
}

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'unpaid';

export interface Subscription {
  id: string;
  tenant_id: string;
  plan_id: 'free' | 'pro';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: SubscriptionStatus;
  current_period_start: string;
  current_period_end: string;
  updated_at: string;
}

export type UsageType = 'api_call' | 'ai_token';

export interface UsageEvent {
  id: string;
  tenant_id: string;
  usage_type: UsageType;
  quantity: number;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_micro_units: number;
  idempotency_key: string | null;
  timestamp: string;
}

export interface IdempotencyRecord {
  idempotency_key: string;
  tenant_id: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: string;
}

export interface ProcessedWebhook {
  event_id: string;
  event_type: string;
  processed_at: string;
  status: string;
}

export interface UsageRollup {
  tenant_id: string;
  plan: Plan;
  subscription_status: SubscriptionStatus;
  billing_period: {
    start: string;
    end: string;
  };
  used: {
    api_calls: number;
    tokens: {
      total: number;
      input: number;
      cached_input: number;
      output: number;
      reasoning: number;
    };
  };
  limit: {
    api_calls: number;
    tokens: number;
  };
  cost: {
    currency: string;
    total_cents: number;
    total_micro_units: number;
    breakdown: {
      api_calls_micro_units: number;
      input_tokens_micro_units: number;
      cached_input_tokens_micro_units: number;
      output_tokens_micro_units: number;
      reasoning_tokens_micro_units: number;
    };
  };
}
