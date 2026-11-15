import { PRICING_CONSTANTS } from '../config/pricing';

export interface TokenUsageInput {
  input_tokens: number;
  cached_tokens?: number;
  output_tokens: number;
  reasoning_tokens?: number;
}

export interface CalculatedCost {
  total_tokens: number;
  cost_micro_units: number;
  cost_cents: number;
  breakdown: {
    fresh_input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_tokens: number;
    fresh_input_cost_micro_units: number;
    cached_input_cost_micro_units: number;
    output_cost_micro_units: number;
    reasoning_cost_micro_units: number;
  };
}

export class CostCalculator {
  /**
   * Calculates the exact cost of an AI generation in integer micro-units and integer cents.
   * Enforces rules:
   * 1. Cached input tokens are cheaper (50% of fresh input price)
   * 2. Reasoning tokens count as output tokens (billed at output rate)
   * 3. Token categories cannot simply be added together
   * 4. Zero floating point numbers in currency storage
   */
  static calculateTokenCost(usage: TokenUsageInput): CalculatedCost {
    const freshInput = Math.max(0, Math.floor(usage.input_tokens || 0));
    const cachedInput = Math.max(0, Math.floor(usage.cached_tokens || 0));
    const output = Math.max(0, Math.floor(usage.output_tokens || 0));
    const reasoning = Math.max(0, Math.floor(usage.reasoning_tokens || 0));

    // Fresh input cost in micro-units: (freshInput * rate) / 1000
    // Using Math.ceil to prevent underbilling sub-micro fractions
    const freshInputCost = Math.ceil(
      (freshInput * PRICING_CONSTANTS.INPUT_TOKEN_MICRO_PER_1K) / 1000
    );

    // Cached input cost in micro-units: discounted rate
    const cachedInputCost = Math.ceil(
      (cachedInput * PRICING_CONSTANTS.CACHED_INPUT_TOKEN_MICRO_PER_1K) / 1000
    );

    // Output cost in micro-units
    const outputCost = Math.ceil(
      (output * PRICING_CONSTANTS.OUTPUT_TOKEN_MICRO_PER_1K) / 1000
    );

    // Reasoning tokens billed at output rate
    const reasoningCost = Math.ceil(
      (reasoning * PRICING_CONSTANTS.REASONING_TOKEN_MICRO_PER_1K) / 1000
    );

    const totalMicroUnits = freshInputCost + cachedInputCost + outputCost + reasoningCost;
    const totalCents = Math.ceil(totalMicroUnits / PRICING_CONSTANTS.MICRO_UNITS_PER_CENT);
    const totalTokens = freshInput + cachedInput + output + reasoning;

    return {
      total_tokens: totalTokens,
      cost_micro_units: totalMicroUnits,
      cost_cents: totalCents,
      breakdown: {
        fresh_input_tokens: freshInput,
        cached_input_tokens: cachedInput,
        output_tokens: output,
        reasoning_tokens: reasoning,
        fresh_input_cost_micro_units: freshInputCost,
        cached_input_cost_micro_units: cachedInputCost,
        output_cost_micro_units: outputCost,
        reasoning_cost_micro_units: reasoningCost,
      },
    };
  }
}
