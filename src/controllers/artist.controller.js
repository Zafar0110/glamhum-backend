// Artist-side onboarding: submitting the finished profile for admin review.
// (The dashboard endpoints — appointments, schedule, payments, messages —
// still live as stubs in routes/artist.routes.js.)

const { query, queryOne } = require('../config/db')
const ApiError = require('../utils/ApiError')
const { success } = require('../utils/response')
const { serializeUser } = require('../utils/serializers')
const mail = require('../services/mail.service')

/** What still has to be filled in before a profile can be reviewed. */
async function missingRequirements(artistId, user) {
  const missing = []

  if (!user.city || !String(user.city).trim()) missing.push('city')
  if (!user.description || !String(user.description).trim()) missing.push('description')
  if (user.has_studio && !(user.address || '').trim()) missing.push('address')

  const [{ services }] = await query(
    'SELECT COUNT(*) AS services FROM services WHERE artist_id = ? AND is_active = 1',
    [artistId]
  )
  if (!services) missing.push('services')

  const [{ images }] = await query(
    'SELECT COUNT(*) AS images FROM portfolio_images WHERE artist_id = ?',
    [artistId]
  )
  if (!images) missing.push('portfolio')

  return missing
}

/**
 * GET /api/artist/profile-status
 * Drives the onboarding success screen and the dashboard banner.
 */
exports.getProfileStatus = async (req, res) => {
  const user = req.user
  const missing = await missingRequirements(user.id, user)

  return success(res, {
    approvalStatus: user.approval_status || 'pending',
    submittedAt: user.submitted_at || null,
    approvedAt: user.approved_at || null,
    rejectionReason: user.rejection_reason || null,
    isComplete: missing.length === 0,
    missing,
  })
}

/**
 * POST /api/artist/submit-profile
 * Ends onboarding step 3. Moves the artist into the admin queue and emails
 * them a confirmation.
 */
exports.submitProfile = async (req, res) => {
  const user = req.user

  if (user.approval_status === 'approved') {
    return success(
      res,
      { approvalStatus: 'approved', alreadyApproved: true },
      'Your profile is already approved'
    )
  }

  const missing = await missingRequirements(user.id, user)

  // Sent back so the UI can say exactly what is missing rather than
  // "something went wrong".
  if (missing.length) {
    throw ApiError.validation(
      {
        city: missing.includes('city') ? 'Add the city you work in' : undefined,
        description: missing.includes('description') ? 'Add a short description about you' : undefined,
        address: missing.includes('address') ? 'Add your studio address' : undefined,
        services: missing.includes('services') ? 'Add at least one service' : undefined,
        portfolio: missing.includes('portfolio') ? 'Add at least one portfolio image' : undefined,
      },
      'Please finish your profile before submitting it for review'
    )
  }

  const now = new Date()
  await query(
    `UPDATE users
        SET approval_status = 'pending', submitted_at = ?, rejection_reason = NULL, updated_at = ?
      WHERE id = ?`,
    [now, now, user.id]
  )

  mail.sendArtistSubmittedEmail({ to: user.email, firstName: user.first_name })

  const updated = await queryOne('SELECT * FROM users WHERE id = ?', [user.id])
  return success(
    res,
    { user: serializeUser(updated), approvalStatus: 'pending', submittedAt: now },
    'Profile submitted for review'
  )
}
