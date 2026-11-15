import crypto from 'crypto';
import {
  UsageRepository,
  IdempotencyRepository,
  SubscriptionRepository,
  PlanRepository,
} from '../repositories';
import { CostCalculator, TokenUsageInput } from './costCalculator';
import { QuotaService } from './quotaService';
import { UsageRollup } from '../models/types';
import { PRICING_CONSTANTS } from '../config/pricing';

export interface BillableGenerationParams {
  tenantId: string;
  idempotencyKey?: string | null;
  prompt?: string;
  tokenUsage?: TokenUsageInput;
}

export interface MeterServiceResult {
  statusCode: number;
  data: any;
  idempotentReplay?: boolean;
}

export class MeterService {
  constructor(
    private usageRepo: UsageRepository,
    private idempotencyRepo: IdempotencyRepository,
    private subscriptionRepo: SubscriptionRepository,
    private planRepo: PlanRepository,
    private quotaService: QuotaService
  ) {}

  async recordBillableGeneration(params: BillableGenerationParams): Promise<MeterServiceResult> {
    const { tenantId, idempotencyKey, prompt } = params;

    // 1. Check Idempotency Key first
    if (idempotencyKey) {
      const existing = await this.idempotencyRepo.find(idempotencyKey, tenantId);
      if (existing) {
        return {
          statusCode: existing.response_status,
          data: JSON.parse(existing.response_body),
          idempotentReplay: true,
        };
      }
    }

    // Default simulated token counts if not explicitly supplied
    const tokenUsage: TokenUsageInput = params.tokenUsage || {
      input_tokens: 1000,
      cached_tokens: 500,
      output_tokens: 400,
      reasoning_tokens: 100,
    };

    const costResult = CostCalculator.calculateTokenCost(tokenUsage);
    const requestedTokens = costResult.total_tokens;

    // 2. Check Quota before executing billable action
    const quotaCheck = await this.quotaService.checkQuota(tenantId, requestedTokens);
    if (!quotaCheck.allowed) {
      return {
        statusCode: quotaCheck.statusCode || 429,
        data: {
          error: quotaCheck.error,
          message: quotaCheck.message,
          quota_type: quotaCheck.quotaType,
          current_usage: quotaCheck.current,
          limit: quotaCheck.limit,
          upgrade_available: quotaCheck.plan?.id === 'free',
        },
      };
    }

    // 3. Prepare response payload
    const simulatedCompletion = prompt
      ? `Simulated AI completion for: "${prompt.slice(0, 50)}..."`
      : 'Simulated AI completion generated safely.';

    const responseData = {
      status: 'success',
      tenant_id: tenantId,
      result: simulatedCompletion,
      usage: {
        api_calls: 1,
        tokens: {
          total: costResult.total_tokens,
          input: costResult.breakdown.fresh_input_tokens,
          cached_input: costResult.breakdown.cached_input_tokens,
          output: costResult.breakdown.output_tokens,
          reasoning: costResult.breakdown.reasoning_tokens,
        },
      },
      cost: {
        currency: 'usd',
        micro_units: costResult.cost_micro_units,
        cents: costResult.cost_cents,
        breakdown: costResult.breakdown,
      },
      idempotency_key: idempotencyKey || null,
      timestamp: new Date().toISOString(),
    };

    // 4. Record usage events
    const apiCallEventId = `evt_api_${crypto.randomUUID()}`;
    const tokenEventId = `evt_tok_${crypto.randomUUID()}`;

    // Record API Call (1 call)
    await this.usageRepo.record({
      id: apiCallEventId,
      tenant_id: tenantId,
      usage_type: 'api_call',
      quantity: 1,
      cost_micro_units: 0,
      idempotency_key: idempotencyKey,
    });

    // Record AI Tokens with exact categorized counts and integer cost
    await this.usageRepo.record({
      id: tokenEventId,
      tenant_id: tenantId,
      usage_type: 'ai_token',
      quantity: costResult.total_tokens,
      input_tokens: costResult.breakdown.fresh_input_tokens,
      cached_tokens: costResult.breakdown.cached_input_tokens,
      output_tokens: costResult.breakdown.output_tokens,
      reasoning_tokens: costResult.breakdown.reasoning_tokens,
      cost_micro_units: costResult.cost_micro_units,
      idempotency_key: idempotencyKey,
    });

    // 5. Save Idempotency Record if key was provided
    if (idempotencyKey) {
      const payloadHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ tenantId, tokenUsage, prompt }))
        .digest('hex');

      await this.idempotencyRepo.save({
        idempotency_key: idempotencyKey,
        tenant_id: tenantId,
        request_hash: payloadHash,
        response_status: 200,
        response_body: JSON.stringify(responseData),
      });
    }

    return {
      statusCode: 200,
      data: responseData,
      idempotentReplay: false,
    };
  }

  async getUsageRollup(tenantId: string): Promise<UsageRollup | null> {
    const subscription = await this.subscriptionRepo.findByTenantId(tenantId);
    if (!subscription) {
      return null;
    }

    const plan = await this.planRepo.findById(subscription.plan_id);
    if (!plan) {
      return null;
    }

    const aggregated = await this.usageRepo.getAggregatedUsage(
      tenantId,
      subscription.current_period_start,
      subscription.current_period_end
    );

    // Calculate itemized token costs for rollup display
    const tokenCostBreakdown = CostCalculator.calculateTokenCost({
      input_tokens: aggregated.input_tokens,
      cached_tokens: aggregated.cached_tokens,
      output_tokens: aggregated.output_tokens,
      reasoning_tokens: aggregated.reasoning_tokens,
    });

    return {
      tenant_id: tenantId,
      plan,
      subscription_status: subscription.status,
      billing_period: {
        start: subscription.current_period_start,
        end: subscription.current_period_end,
      },
      used: {
        api_calls: aggregated.api_calls,
        tokens: {
          total: aggregated.total_tokens,
          input: aggregated.input_tokens,
          cached_input: aggregated.cached_tokens,
          output: aggregated.output_tokens,
          reasoning: aggregated.reasoning_tokens,
        },
      },
      limit: {
        api_calls: plan.api_call_quota,
        tokens: plan.token_quota,
      },
      cost: {
        currency: 'usd',
        total_cents: tokenCostBreakdown.cost_cents,
        total_micro_units: tokenCostBreakdown.cost_micro_units,
        breakdown: {
          api_calls_micro_units: 0,
          input_tokens_micro_units: tokenCostBreakdown.breakdown.fresh_input_cost_micro_units,
          cached_input_tokens_micro_units: tokenCostBreakdown.breakdown.cached_input_cost_micro_units,
          output_tokens_micro_units: tokenCostBreakdown.breakdown.output_cost_micro_units,
          reasoning_tokens_micro_units: tokenCostBreakdown.breakdown.reasoning_cost_micro_units,
        },
      },
    };
  }
}
