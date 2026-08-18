 
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

  

  if (!env.mail.configured) {
    console.error('\n[mail] SMTP is not configured — set MAIL_HOST, MAIL_USERNAME and MAIL_PASSWORD in .env')
    process.exit(1)
  }

 
  await mail.verifyConnection() 
  const info = await mail.sendMailNow({
    to: arg,
    subject,
    html,
    text,
    attachments: [mail.logoAttachment()],
  }) 
  if (info.rejected.length) console.log(`[mail] rejected: ${info.rejected.join(', ')}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n[mail] FAILED: ${error.message}`)
    if (error.code === 'EAUTH') {
      console.error('[mail] authentication rejected.') 
    }
    if (error.code === 'ETIMEDOUT' || error.code === 'ESOCKET') {
      console.error('[mail] could not reach the SMTP host — check the port, or a firewall/antivirus blocking it.')
    }
    process.exit(1)
  })
