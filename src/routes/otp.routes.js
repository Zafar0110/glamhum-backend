const express = require('express')
const rateLimit = require('express-rate-limit')
const asyncHandler = require('../utils/asyncHandler')
const { optionalAuth } = require('../middleware/auth')
const controller = require('../controllers/otp.controller')

const router = express.Router()

// Codes cost an email each — cap how often one IP can ask for them.
const sendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many code requests. Please wait a few minutes.' },
})

 
router.post('/send-phone', sendLimiter, optionalAuth, asyncHandler(controller.sendPhoneOTP))
router.post('/verify-phone', optionalAuth, asyncHandler(controller.verifyPhoneOTP))

// Email OTP  
 
router.post('/send-email', sendLimiter, asyncHandler(controller.sendEmailOTP))
router.post('/verify-email', asyncHandler(controller.verifyEmailOTP))

router.post('/resend', sendLimiter, optionalAuth, asyncHandler(controller.resendOTP))

 
router.get('/delivery-status', asyncHandler(controller.getDeliveryStatus))

module.exports = router
