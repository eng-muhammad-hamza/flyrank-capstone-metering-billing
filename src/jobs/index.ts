import {
  TenantRepository,
  SubscriptionRepository,
  UsageRepository,
} from '../repositories';
import { db } from '../database';

export class BackgroundJobs {
  private tenantRepo: TenantRepository;
  private subscriptionRepo: SubscriptionRepository;
  private usageRepo: UsageRepository;
  private isRunning: boolean = false;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.tenantRepo = new TenantRepository(db);
    this.subscriptionRepo = new SubscriptionRepository(db);
    this.usageRepo = new UsageRepository(db);
  }

  /**
   * Background Job: Usage Aggregation & Quota Monitoring
   * Runs off the request path with retry logic and failure alerting.
   */
  async runUsageRollupJob(maxRetries: number = 3): Promise<{
    processedTenants: number;
    warnings: string[];
    errors: string[];
  }> {
    let attempt = 0;
    const warnings: string[] = [];
    const errors: string[] = [];

    while (attempt < maxRetries) {
      attempt++;
      try {
        const tenants = await this.tenantRepo.list();
        let processedCount = 0;

        for (const tenant of tenants) {
          const subscription = await this.subscriptionRepo.findByTenantId(tenant.id);
          if (!subscription) continue;

          const usage = await this.usageRepo.getAggregatedUsage(
            tenant.id,
            subscription.current_period_start,
            subscription.current_period_end
          );

          // Check if tenant is approaching limits (e.g. 80% or 100%)
          if (usage.api_calls > 800) {
            warnings.push(
              `[QUOTA ALERT] Tenant ${tenant.id} has used ${usage.api_calls} API calls.`
            );
          }

          processedCount++;
        }

        return {
          processedTenants: processedCount,
          warnings,
          errors,
        };
      } catch (err: any) {
        if (attempt >= maxRetries) {
          errors.push(`[FATAL] UsageRollupJob failed after ${maxRetries} attempts: ${err.message}`);
          console.error('[BackgroundJob Alert]', errors[0]);
          return { processedTenants: 0, warnings, errors };
        }
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 100));
      }
    }

    return { processedTenants: 0, warnings, errors };
  }

  /**
   * Start periodic background job runner
   */
  start(intervalMs: number = 60000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(async () => {
      try {
        await this.runUsageRollupJob();
      } catch (err) {
        console.error('Unhandled background job execution error:', err);
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunning = false;
  }
}
