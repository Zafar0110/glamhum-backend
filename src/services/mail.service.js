 

const path = require('path')
const nodemailer = require('nodemailer')
const env = require('../config/env')
const templates = require('./emailTemplates')

let transporter = null

const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo.png')

//Inline logo attachment referenced
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
    secure: env.mail.secure, 
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

//Branded OTP email
function sendOtpEmail({ to, firstName, code, purpose }) {
  const { subject, html, text } = templates.otpEmail({ firstName, code, purpose })
  sendMailAsync({ to, subject, html, text, attachments: [logoAttachment()] })
}

// Where links in emails should  
const appUrl = () => env.clientUrls[0] || 'http://localhost:3000'

//Artist finished onboarding
function sendArtistSubmittedEmail({ to, firstName }) {
  const { subject, html, text } = templates.artistSubmittedEmail({ firstName, appUrl: appUrl() })
  sendMailAsync({ to, subject, html, text, attachments: [logoAttachment()] })
}

//Admin approved the artist
function sendArtistApprovedEmail({ to, firstName }) {
  const { subject, html, text } = templates.artistApprovedEmail({ firstName, appUrl: appUrl() })
  sendMailAsync({ to, subject, html, text, attachments: [logoAttachment()] })
}

// Admin rejected the artist 
function sendArtistRejectedEmail({ to, firstName, reason }) {
  const { subject, html, text } = templates.artistRejectedEmail({ firstName, reason, appUrl: appUrl() })
  sendMailAsync({ to, subject, html, text, attachments: [logoAttachment()] })
}

// Verify SMTP credentials.  
async function verifyConnection() {
  const mailer = getTransporter()
  if (!mailer) return false
  await mailer.verify()
  return true
}

//Blocking send 
function sendMailNow(options) {
  const mailer = getTransporter()
  if (!mailer) throw new Error('SMTP is not configured (check MAIL_HOST / MAIL_USERNAME / MAIL_PASSWORD)')
  return mailer.sendMail({ from: env.mail.from, ...options })
}

module.exports = {
  sendMailAsync,
  sendOtpEmail,
  sendArtistSubmittedEmail,
  sendArtistApprovedEmail,
  sendArtistRejectedEmail,
  verifyConnection,
  sendMailNow,
  logoAttachment,
}
