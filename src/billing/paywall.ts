/**
 * Paywall enforcement helpers.
 *
 * Usage in HTTP handlers:
 *   const blocked = enforcePaywall(req, res);
 *   if (blocked) return;
 *
 * Usage in WS method handlers (returns an error payload or null):
 *   const err = paywallError();
 *   if (err) return err;
 *
 * The paywall is bypassed when:
 *   - STRIPE_SECRET_KEY is not set (self-hosted / dev mode)
 *   - A valid active/trialing subscription exists in the local store
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { getActiveSubscription } from "./subscription-store.js";
import { isStripeEnabled } from "./stripe-client.js";

const PAYMENT_REQUIRED_BODY = JSON.stringify({
  ok: false,
  error: "Payment required. Visit /billing/checkout to subscribe.",
  code: "PAYMENT_REQUIRED",
});

/**
 * Returns true if the paywall allows the request through, false if blocked.
 */
export function isSubscribed(): boolean {
  if (!isStripeEnabled()) {
    // Paywall disabled — allow everything
    return true;
  }
  return Boolean(getActiveSubscription());
}

/**
 * HTTP middleware: sends a 402 response and returns true when blocked.
 * Returns false (does NOT end the response) when the request may proceed.
 */
export function enforcePaywallHttp(
  _req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (isSubscribed()) {
    return false;
  }
  res.statusCode = 402;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(PAYMENT_REQUIRED_BODY);
  return true;
}

/**
 * WebSocket / method handler helper.
 * Returns an error object when the request is blocked, or null to allow.
 */
export function paywallError(): { error: { code: string; message: string } } | null {
  if (isSubscribed()) {
    return null;
  }
  return {
    error: {
      code: "PAYMENT_REQUIRED",
      message: "Payment required. Visit /billing/checkout to subscribe.",
    },
  };
}
