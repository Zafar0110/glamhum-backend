 

const env = require('../config/env')

const TWILIO_BASE = 'https://api.twilio.com/2010-04-01'

 
function toE164(phone, countryCode = '') {
  const digits = String(phone || '').replace(/\D/g, '')
  if (!digits) return ''

   
  if (String(phone).trim().startsWith('+')) return `+${digits}`

  const cc = String(countryCode || '').replace(/\D/g, '')
  if (!cc) return `+${digits}`

  // Local numbers are usually written  
  const national = digits.startsWith(cc) ? digits.slice(cc.length) : digits
  return `+${cc}${national.replace(/^0+/, '')}`
}

//Basic sanity check before we bother
function isValidPhone(e164) {
  return /^\+[1-9]\d{7,14}$/.test(e164)
}

async function deliver(to, body) {
  const { accountSid, username, password, from, messagingServiceSid } = env.sms

  const params = new URLSearchParams({ To: to, Body: body })
  if (messagingServiceSid) params.set('MessagingServiceSid', messagingServiceSid)
  else params.set('From', from)

  
  const response = await fetch(`${TWILIO_BASE}/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
     
    const error = new Error(result.message || `Twilio responded ${response.status}`)
    error.twilioCode = Number(result.code) || null
    throw error
  }
  return result
}

 
const UNREACHABLE_CODES = new Set([
  21612,  
  21408,  
  21610,  
  30003,  
  30005,  
  30006, 
])

 
async function confirmDelivery(sid, attempts = 4, delayMs = 2500) {
  const { accountSid, username, password } = env.sms

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))

    const response = await fetch(`${TWILIO_BASE}/Accounts/${accountSid}/Messages/${sid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` },
    })
    if (!response.ok) continue

    const message = await response.json()
    if (['delivered', 'sent'].includes(message.status)) return { ok: true, status: message.status }
    if (['failed', 'undelivered'].includes(message.status)) {
      return {
        ok: false,
        status: message.status,
        errorCode: Number(message.error_code) || null,
        errorMessage: message.error_message || '',
      }
    }
  }

  
  return { ok: true, status: 'pending' }
}

 
async function trySendSms({ to, body }) {
  if (!env.sms.configured) {
    console.log(`[sms] not configured — would have sent to ${to}: ${body}`)
    return { ok: false, reason: 'not_configured' }
  }

  try {
    const result = await deliver(to, body)
    console.log(`[sms] queued for ${to} (${result.sid})`)
    return { ok: true, sid: result.sid }
  } catch (error) {
    const code = error.twilioCode || null
    console.error(`[sms] REJECTED for ${to}${code ? ` (error ${code})` : ''}: ${error.message}`)
    return { ok: false, reason: 'rejected', errorCode: code, errorMessage: error.message }
  }
}

 
function watchDelivery({ to, sid, onFailure }) {
  setImmediate(async () => {
    try {
      const outcome = await confirmDelivery(sid)
      if (outcome.ok) {
        console.log(`[sms] ${to} -> ${outcome.status}`)
        return
      }
      console.error(
        `[sms] NOT DELIVERED to ${to} — status ${outcome.status}, error ${outcome.errorCode} ${outcome.errorMessage}`
      )
      if (onFailure) onFailure(outcome)
    } catch (error) {
      console.error(`[sms] delivery check failed for ${to}: ${error.message}`)
    }
  })
}

function sendSmsAsync({ to, body, onFailure }) {
  if (!env.sms.configured) {
    console.log(`[sms] not configured — would have sent to ${to}: ${body}`)
    return
  }

  setImmediate(async () => {
    try {
      const result = await deliver(to, body)
      console.log(`[sms] queued for ${to} (${result.sid})`)

      const outcome = await confirmDelivery(result.sid)
      if (outcome.ok) {
        console.log(`[sms] ${to} -> ${outcome.status}`)
        return
      }

      console.error(
        `[sms] NOT DELIVERED to ${to} — status ${outcome.status}, error ${outcome.errorCode} ${outcome.errorMessage}`
      )
      if (outcome.errorCode === 21612) {
        console.error(
          `[sms] 21612 means your From number (${env.sms.from}) cannot route SMS to that country.`
        )
      }

      if (onFailure) onFailure(outcome)
    } catch (error) {
      const code = error.twilioCode || null
      console.error(`[sms] FAILED to ${to}${code ? ` (error ${code})` : ''}: ${error.message}`)
      if (code === 21612) {
        console.error(
          `[sms] 21612 — your From number (${env.sms.from}) cannot route SMS to that country.`
        )
      }
      if (onFailure) {
        onFailure({ ok: false, status: 'failed', errorCode: code, errorMessage: error.message })
      }
    }
  })
}

//verification text itself.
function otpMessage(code) {
  return `${code} is your GlamHub verification code. It expires in ${env.otp.expiresMinutes} minutes. Do not share it with anyone.`
}

function sendOtpSms({ to, code, onFailure }) {
  sendSmsAsync({ to, body: otpMessage(code), onFailure })
}

/** True when the failure means SMS will never work for this number. */
function isUnreachable(outcome) {
  return Boolean(outcome && outcome.errorCode && UNREACHABLE_CODES.has(outcome.errorCode))
}

 

const VERIFY_BASE = 'https://verify.twilio.com/v2'

function verifyAuthHeader() {
  const { username, password } = env.sms
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

//Ask Twilio to send a verification
async function startVerification(to, channel = 'sms') {
  const response = await fetch(`${VERIFY_BASE}/Services/${env.sms.verifyServiceSid}/Verifications`, {
    method: 'POST',
    headers: {
      Authorization: verifyAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, Channel: channel }),
  })

  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(result.message || `Twilio Verify responded ${response.status}`)
    error.twilioCode = Number(result.code) || null
    throw error
  }
  return result  
}

 
async function checkVerification(to, code) {
  const response = await fetch(
    `${VERIFY_BASE}/Services/${env.sms.verifyServiceSid}/VerificationCheck`,
    {
      method: 'POST',
      headers: {
        Authorization: verifyAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, Code: code }),
    }
  )

  const result = await response.json().catch(() => ({}))

  // 404 means there is no pending  
  if (response.status === 404) return { approved: false, reason: 'expired' }

  if (!response.ok) {
    const error = new Error(result.message || `Twilio Verify responded ${response.status}`)
    error.twilioCode = Number(result.code) || null
    throw error
  }

  return { approved: result.status === 'approved', reason: result.status }
}

// Blocking send,  
async function sendSmsNow({ to, body }) {
  if (!env.sms.configured) {
    throw new Error('SMS is not configured (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_PHONE_NUMBER)')
  }
  return deliver(to, body)
}

module.exports = {
  sendSmsAsync,
  trySendSms,
  watchDelivery,
  otpMessage,
  startVerification,
  checkVerification,
  sendOtpSms,
  sendSmsNow,
  toE164,
  isValidPhone,
  isUnreachable,
  UNREACHABLE_CODES,
}
