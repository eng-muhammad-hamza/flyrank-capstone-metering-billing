import { Request, Response } from 'express';
import { MeterService } from '../services/meterService';

export class MeterController {
  constructor(private meterService: MeterService) {}

  async generate(req: Request, res: Response): Promise<void> {
    try {
      const tenantId =
        (req.headers['x-tenant-id'] as string) || req.body?.tenant_id;

      if (!tenantId) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: "Missing required 'X-Tenant-ID' header or 'tenant_id' in body.",
        });
        return;
      }

      const idempotencyKey =
        (req.headers['idempotency-key'] as string) || req.body?.idempotency_key || null;

      const { prompt, token_usage, input_tokens, cached_tokens, output_tokens, reasoning_tokens } =
        req.body || {};

      const tokenUsage = token_usage || (
        input_tokens !== undefined || output_tokens !== undefined
          ? {
              input_tokens: Number(input_tokens || 0),
              cached_tokens: Number(cached_tokens || 0),
              output_tokens: Number(output_tokens || 0),
              reasoning_tokens: Number(reasoning_tokens || 0),
            }
          : undefined
      );

      const result = await this.meterService.recordBillableGeneration({
        tenantId,
        idempotencyKey,
        prompt,
        tokenUsage,
      });

      if (result.statusCode === 429) {
        res.setHeader('Retry-After', '3600');
      }

      if (result.idempotentReplay) {
        res.setHeader('Idempotency-Replayed', 'true');
      }

      res.status(result.statusCode).json(result.data);
    } catch (err: any) {
      console.error('[MeterController Error]', err);
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred while processing usage metering.',
      });
    }
  }

  async getUsage(req: Request, res: Response): Promise<void> {
    try {
      const tenantId =
        (req.headers['x-tenant-id'] as string) ||
        (req.query.tenant_id as string);

      if (!tenantId) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: "Missing required tenant identifier. Pass 'X-Tenant-ID' header or '?tenant_id=...' query parameter.",
        });
        return;
      }

      const rollup = await this.meterService.getUsageRollup(tenantId);
      if (!rollup) {
        res.status(404).json({
          error: 'NOT_FOUND',
          message: `Tenant or subscription not found for ID '${tenantId}'.`,
        });
        return;
      }

      res.status(200).json(rollup);
    } catch (err: any) {
      console.error('[UsageController Error]', err);
      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'An error occurred while fetching usage rollup.',
      });
    }
  }
}
