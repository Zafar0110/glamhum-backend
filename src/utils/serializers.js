// DB row -> API shape.
//
// The frontend was originally written against a Mongo API, so every object it
// consumes carries BOTH `id` and `_id`, plus a computed `fullName`. Keeping
// that shape here means no page or component has to change.

const env = require('../config/env')

/**
 * Uploaded files are stored as '/uploads/x.png' but served by THIS server, not
 * by Next.js. Returning them absolute means every screen renders them without
 * needing to know the API origin. Anything else (already absolute, or a
 * bundled /images/... asset shipped with the frontend) is left alone.
 */
function absoluteUpload(url) {
  if (!url) return ''
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url
  if (url.startsWith('/uploads/')) return `${env.publicUrl}${url}`
  return url
}

/** Public user / artist object. Never includes password_hash. */
function serializeUser(row) {
  if (!row) return null

  const user = {
    id: row.id,
    _id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: [row.first_name, row.last_name].filter(Boolean).join(' '),
    username: row.username,
    email: row.email,
    phone: row.phone || '',
    countryCode: row.country_code || '',
    avatar: absoluteUpload(row.avatar || ''),
    role: row.role,
    isEmailVerified: Boolean(row.is_email_verified),
    isPhoneVerified: Boolean(row.is_phone_verified),
    // Account status. false = deactivated by an admin; sign-in is refused.
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }

  if (row.role === 'artist') {
    user.city = row.city || ''
    user.address = row.address || ''
    user.hasStudio = Boolean(row.has_studio)
    user.description = row.description || ''
    user.specialty = row.specialty || ''
    user.slug = row.slug || null
    user.yearsOfExperience = Number(row.years_of_experience || 0)
    user.approvalStatus = row.approval_status || 'pending'
    user.rejectionReason = row.rejection_reason || undefined
    user.approvedAt = row.approved_at || undefined
    user.submittedAt = row.submitted_at || undefined
    user.rating = Number(row.rating || 0)
    user.totalReviews = Number(row.total_reviews || 0)
    user.pricing = {
      minPrice: Number(row.min_price || 0),
      currency: row.currency || 'AED',
    }
  }

  return user
}

/** Service row (+ optional add-ons array). */
function serializeService(row, addOns = []) {
  if (!row) return null
  return {
    id: row.id,
    _id: row.id,
    artistId: row.artist_id,
    serviceName: row.service_name,
    serviceDescription: row.service_description || '',
    serviceType: row.service_type,
    priceType: row.price_type,
    price: Number(row.price),
    currency: row.currency,
    duration: row.duration,
    // false = archived: kept for history but hidden from clients.
    isActive: row.is_active === undefined ? true : Boolean(row.is_active),
    addOns: addOns.map((addOn) => ({
      id: addOn.id,
      name: addOn.name,
      price: Number(addOn.price),
      // The add-on form has always offered these two; they now survive a save.
      currency: addOn.currency || row.currency || 'AED',
      duration: addOn.duration || '',
    })),
  }
}

/** Appointment row. `services` = rows from appointment_services. */
function serializeAppointment(row, services = [], client = null, artist = null) {
  if (!row) return null
  return {
    id: row.id,
    _id: row.id,
    clientId: client ? serializeUser(client) : row.client_id,
    artistId: artist ? serializeUser(artist) : row.artist_id,
    services: services.map((service) => ({
      serviceName: service.service_name,
      price: Number(service.price),
      serviceType: service.service_type,
    })),
    serviceIds: services.map((service) => service.service_id),
    appointmentDate: row.appointment_date,
    appointmentTime:
      row.start_time && row.end_time
        ? `${String(row.start_time).slice(0, 5)} - ${String(row.end_time).slice(0, 5)}`
        : String(row.start_time || '').slice(0, 5),
    endTime: row.end_time ? String(row.end_time).slice(0, 5) : undefined,
    duration: row.duration_minutes || undefined,
    venue: row.venue,
    venueDetails: {
      venueName: row.venue_name || '',
      street: row.venue_street || '',
      city: row.venue_city || '',
      state: row.venue_state || '',
    },
    status: row.status,
    currency: row.currency,
    totalPrice: Number(row.total_price),
    serviceFee: Number(row.service_fee || 0),
    paymentMethod: row.payment_method,
    paymentStatus: row.payment_status,
    artistPayoutStatus: row.artist_payout_status,
    artistPayoutAmount: row.artist_payout_amount === null ? undefined : Number(row.artist_payout_amount),
    notes: row.notes || undefined,
    cancellationReason: row.cancellation_reason || undefined,
    createdAt: row.created_at,
  }
}

/** Review row (client fields come from a JOIN with users). */
function serializeReview(row) {
  if (!row) return null
  return {
    id: row.id,
    _id: row.id,
    artistId: row.artist_id,
    appointmentId: row.appointment_id,
    clientId: {
      _id: row.client_id,
      fullName: [row.client_first_name, row.client_last_name].filter(Boolean).join(' '),
      avatar: row.client_avatar || '',
    },
    rating: Number(row.rating),
    categories: {
      professionalism: Number(row.professionalism),
      communication: Number(row.communication),
      punctuality: Number(row.punctuality),
      value: Number(row.value_rating),
    },
    comment: row.comment || '',
    createdAt: row.created_at,
  }
}

/** Message row — must match the frontend's NewMessagePayload for socket parity. */
function serializeMessage(row) {
  if (!row) return null
  return {
    _id: row.id,
    id: row.id,
    message: row.message,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    appointmentId: row.appointment_id,
    isRead: Boolean(row.is_read),
    readAt: row.read_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  }
}

module.exports = {
  absoluteUpload,
  serializeUser,
  serializeService,
  serializeAppointment,
  serializeReview,
  serializeMessage,
}
