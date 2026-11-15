import { Request, Response } from 'express';
import { StripeService } from '../services/stripeService';

export class StripeController {
  constructor(private stripeService: StripeService) {}

  async createCheckout(req: Request, res: Response): Promise<void> {
    try {
      const { tenant_id, success_url, cancel_url } = req.body;

      if (!tenant_id) {
        res.status(400).json({
          error: 'BAD_REQUEST',
          message: "Missing 'tenant_id' in request body.",
        });
        return;
      }

      const result = await this.stripeService.createCheckoutSession({
        tenantId: tenant_id,
        successUrl: success_url || 'http://localhost:3000/success',
        cancelUrl: cancel_url || 'http://localhost:3000/cancel',
      });

      res.status(200).json({
        status: 'success',
        session_id: result.sessionId,
        checkout_url: result.checkoutUrl,
      });
    } catch (err: any) {
      console.error('[StripeController Checkout Error]', err);
      res.status(400).json({
        error: 'CHECKOUT_CREATION_FAILED',
        message: err.message || 'Unable to create Stripe checkout session.',
      });
    }
  }

  async handleWebhook(req: Request, res: Response): Promise<void> {
    const signature = req.headers['stripe-signature'] as string;

    if (!signature) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: "Missing required 'Stripe-Signature' header.",
      });
      return;
    }

    try {
      const rawBody = req.body;
      const event = this.stripeService.verifyWebhookEvent(rawBody, signature);

      const result = await this.stripeService.handleWebhookEvent(event);

      res.status(200).json({
        received: true,
        event_type: result.eventType,
        processed: result.processed,
        reason: result.reason,
      });
    } catch (err: any) {
      // PROBE 4 requirement: Forged signature -> 400, nothing changes
      console.warn('[Stripe Webhook Signature Verification Failed]', err.message);
      res.status(400).json({
        error: 'INVALID_SIGNATURE',
        message: `Webhook signature verification failed: ${err.message}`,
      });
    }
  }
}
