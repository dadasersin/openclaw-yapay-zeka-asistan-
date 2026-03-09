/**
 * Stripe SDK client initialization.
 *
 * Configure via environment variables:
 *   STRIPE_SECRET_KEY       - Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_WEBHOOK_SECRET   - Stripe webhook signing secret (whsec_...)
 *   STRIPE_PRICE_ID         - Stripe Price ID for the subscription product
 *   STRIPE_SUCCESS_URL      - Redirect URL after successful checkout
 *   STRIPE_CANCEL_URL       - Redirect URL after checkout cancellation
 *
 * If STRIPE_SECRET_KEY is not set the paywall is disabled and all requests pass through.
 */

import Stripe from "stripe";

/** Returns true when Stripe is configured and the paywall is enabled. */
export function isStripeEnabled(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim());
}

let _client: Stripe | null = null;

/** Returns the shared Stripe client. Throws if STRIPE_SECRET_KEY is not set. */
export function getStripeClient(): Stripe {
  if (!_client) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) {
      throw new Error("STRIPE_SECRET_KEY is not set");
    }
    _client = new Stripe(key, { apiVersion: "2025-01-27.acacia" });
  }
  return _client;
}

export function getWebhookSecret(): string {
  return process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
}

export function getPriceId(): string {
  return process.env.STRIPE_PRICE_ID?.trim() ?? "";
}

export function getSuccessUrl(): string {
  return (
    process.env.STRIPE_SUCCESS_URL?.trim() ?? "http://localhost:18789/?billing=success"
  );
}

export function getCancelUrl(): string {
  return (
    process.env.STRIPE_CANCEL_URL?.trim() ?? "http://localhost:18789/?billing=canceled"
  );
}
