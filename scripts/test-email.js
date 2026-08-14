// Send a real test email, or write the template to an HTML file to preview it.
//
//   node scripts/test-email.js you@example.com     send a live test
//   node scripts/test-email.js --preview           write preview.html, send nothing
//
// Use this to prove SMTP works before blaming the sign-up flow.

const fs = require('fs')
const path = require('path')
const env = require('../src/config/env')
const templates = require('../src/services/emailTemplates')
const mail = require('../src/services/mail.service')

const arg = process.argv[2]
const SAMPLE_CODE = '4821'.slice(0, env.otp.length).padEnd(env.otp.length, '7')

async function main() {
  const { subject, html, text } = templates.otpEmail({
    firstName: 'Sarah',
    code: SAMPLE_CODE,
    purpose: 'signup',
  })

  if (arg === '--preview' || !arg) {
    const outPath = path.join(__dirname, '..', 'preview-email.html')
    // Swap the CID for the real file so it renders in a browser.
    const previewHtml = html.replace(
      `cid:${templates.LOGO_CID}`,
      'data:image/png;base64,' +
        fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'logo.png')).toString('base64')
    )
    fs.writeFileSync(outPath, previewHtml)
    console.log(`[preview] written to ${outPath}`)
    console.log('[preview] open it in a browser to check the design')
    if (!arg) console.log('\nTo send a real test:  node scripts/test-email.js you@example.com')
    return
  }

  console.log('[mail] config:')
  console.log(`  host      ${env.mail.host}:${env.mail.port}`)
  console.log(`  secure    ${env.mail.secure}`)
  console.log(`  user      ${env.mail.user}`)
  console.log(`  password  ${env.mail.password ? `set (${env.mail.password.length} chars)` : 'MISSING'}`)
  console.log(`  from      ${env.mail.from}`)
  console.log(`  configured ${env.mail.configured}`)

  if (!env.mail.configured) {
    console.error('\n[mail] SMTP is not configured — set MAIL_HOST, MAIL_USERNAME and MAIL_PASSWORD in .env')
    process.exit(1)
  }

  console.log('\n[mail] verifying connection...')
  await mail.verifyConnection()
  console.log('[mail] connection OK')

  console.log(`[mail] sending to ${arg}...`)
  const info = await mail.sendMailNow({
    to: arg,
    subject,
    html,
    text,
    attachments: [mail.logoAttachment()],
  })
  console.log(`[mail] sent — messageId ${info.messageId}`)
  console.log(`[mail] accepted: ${info.accepted.join(', ')}`)
  if (info.rejected.length) console.log(`[mail] rejected: ${info.rejected.join(', ')}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n[mail] FAILED: ${error.message}`)
    if (error.code === 'EAUTH') {
      console.error('[mail] authentication rejected.')
      console.error('[mail] Gmail requires a 16-character App Password (not your normal password),')
      console.error('[mail] with 2-Step Verification switched on for that Google account.')
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKET') {
      console.error('[mail] could not reach the SMTP host — check the port, or a firewall/antivirus blocking it.')
    }
    process.exit(1)
  })
