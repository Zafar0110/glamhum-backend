 

const env = require('../config/env')

const STRIPE_BASE = 'https://api.stripe.com/v1'

 
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

 
async function createPaymentIntent({ amount, currency = 'AED', metadata = {}, connectedAccountId, applicationFee, idempotencyKey }) {
  const body = {
    amount: toMinorUnits(amount, currency),
    currency: String(currency).toLowerCase(),
   
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

 async function reverseTransfer(transferId, amount, currency = 'AED') {
  return request(`/transfers/${transferId}/reversals`, {
    body: amount === undefined ? {} : { amount: toMinorUnits(amount, currency) },
  })
}

 
async function createRefund({ paymentIntentId, amount, currency = 'AED', reason }) {
  const body = { payment_intent: paymentIntentId }
  if (amount !== undefined) body.amount = toMinorUnits(amount, currency)
  // Stripe only accepts these three reasons.
  if (['duplicate', 'fraudulent', 'requested_by_customer'].includes(reason)) body.reason = reason
  return request('/refunds', { body })
}

 
const CARD_PAYMENTS_COUNTRIES = new Set([
  'US', 'CA', 'GB', 'AU', 'NZ', 'SG', 'JP', 'HK', 'MY', 'MX', 'BR',
  'AT', 'BE', 'BG', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR',
  'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'NO', 'PL',
  'PT', 'RO', 'SE', 'SI', 'SK',
])

 
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

//One-time onboarding
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

//Current capability state
async function retrieveAccount(accountId) {
  return request(`/accounts/${accountId}`, { method: 'GET' })
}

//Link into the Stripe Express
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
