import {
  TenantRepository,
  PlanRepository,
  SubscriptionRepository,
  UsageRepository,
} from '../repositories';
import { Plan, Subscription } from '../models/types';

export interface QuotaCheckResult {
  allowed: boolean;
  statusCode?: number;
  error?: string;
  message?: string;
  quotaType?: 'api_calls' | 'ai_tokens';
  current?: number;
  limit?: number;
  plan?: Plan;
  subscription?: Subscription;
}

export class QuotaService {
  constructor(
    private tenantRepo: TenantRepository,
    private planRepo: PlanRepository,
    private subscriptionRepo: SubscriptionRepository,
    private usageRepo: UsageRepository
  ) {}

  async checkQuota(
    tenantId: string,
    requestedTokens: number = 0
  ): Promise<QuotaCheckResult> {
    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) {
      return {
        allowed: false,
        statusCode: 404,
        error: 'TENANT_NOT_FOUND',
        message: `Tenant with ID '${tenantId}' does not exist.`,
      };
    }

    const subscription = await this.subscriptionRepo.findByTenantId(tenantId);
    if (!subscription) {
      return {
        allowed: false,
        statusCode: 402,
        error: 'SUBSCRIPTION_NOT_FOUND',
        message: 'No subscription found for this tenant. An active subscription is required.',
      };
    }

    // 402 Payment Required for delinquent or canceled subscriptions
    if (subscription.status !== 'active') {
      return {
        allowed: false,
        statusCode: 402,
        error: 'PAYMENT_REQUIRED',
        message: `Subscription is currently '${subscription.status}'. An active subscription is required to perform billable actions.`,
        subscription,
      };
    }

    const plan = await this.planRepo.findById(subscription.plan_id);
    if (!plan) {
      return {
        allowed: false,
        statusCode: 500,
        error: 'PLAN_CONFIG_ERROR',
        message: `Associated plan '${subscription.plan_id}' configuration is missing.`,
      };
    }

    // Current period usage
    const usage = await this.usageRepo.getAggregatedUsage(
      tenantId,
      subscription.current_period_start,
      subscription.current_period_end
    );

    // 1. Check API Call boundary
    if (usage.api_calls + 1 > plan.api_call_quota) {
      return {
        allowed: false,
        statusCode: 429,
        error: 'QUOTA_EXCEEDED',
        quotaType: 'api_calls',
        current: usage.api_calls,
        limit: plan.api_call_quota,
        message: `Monthly API call quota of ${plan.api_call_quota} reached (current usage: ${usage.api_calls}). Upgrade your plan to Pro for higher limits.`,
        plan,
        subscription,
      };
    }

    // 2. Check AI Token boundary
    if (usage.total_tokens + requestedTokens > plan.token_quota) {
      return {
        allowed: false,
        statusCode: 429,
        error: 'QUOTA_EXCEEDED',
        quotaType: 'ai_tokens',
        current: usage.total_tokens,
        limit: plan.token_quota,
        message: `Monthly AI token quota of ${plan.token_quota} exceeded with requested ${requestedTokens} tokens (current usage: ${usage.total_tokens}). Upgrade your plan to Pro for higher limits.`,
        plan,
        subscription,
      };
    }

    return {
      allowed: true,
      plan,
      subscription,
    };
  }
}
