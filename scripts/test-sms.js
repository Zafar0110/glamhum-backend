// Check the SMS setup, and optionally send a real test message.
//
//   node scripts/test-sms.js                      show config only
//   node scripts/test-sms.js +971501234567        send a real test SMS
//
// Use this to prove Twilio works before blaming the sign-up flow.

const env = require('../src/config/env')
const sms = require('../src/services/sms.service')

const target = process.argv[2]

async function main() {
  const mask = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '')

  console.log('[sms] config:')
  console.log(`  channel            ${env.otp.channel}`)
  console.log(`  phone code digits  ${env.otp.lengthFor('phone')}`)
  console.log(`  auth mode          ${env.sms.authMode}`)
  console.log(`  account sid        ${env.sms.accountSid ? mask(env.sms.accountSid) : 'MISSING  <-- required (starts AC…)'}`)
  console.log(`  api key sid        ${env.sms.apiKeySid ? mask(env.sms.apiKeySid) : '(not set)'}`)
  console.log(`  secret / token     ${env.sms.password ? `set (${env.sms.password.length} chars)` : 'MISSING'}`)
  console.log(`  from number        ${env.sms.from || 'MISSING  <-- required unless a messaging service is set'}`)
  console.log(`  messaging service  ${env.sms.messagingServiceSid || '(not set)'}`)
  console.log(`  configured         ${env.sms.configured}`)

  if (!env.sms.accountSid) {
    console.log('\n[sms] Account SID is missing.')
    console.log('[sms] An API key (SK…) authenticates but does not identify the account —')
    console.log('[sms] Twilio needs TWILIO_ACCOUNT_SID (AC…) in the request URL as well.')
    console.log('[sms] Find it on the Twilio Console home page under "Account Info".')
  }

  if (!target) {
    console.log('\nTo send a real test:  node scripts/test-sms.js +971501234567')
    return
  }

  const e164 = sms.toE164(target)
  if (!sms.isValidPhone(e164)) {
    console.error(`\n[sms] "${target}" is not a valid E.164 number. Use the full form, e.g. +971501234567`)
    process.exit(1)
  }

  if (!env.sms.configured) {
    console.error('\n[sms] Twilio is not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN')
    console.error('[sms] and TWILIO_PHONE_NUMBER (or TWILIO_MESSAGING_SERVICE_SID) in .env')
    process.exit(1)
  }

  console.log(`\n[sms] sending to ${e164}...`)
  const result = await sms.sendSmsNow({ to: e164, body: 'GlamHub test message — your SMS setup works.' })
  console.log(`[sms] sent — sid ${result.sid}, status ${result.status}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n[sms] FAILED: ${error.message}`)
    console.error('[sms] Common causes:')
    console.error('  - Trial account: the destination number must be verified in the Twilio console')
    console.error('  - Geo permissions: enable the destination country under Messaging > Geo permissions')
    console.error('  - The From number cannot send SMS to that country (UAE often needs an alphanumeric sender ID)')
    process.exit(1)
  })
