// Pinned Pricing and Quota Constants
// All money is stored and calculated as integers:
// - Micro-units: 1 USD = 1,000,000 micro-units, 1 cent = 10,000 micro-units
// - Cents: integer cents (for subscriptions and rounded displays)

export interface PlanConfig {
  id: 'free' | 'pro';
  name: string;
  monthlyFeeCents: number;
  apiCallQuota: number;
  tokenQuota: number;
}

export const PLANS: Record<'free' | 'pro', PlanConfig> = {
  free: {
    id: 'free',
    name: 'Free Tier',
    monthlyFeeCents: 0,
    apiCallQuota: 1000,          // 1,000 calls / month
    tokenQuota: 100000,          // 100k tokens / month
  },
  pro: {
    id: 'pro',
    name: 'Pro Tier',
    monthlyFeeCents: 2900,       // $29.00 / month
    apiCallQuota: 50000,         // 50,000 calls / month
    tokenQuota: 5000000,         // 5M tokens / month
  },
};

export const PRICING_CONSTANTS = {
  // AI Token pricing per 1,000 tokens in micro-units ($1 = 1,000,000 micro-units)
  // Fresh Input tokens: $0.25 / 1,000,000 tokens => 250 micro-units per 1k tokens
  INPUT_TOKEN_MICRO_PER_1K: 250,

  // Cached Input tokens: $0.125 / 1,000,000 tokens (50% cheaper) => 125 micro-units per 1k tokens
  CACHED_INPUT_TOKEN_MICRO_PER_1K: 125,

  // Output tokens: $1.00 / 1,000,000 tokens => 1,000 micro-units per 1k tokens
  OUTPUT_TOKEN_MICRO_PER_1K: 1000,

  // Reasoning tokens: billed as output tokens => 1,000 micro-units per 1k tokens
  REASONING_TOKEN_MICRO_PER_1K: 1000,

  // Currency definition
  CURRENCY: 'usd',
  MICRO_UNITS_PER_CENT: 10000,
  MICRO_UNITS_PER_DOLLAR: 1000000,
} as const;
