// Stripe over its REST API with fetch — no SDK, so nothing extra to install
// and nothing to build on cPanel.
//
// Money is handled in the smallest currency unit (fils for AED, cents for USD)
// because Stripe rejects fractional amounts. Always convert at the boundary.

const env = require('../config/env')

const STRIPE_BASE = 'https://api.stripe.com/v1'

/** Currencies with no minor unit — amounts are NOT multiplied by 100. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'])

/** 250.5 AED -> 25050 fils */
function toMinorUnits(amount, currency = 'aed') {
  const value = Number(amount) || 0
  if (ZERO_DECIMAL.has(String(currency).toLowerCase())) return Math.round(value)
  return Math.round(value * 100)
}

/** 25050 fils -> 250.5 AED */
function fromMinorUnits(amount, currency = 'aed') {
  const value = Number(amount) || 0
  if (ZERO_DECIMAL.has(String(currency).toLowerCase())) return value
  return Math.round(value) / 100
}

/**
 * Flatten a nested object into Stripe's bracket form:
 *   { metadata: { a: 1 } } -> "metadata[a]=1"
 */
function encode(payload, prefix = '', params = new URLSearchParams()) {
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === '') continue
    const field = prefix ? `${prefix}[${key}]` : key
    if (typeof value === 'object' && !Array.isArray(value)) encode(value, field, params)
    else params.append(field, String(value))
  }
  return params
}

async function request(path, { method = 'POST', body, idempotencyKey } = {}) {
  if (!env.stripe.configured) {
    const error = new Error('Stripe is not configured (set STRIPE_SECRET_KEY)')
    error.stripeUnconfigured = true
    throw error
  }

  const headers = {
    Authorization: `Bearer ${env.stripe.secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  // Protects against a double-click creating two charges.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  const response = await fetch(`${STRIPE_BASE}${path}`, {
    method,
    headers,
    body: body ? encode(body) : undefined,
  })

  const result = await response.json().catch(() => ({}))

  if (!response.ok) {
    const error = new Error(result.error?.message || `Stripe responded ${response.status}`)
    error.stripeCode = result.error?.code || null
    error.stripeType = result.error?.type || null
    error.statusCode = response.status
    throw error
  }

  return result
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Create a PaymentIntent for a booking.
 *
 * When the artist has a connected account we take the platform commission and
 * send the rest to them (destination charge). Without one, the whole amount
 * stays on the platform and is paid out manually.
 */
async function createPaymentIntent({ amount, currency = 'AED', metadata = {}, connectedAccountId, applicationFee, idempotencyKey }) {
  const body = {
    amount: toMinorUnits(amount, currency),
    currency: String(currency).toLowerCase(),
    // Cards only for now; Stripe would otherwise offer methods we can't confirm.
    'payment_method_types[0]': 'card',
    metadata,
  }

  if (connectedAccountId) {
    body.transfer_data = { destination: connectedAccountId }
    if (applicationFee) body.application_fee_amount = toMinorUnits(applicationFee, currency)
  }

  return request('/payment_intents', { body, idempotencyKey })
}

/** Read a PaymentIntent — used to confirm what really happened. */
async function retrievePaymentIntent(paymentIntentId) {
  return request(`/payment_intents/${paymentIntentId}`, { method: 'GET' })
}

/**
 * Pay an artist out of a specific charge (escrow release).
 *
 * `sourceTransaction` is the charge that funded it. Passing it means the
 * transfer draws on THAT charge rather than the platform's available balance,
 * so a payout works the moment the artist completes the job — no waiting for
 * funds to settle, and no risk of paying out money we haven't collected.
 */
async function createTransfer({ amount, currency = 'AED', destination, sourceTransaction, metadata = {}, idempotencyKey }) {
  return request('/transfers', {
    body: {
      amount: toMinorUnits(amount, currency),
      currency: String(currency).toLowerCase(),
      destination,
      source_transaction: sourceTransaction,
      metadata,
    },
    idempotencyKey,
  })
}

/** Reverse a transfer, e.g. when a completed booking is later refunded. */
async function reverseTransfer(transferId, amount, currency = 'AED') {
  return request(`/transfers/${transferId}/reversals`, {
    body: amount === undefined ? {} : { amount: toMinorUnits(amount, currency) },
  })
}

/**
 * Refund a payment, optionally partially.
 * `amount` is in major units (AED), converted here.
 */
async function createRefund({ paymentIntentId, amount, currency = 'AED', reason }) {
  const body = { payment_intent: paymentIntentId }
  if (amount !== undefined) body.amount = toMinorUnits(amount, currency)
  // Stripe only accepts these three reasons.
  if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) body.reason = reason
  return request('/refunds', { body })
}

// ---------------------------------------------------------------------------
// Connect (artist payouts)
// ---------------------------------------------------------------------------

/**
 * Countries where an Express connected account may hold `card_payments`
 * (i.e. be the merchant of record). Elsewhere — the UAE included — Stripe
 * only allows `transfers`, and rejects account creation outright if
 * card_payments is requested:
 *   "The card_payments capability is not supported for this account type
 *    and this account's country (AE)."
 *
 * Transfers-only is fine for us: the platform takes the payment and Stripe
 * transfers the artist's share to them (a destination charge).
 */
const CARD_PAYMENTS_COUNTRIES = new Set([
  'US', 'CA', 'GB', 'AU', 'NZ', 'SG', 'JP', 'HK', 'MY', 'MX', 'BR',
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL',
  'PT', 'RO', 'SE', 'SI', 'SK',
])

/** Create an Express connected account for an artist. */
async function createConnectAccount({ email, country = env.stripe.connectCountry }) {
  const capabilities = { transfers: { requested: 'true' } }

  // Only ask for card_payments where Stripe actually allows it.
  if (CARD_PAYMENTS_COUNTRIES.has(String(country).toUpperCase())) {
    capabilities.card_payments = { requested: 'true' }
  }

  return request('/accounts', {
    body: { type: 'express', country, email, capabilities },
  })
}

/** One-time onboarding link the artist completes on Stripe. */
async function createAccountLink({ accountId, refreshUrl, returnUrl }) {
  return request('/account_links', {
    body: {
      account: accountId,
      refresh_url: refreshUrl,
      return_url: returnUrl,
      type: 'account_onboarding',
    },
  })
}

/** Current capability state of a connected account. */
async function retrieveAccount(accountId) {
  return request(`/accounts/${accountId}`, { method: 'GET' })
}

/** Link into the Stripe Express dashboard for an onboarded artist. */
async function createLoginLink(accountId) {
  return request(`/accounts/${accountId}/login_links`, { body: {} })
}

module.exports = {
  toMinorUnits,
  fromMinorUnits,
  createPaymentIntent,
  retrievePaymentIntent,
  createRefund,
  createTransfer,
  reverseTransfer,
  createConnectAccount,
  createAccountLink,
  retrieveAccount,
  createLoginLink,
}
