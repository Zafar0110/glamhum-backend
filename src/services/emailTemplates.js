// GlamHub email templates.
//
// Built for real inboxes, not browsers: table-based layout, inline styles only,
// no flexbox/grid, no web fonts, no external CSS. Gmail, Outlook and Apple Mail
// all strip <style> blocks or ignore modern CSS, so everything is inlined.
//
// The logo is attached as an inline CID image (src/assets/logo.png) rather than
// a hosted URL — CID images render even when the client blocks remote content,
// which Gmail and Outlook both do by default for unknown senders.

const env = require('../config/env')

// Site palette (frontend/tailwind.config.ts)
const COLORS = {
  navy: '#091E4A',
  navyLight: '#0c275f',
  pink: '#d4a5a5',
  coral: '#e8b4b4',
  cream: '#fdf5f3',
  peach: '#fce8e2',
  border: '#EFE6E3',
  muted: '#8A8580',
  bodyText: '#4B5563',
}

const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif"
const SANS = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif"

const LOGO_CID = 'glamhub-logo'

/**
 * Shared shell: cream backdrop, white rounded card, logo header, footer.
 * `content` is the inner HTML of the card.
 */
function layout({ title, content, preheader = '' }) {
  const year = new Date().getFullYear()

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.cream};font-family:${SANS};">

  <!-- Preview line shown in the inbox list, hidden in the body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:${COLORS.cream};padding:32px 16px;">
    <tr>
      <td align="center">

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:560px;width:100%;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:24px;">
              <img src="cid:${LOGO_CID}" alt="GlamHub" width="132"
                   style="display:block;border:0;outline:none;width:132px;height:auto;">
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#ffffff;border-radius:20px;border:1px solid ${COLORS.border};
                       padding:40px 32px;">
              ${content}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:24px;">
              <p style="margin:0 0 6px;font-family:${SANS};font-size:12px;color:${COLORS.muted};">
                Bridal hair &amp; makeup artists, booked in minutes.
              </p>
              <p style="margin:0;font-family:${SANS};font-size:12px;color:${COLORS.muted};">
                &copy; ${year} GlamHub. All rights reserved.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/** Heading with the pink underline used across the site. */
function heading(text) {
  return `
    <h1 style="margin:0 0 4px;font-family:${SERIF};font-size:28px;line-height:1.25;
               font-weight:400;color:${COLORS.navy};text-align:center;">
      ${text}
    </h1>
    <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 20px;">
      <tr><td style="width:64px;height:2px;background-color:${COLORS.pink};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>`
}

/** The code itself: one box per digit, peach fill, navy numerals. */
function codeBlock(code) {
  const digits = String(code)
    .split('')
    .map(
      (digit) => `
        <td align="center" style="padding:0 5px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td align="center"
                  style="width:52px;height:60px;background-color:${COLORS.peach};
                         border:1px solid ${COLORS.coral};border-radius:12px;
                         font-family:${SANS};font-size:28px;font-weight:600;
                         color:${COLORS.navy};text-align:center;">
                ${digit}
              </td>
            </tr>
          </table>
        </td>`
    )
    .join('')

  return `
    <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto;">
      <tr>${digits}</tr>
    </table>`
}

/** Verification / password-reset code email. */
function otpEmail({ firstName, code, purpose }) {
  const isReset = purpose === 'forgot_password'

  const title = isReset ? 'Reset your password' : 'Confirm your email'
  const intro = isReset
    ? 'We received a request to reset your GlamHub password. Enter the code below to choose a new one.'
    : 'Welcome to GlamHub! Enter the code below to confirm your email address and finish setting up your account.'

  const greeting = firstName ? `Hi ${firstName},` : 'Hi there,'

  const content = `
    ${heading(title)}

    <p style="margin:0 0 4px;font-family:${SANS};font-size:15px;line-height:1.6;color:${COLORS.navy};font-weight:600;">
      ${greeting}
    </p>
    <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${COLORS.bodyText};">
      ${intro}
    </p>

    ${codeBlock(code)}

    <p style="margin:0 0 24px;font-family:${SANS};font-size:13px;line-height:1.6;
              color:${COLORS.muted};text-align:center;">
      This code expires in ${env.otp.expiresMinutes} minutes.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="height:1px;background-color:${COLORS.border};font-size:0;line-height:0;">&nbsp;</td></tr>
    </table>

    <p style="margin:20px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${COLORS.muted};">
      ${
        isReset
          ? "Didn't ask to reset your password? You can safely ignore this email — your password stays unchanged."
          : "Didn't create a GlamHub account? You can safely ignore this email."
      }
    </p>`

  return {
    subject: `${code} is your GlamHub ${isReset ? 'password reset' : 'confirmation'} code`,
    html: layout({
      title,
      preheader: `Your GlamHub code is ${code}. It expires in ${env.otp.expiresMinutes} minutes.`,
      content,
    }),
    // Plain-text alternative — improves deliverability and covers text-only clients.
    text: [
      greeting,
      '',
      intro,
      '',
      `Your code: ${code}`,
      `This code expires in ${env.otp.expiresMinutes} minutes.`,
      '',
      isReset
        ? "If you didn't request this, ignore this email — your password stays unchanged."
        : "If you didn't create a GlamHub account, you can ignore this email.",
      '',
      'GlamHub',
    ].join('\n'),
  }
}

module.exports = { layout, heading, codeBlock, otpEmail, COLORS, LOGO_CID }
