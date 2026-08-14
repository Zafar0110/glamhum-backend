// Email delivery (nodemailer).
//
// SPEED: the transporter is created ONCE and reused, with connection pooling
// on. Creating a transporter per email costs a full SMTP handshake (often
// 300-800ms on shared hosting like cPanel) — never do it per request.
//
// Nothing here is ever awaited inside a request handler. Callers use
// sendMailAsync(), which returns immediately and delivers in the background,
// so API response time does not depend on the mail server.

const path = require('path')
const nodemailer = require('nodemailer')
const env = require('../config/env')
const templates = require('./emailTemplates')

let transporter = null

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png')

/** Inline logo attachment referenced by the templates as cid:glamhub-logo. */
function logoAttachment() {
  return {
    filename: 'glamhub-logo.png',
    path: LOGO_PATH,
    cid: templates.LOGO_CID,
    contentDisposition: 'inline',
  }
}

function getTransporter() {
  if (transporter) return transporter
  if (!env.mail.configured) return null

  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure, // true for 465; false for 587/25 (STARTTLS)
    auth: { user: env.mail.user, pass: env.mail.password },
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })

  return transporter
}

/**
 * Queue an email. Returns immediately — never await this in a route handler.
 * When SMTP is not configured the message is logged instead, so the sign-up
 * flow still works locally without a mail server.
 */
function sendMailAsync({ to, subject, html, text, attachments = [] }) {
  const mailer = getTransporter()

  if (!mailer) {
    console.log(`[mail] SMTP not configured — would have sent to ${to}: ${subject}`)
    return
  }

  setImmediate(() => {
    mailer
      .sendMail({ from: env.mail.from, to, subject, html, text, attachments })
      .then((info) => console.log(`[mail] sent to ${to} — ${subject} (${info.messageId})`))
      .catch((error) => console.error(`[mail] FAILED to ${to}: ${error.message}`))
  })
}

/** Branded OTP email (see emailTemplates.js). */
function sendOtpEmail({ to, firstName, code, purpose }) {
  const { subject, html, text } = templates.otpEmail({ firstName, code, purpose })
  sendMailAsync({ to, subject, html, text, attachments: [logoAttachment()] })
}

/** Verify SMTP credentials. Used at boot and by scripts/test-email.js. */
async function verifyConnection() {
  const mailer = getTransporter()
  if (!mailer) return false
  await mailer.verify()
  return true
}

/** Blocking send — only for the CLI test script, never for a request. */
function sendMailNow(options) {
  const mailer = getTransporter()
  if (!mailer) throw new Error('SMTP is not configured (check MAIL_HOST / MAIL_USERNAME / MAIL_PASSWORD)')
  return mailer.sendMail({ from: env.mail.from, ...options })
}

module.exports = { sendMailAsync, sendOtpEmail, verifyConnection, sendMailNow, logoAttachment }
