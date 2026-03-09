/**
 * HTTP handler for Stripe billing endpoints.
 *
 * Routes handled:
 *   POST /billing/checkout  - Create a Stripe Checkout session and redirect
 *   POST /billing/webhook   - Receive Stripe webhook events (raw body required)
 *   GET  /billing/status    - Return current subscription status as JSON
 *   POST /billing/portal    - Create a Stripe Customer Portal session and redirect
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type Stripe from "stripe";
import {
  deactivateSubscription,
  getAllSubscriptions,
  getActiveSubscription,
  upsertSubscription,
} from "./subscription-store.js";
import {
  getCancelUrl,
  getPriceId,
  getStripeClient,
  getSuccessUrl,
  getWebhookSecret,
  isStripeEnabled,
} from "./stripe-client.js";

const BILLING_PREFIX = "/billing";
const CHECKOUT_PATH = "/billing/checkout";
const WEBHOOK_PATH = "/billing/webhook";
const STATUS_PATH = "/billing/status";
const PORTAL_PATH = "/billing/portal";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, url: string): void {
  res.statusCode = 303;
  res.setHeader("Location", url);
  res.end();
}

/** Read the raw request body as a Buffer. */
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Update local subscription state from a Stripe subscription object. */
function applySubscriptionEvent(subscription: Stripe.Subscription): void {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  upsertSubscription({
    customerId,
    subscriptionId: subscription.id,
    status: subscription.status as import("./subscription-store.js").SubscriptionStatus,
    currentPeriodEnd: subscription.current_period_end ?? 0,
    updatedAt: new Date().toISOString(),
  });
}

async function handleCheckout(res: ServerResponse): Promise<void> {
  const priceId = getPriceId();
  if (!priceId) {
    sendJson(res, 500, { ok: false, error: "STRIPE_PRICE_ID is not configured" });
    return;
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: getSuccessUrl(),
    cancel_url: getCancelUrl(),
  });

  if (!session.url) {
    sendJson(res, 500, { ok: false, error: "Stripe did not return a checkout URL" });
    return;
  }

  redirect(res, session.url);
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    sendJson(res, 500, { ok: false, error: "STRIPE_WEBHOOK_SECRET is not configured" });
    return;
  }

  const stripe = getStripeClient();
  const sig = req.headers["stripe-signature"];
  if (!sig || typeof sig !== "string") {
    sendJson(res, 400, { ok: false, error: "Missing stripe-signature header" });
    return;
  }

  const rawBody = await readRawBody(req);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `Webhook signature verification failed: ${String(err)}` });
    return;
  }

  // Handle subscription lifecycle events
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      // Retrieve the full subscription to get current_period_end
      if (session.subscription) {
        const subId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
        const subscription = await stripe.subscriptions.retrieve(subId);
        applySubscriptionEvent(subscription);
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.resumed": {
      applySubscriptionEvent(event.data.object as Stripe.Subscription);
      break;
    }
    case "customer.subscription.deleted":
    case "customer.subscription.paused": {
      const sub = event.data.object as Stripe.Subscription;
      deactivateSubscription({ subscriptionId: sub.id });
      break;
    }
    case "invoice.payment_failed":
      // Do not deactivate here — Stripe retries automatically. Access is
      // revoked only when the subscription reaches "canceled" status via
      // customer.subscription.deleted, which is already handled above.
      break;
    default:
      // Ignore unhandled event types
      break;
  }

  sendJson(res, 200, { ok: true, received: true });
}

async function handlePortal(res: ServerResponse): Promise<void> {
  const subs = getAllSubscriptions();
  const customerId = subs[0]?.customerId;
  if (!customerId) {
    sendJson(res, 400, { ok: false, error: "No customer found. Complete checkout first." });
    return;
  }

  const stripe = getStripeClient();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: getCancelUrl(),
  });

  redirect(res, session.url);
}

/**
 * Gateway HTTP stage handler for billing routes.
 * Returns true if the request was handled, false to continue the pipeline.
 *
 * `opts.authorized` must be true for the /billing/portal endpoint (it generates
 * a Stripe customer-portal session and should only be accessible to the gateway
 * operator who knows the Bearer token).
 */
export async function handleBillingHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { authorized?: boolean } = {},
): Promise<boolean> {
  const url = req.url ?? "/";
  const requestPath = new URL(url, "http://localhost").pathname;

  // Only handle /billing/* paths
  if (!requestPath.startsWith(BILLING_PREFIX)) {
    return false;
  }

  // Status endpoint works even when Stripe is not enabled
  if (requestPath === STATUS_PATH && req.method === "GET") {
    const active = isStripeEnabled() ? getActiveSubscription() : null;
    sendJson(res, 200, {
      ok: true,
      paywallEnabled: isStripeEnabled(),
      subscribed: !isStripeEnabled() || Boolean(active),
      subscription: active ?? null,
    });
    return true;
  }

  if (!isStripeEnabled()) {
    sendJson(res, 503, { ok: false, error: "Stripe billing is not configured on this server" });
    return true;
  }

  try {
    if (requestPath === CHECKOUT_PATH && req.method === "POST") {
      await handleCheckout(res);
      return true;
    }

    if (requestPath === WEBHOOK_PATH && req.method === "POST") {
      await handleWebhook(req, res);
      return true;
    }

    if (requestPath === PORTAL_PATH && req.method === "POST") {
      if (!opts.authorized) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("WWW-Authenticate", 'Bearer realm="openclaw-admin"');
        res.end(JSON.stringify({ ok: false, error: "Unauthorized. Gateway token required." }));
        return true;
      }
      await handlePortal(res);
      return true;
    }
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String(err) });
    return true;
  }

  // Path starts with /billing but no route matched
  if (requestPath.startsWith(BILLING_PREFIX)) {
    sendJson(res, 404, { ok: false, error: "Not found" });
    return true;
  }

  return false;
}
