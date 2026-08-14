const express = require('express')
const asyncHandler = require('../utils/asyncHandler')
const { optionalAuth } = require('../middleware/auth')
const controller = require('../controllers/otp.controller')

const router = express.Router()

// optionalAuth: during sign-up the user may or may not already hold a token.
router.post('/send', optionalAuth, asyncHandler(controller.sendPhoneOTP))
router.post('/verify', optionalAuth, asyncHandler(controller.verifyOTP))
router.post('/resend', optionalAuth, asyncHandler(controller.resendOTP))

module.exports = router
