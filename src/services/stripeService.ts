import Stripe from 'stripe';
import { config } from '../config';
import {
  SubscriptionRepository,
  TenantRepository,
  WebhookRepository,
  PlanRepository,
} from '../repositories';

export interface CheckoutSessionParams {
  tenantId: string;
  successUrl: string;
  cancelUrl: string;
}

export class StripeService {
  private stripe: Stripe;

  constructor(
    private subscriptionRepo: SubscriptionRepository,
    private tenantRepo: TenantRepository,
    private planRepo: PlanRepository,
    private webhookRepo: WebhookRepository
  ) {
    this.stripe = new Stripe(config.stripe.secretKey, {
      apiVersion: '2025-02-24.acacia' as any,
    });
  }

  /**
   * Creates a Stripe Checkout Session for a tenant upgrading to the Pro plan.
   */
  async createCheckoutSession(params: CheckoutSessionParams): Promise<{
    sessionId: string;
    checkoutUrl: string | null;
  }> {
    const { tenantId, successUrl, cancelUrl } = params;

    const tenant = await this.tenantRepo.findById(tenantId);
    if (!tenant) {
      throw new Error(`Tenant '${tenantId}' not found.`);
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      client_reference_id: tenantId,
      customer_email: tenant.email,
      metadata: {
        tenant_id: tenantId,
      },
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Pro Tier Subscription',
              description: 'Higher API limits (50k calls) and 5M AI tokens/month',
            },
            unit_amount: 2900, // $29.00
            recurring: {
              interval: 'month',
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${successUrl}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
    });

    return {
      sessionId: session.id,
      checkoutUrl: session.url,
    };
  }

  /**
   * Verifies Stripe Webhook cryptographic signature and parses the event.
   * Throws an error if the signature is invalid or forged.
   */
  verifyWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.stripe.webhookSecret
    );
  }

  /**
   * Deduplicates and handles Stripe Webhook events.
   * Returns:
   * - { processed: true, eventType: string } if newly processed
   * - { processed: false, reason: 'duplicate_event' } if replayed
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<{
    processed: boolean;
    reason?: string;
    eventType: string;
  }> {
    const eventId = event.id;
    const eventType = event.type;

    // Deduplication check
    const isAlreadyProcessed = await this.webhookRepo.isProcessed(eventId);
    if (isAlreadyProcessed) {
      return {
        processed: false,
        reason: 'duplicate_event',
        eventType,
      };
    }

    // Process event types
    switch (eventType) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.client_reference_id || session.metadata?.tenant_id;

        if (tenantId) {
          const now = new Date();
          const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

          await this.subscriptionRepo.upsert({
            id: `sub_${session.subscription || session.id}`,
            tenant_id: tenantId,
            plan_id: 'pro',
            stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
            stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : null,
            status: 'active',
            current_period_start: now.toISOString(),
            current_period_end: oneMonthLater.toISOString(),
          });
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeSubId = subscription.id;
        const existingSub = await this.subscriptionRepo.findByStripeSubscriptionId(stripeSubId);

        if (existingSub) {
          const status = subscription.status === 'active' ? 'active' :
                         subscription.status === 'past_due' ? 'past_due' :
                         subscription.status === 'canceled' ? 'canceled' : 'unpaid';

          const periodStart = (subscription as any).current_period_start
            ? new Date((subscription as any).current_period_start * 1000).toISOString()
            : existingSub.current_period_start;

          const periodEnd = (subscription as any).current_period_end
            ? new Date((subscription as any).current_period_end * 1000).toISOString()
            : existingSub.current_period_end;

          await this.subscriptionRepo.upsert({
            id: existingSub.id,
            tenant_id: existingSub.tenant_id,
            plan_id: existingSub.plan_id,
            stripe_customer_id: existingSub.stripe_customer_id,
            stripe_subscription_id: stripeSubId,
            status,
            current_period_start: periodStart,
            current_period_end: periodEnd,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const stripeSubId = subscription.id;
        const existingSub = await this.subscriptionRepo.findByStripeSubscriptionId(stripeSubId);

        if (existingSub) {
          // Downgrade back to Free plan with active status or canceled status
          const now = new Date();
          const oneMonthLater = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

          await this.subscriptionRepo.upsert({
            id: existingSub.id,
            tenant_id: existingSub.tenant_id,
            plan_id: 'free',
            stripe_customer_id: existingSub.stripe_customer_id,
            stripe_subscription_id: null,
            status: 'active',
            current_period_start: now.toISOString(),
            current_period_end: oneMonthLater.toISOString(),
          });
        }
        break;
      }

      default:
        // Other events ignored but acknowledged
        break;
    }

    // Mark as processed in DB to prevent replays
    await this.webhookRepo.markProcessed(eventId, eventType, 'success');

    return {
      processed: true,
      eventType,
    };
  }
}
