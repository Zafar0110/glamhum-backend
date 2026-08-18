 

const env = require('../src/config/env')
const sms = require('../src/services/sms.service')

const target = process.argv[2]

async function main() {
  const mask = (value) => (value ? `${value.slice(0, 6)}…${value.slice(-4)}` : '') 
  if (!env.sms.accountSid) {
    console.log('\n[sms] Account SID is missing.') 
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
    process.exit(1)
  })
