import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { db } from './database';
import {
  TenantRepository,
  PlanRepository,
  SubscriptionRepository,
  UsageRepository,
  IdempotencyRepository,
  WebhookRepository,
} from './repositories';
import { QuotaService } from './services/quotaService';
import { MeterService } from './services/meterService';
import { StripeService } from './services/stripeService';
import { MeterController } from './controllers/meterController';
import { StripeController } from './controllers/stripeController';
import { PLANS, PRICING_CONSTANTS } from './config/pricing';

export function createApp(): Express {
  const app = express();

  // Cross-origin resource sharing
  app.use(cors());

  // Raw body parser for Stripe webhooks ONLY (required for signature verification)
  app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

  // JSON parser for all standard API endpoints
  app.use(express.json());

  // Initialize repositories
  const tenantRepo = new TenantRepository(db);
  const planRepo = new PlanRepository(db);
  const subscriptionRepo = new SubscriptionRepository(db);
  const usageRepo = new UsageRepository(db);
  const idempotencyRepo = new IdempotencyRepository(db);
  const webhookRepo = new WebhookRepository(db);

  // Initialize services
  const quotaService = new QuotaService(tenantRepo, planRepo, subscriptionRepo, usageRepo);
  const meterService = new MeterService(
    usageRepo,
    idempotencyRepo,
    subscriptionRepo,
    planRepo,
    quotaService
  );
  const stripeService = new StripeService(
    subscriptionRepo,
    tenantRepo,
    planRepo,
    webhookRepo
  );

  // Initialize controllers
  const meterController = new MeterController(meterService);
  const stripeController = new StripeController(stripeService);

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'usage-metering-billing-engine',
    });
  });

  // Plans and pricing configuration inspect endpoint
  app.get('/plans', (req: Request, res: Response) => {
    res.status(200).json({
      plans: PLANS,
      pricing_constants: PRICING_CONSTANTS,
    });
  });

  // Billable dummy AI generation endpoint (exercises metering, idempotency, quotas, costs)
  app.post('/generate', (req: Request, res: Response) => {
    meterController.generate(req, res);
  });

  // Usage rollup endpoint
  app.get('/usage', (req: Request, res: Response) => {
    meterController.getUsage(req, res);
  });

  // Stripe Checkout Session creation
  app.post('/checkout/session', (req: Request, res: Response) => {
    stripeController.createCheckout(req, res);
  });

  // Stripe Webhooks
  app.post('/webhooks/stripe', (req: Request, res: Response) => {
    stripeController.handleWebhook(req, res);
  });

  // 404 handler for undefined routes
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    });
  });

  // Global error handler
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    console.error('[Global App Error]', err);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected internal server error occurred.',
    });
  });

  return app;
}
