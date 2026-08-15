const Transaction = require('../models/Transaction');
const Appointment = require('../models/Appointment');
const mongoose = require('mongoose');
const { validationResult } = require('express-validator');
const { confirmPayment, createRefund, getPaymentIntent } = require('../services/stripeService');

// @desc    Process payment for booking
// @route   POST /api/client/payments/process
// @access  Private (Client only)
exports.processPayment = async (req, res, next) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Only clients can process payments'
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error',
        errors: errors.array()
      });
    }

    const { appointmentId, paymentIntentId } = req.body;
    const clientId = req.user.id;

    // Verify appointment exists and belongs to client
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: 'Appointment not found'
      });
    }

    if (appointment.clientId.toString() !== clientId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to process payment for this appointment'
      });
    }

    if (appointment.paymentMethod !== 'pay_now') {
      return res.status(400).json({
        success: false,
        message: 'This appointment is set to pay at venue'
      });
    }

    if (appointment.paymentStatus === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'Payment already processed'
      });
    }

    // Confirm payment with Stripe
    const paymentResult = await confirmPayment(paymentIntentId);

    if (!paymentResult.success || paymentResult.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'Payment failed',
        error: paymentResult.error
      });
    }

    // Mark payment as paid only — booking stays pending until the artist confirms
    appointment.paymentStatus = 'paid';
    await appointment.save();

    // Create transaction record
    const transaction = await Transaction.create({
      artistId: appointment.artistId,
      clientId: appointment.clientId,
      appointmentId: appointment._id,
      type: 'deposit',
      amount: appointment.totalAmount,
      currency: appointment.currency,
      status: 'succeeded',
      paymentMethod: 'card',
      transactionId: paymentIntentId,
      description: `Payment for appointment ${appointmentId}`,
      metadata: {
        paymentIntentId,
        appointmentId: appointmentId.toString()
      }
    });

    res.status(200).json({
      success: true,
      message: 'Payment processed successfully',
      data: {
        appointment,
        transaction
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payment intent status
// @route   GET /api/client/payments/intent/:paymentIntentId
// @access  Private (Client only)
exports.getPaymentIntentStatus = async (req, res, next) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Only clients can check payment status'
      });
    }

    const { paymentIntentId } = req.params;

    const paymentResult = await getPaymentIntent(paymentIntentId);

    if (!paymentResult.success) {
      return res.status(404).json({
        success: false,
        message: 'Payment intent not found',
        error: paymentResult.error
      });
    }

    res.status(200).json({
      success: true,
      data: {
        paymentIntent: paymentResult.paymentIntent
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Request refund for booking
// @route   POST /api/client/payments/refund
// @access  Private (Client only)
exports.requestRefund = async (req, res, next) => {
  try {
    if (req.user.role !== 'user') {
      return res.status(403).json({
        success: false,
        message: 'Only clients can request refunds'
      });
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation Error',
        errors: errors.array()
      });
    }

    const { appointmentId, reason } = req.body;
    const clientId = req.user.id;

    // Verify appointment exists and belongs to client
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({
        success: false,
        message: 'Appointment not found'
      });
    }

    if (appointment.clientId.toString() !== clientId) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to request refund for this appointment'
      });
    }

    if (appointment.paymentStatus !== 'paid') {
      return res.status(400).json({
        success: false,
        message: 'No payment found to refund'
      });
    }

    // Find transaction
    const transaction = await Transaction.findOne({
      appointmentId,
      type: 'deposit',
      status: 'succeeded'
    });

    if (!transaction || !transaction.transactionId) {
      return res.status(400).json({
        success: false,
        message: 'Transaction not found'
      });
    }

    // Create refund with Stripe
    const refundResult = await createRefund(transaction.transactionId);

    if (!refundResult.success) {
      return res.status(400).json({
        success: false,
        message: 'Refund failed',
        error: refundResult.error
      });
    }

    // Update appointment payment status
    appointment.paymentStatus = 'refunded';
    await appointment.save();

    // Create refund transaction record
    const refundTransaction = await Transaction.create({
      artistId: appointment.artistId,
      clientId: appointment.clientId,
      appointmentId: appointment._id,
      type: 'refund',
      amount: appointment.totalAmount,
      currency: appointment.currency,
      status: 'succeeded',
      paymentMethod: 'card',
      transactionId: refundResult.refund.id,
      description: `Refund for appointment ${appointmentId}. Reason: ${reason || 'Not provided'}`,
      metadata: {
        originalTransactionId: transaction.transactionId,
        refundId: refundResult.refund.id,
        reason: reason || ''
      }
    });

    res.status(200).json({
      success: true,
      message: 'Refund processed successfully',
      data: {
        refund: refundResult.refund,
        transaction: refundTransaction
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get payment statistics for artist
// @route   GET /api/artist/payments/stats
// @access  Private (Artist only)
exports.getArtistPaymentStats = async (req, res, next) => {
  try {
    if (req.user.role !== 'artist') {
      return res.status(403).json({
        success: false,
        message: 'Only artists can access payment stats'
      });
    }

    const artistIdStr = req.user.id;
    const artistId = new mongoose.Types.ObjectId(artistIdStr);
    const { period } = req.query;

    const dateFilter = {};
    if (period === 'month') {
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 1);
      dateFilter.createdAt = { $gte: startDate };
    } else if (period === 'week') {
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);
      dateFilter.createdAt = { $gte: startDate };
    }

    // Total Earned: sum of succeeded deposit transactions for this artist
    const totalEarnedData = await Transaction.aggregate([
      {
        $match: {
          artistId,
          type: 'deposit',
          status: 'succeeded',
          ...dateFilter
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);
    const totalEarnedAmount = totalEarnedData.length > 0 ? totalEarnedData[0].total : 0;

    // Total Withdrawals: sum of succeeded withdrawal transactions
    const totalWithdrawalData = await Transaction.aggregate([
      {
        $match: {
          artistId,
          type: 'withdrawal',
          status: 'succeeded',
          ...dateFilter
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);
    const totalWithdrawalAmount = totalWithdrawalData.length > 0 ? totalWithdrawalData[0].total : 0;

    // Payouts in transit: sum of in_transit or pending withdrawal transactions
    const payoutsInTransitData = await Transaction.aggregate([
      {
        $match: {
          artistId,
          type: 'withdrawal',
          status: { $in: ['in_transit', 'pending'] }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' }
        }
      }
    ]);
    const payoutsInTransitAmount = payoutsInTransitData.length > 0 ? payoutsInTransitData[0].total : 0;

    // Available Balance = Total Earned - Total Withdrawal - Payouts in Transit
    const availableBalance = Math.max(0, totalEarnedAmount - totalWithdrawalAmount - payoutsInTransitAmount);

    res.status(200).json({
      success: true,
      data: {
        availableBalance: {
          amount: parseFloat(availableBalance.toFixed(2)),
          currency: 'AED'
        },
        totalEarned: {
          amount: parseFloat(totalEarnedAmount.toFixed(2)),
          currency: 'AED',
          percentageChange: 12.5
        },
        payoutsInTransit: {
          amount: parseFloat(payoutsInTransitAmount.toFixed(2)),
          currency: 'AED'
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get transaction history for artist
// @route   GET /api/artist/payments/transactions
// @access  Private (Artist only)
exports.getArtistTransactions = async (req, res, next) => {
  try {
    if (req.user.role !== 'artist') {
      return res.status(403).json({
        success: false,
        message: 'Only artists can access transactions'
      });
    }

    const artistId = req.user.id;
    const { type, status, startDate, endDate, page = 1, limit = 20 } = req.query;

    const filter = { artistId };

    if (type && type !== 'all') {
      filter.type = type;
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const transactions = await Transaction.find(filter)
      .populate('clientId', 'firstName lastName avatar email phone')
      .populate({
        path: 'appointmentId',
        select: 'appointmentDate appointmentTime status totalAmount services',
        populate: {
          path: 'services.serviceId',
          select: 'title'
        }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    const total = await Transaction.countDocuments(filter);

    const artistObjectId = new mongoose.Types.ObjectId(artistId);

    const totalsData = await Transaction.aggregate([
      { $match: { artistId: artistObjectId, status: 'succeeded' } },
      {
        $group: {
          _id: '$type',
          sum: { $sum: '$amount' }
        }
      }
    ]);

    let totalEarned = 0;
    let totalWithdrawal = 0;

    totalsData.forEach(item => {
      if (item._id === 'deposit') totalEarned = item.sum;
      if (item._id === 'withdrawal') totalWithdrawal = item.sum;
    });

    res.status(200).json({
      success: true,
      count: transactions.length,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      data: {
        totalWithdrawal: parseFloat(totalWithdrawal.toFixed(2)),
        totalPayout: parseFloat(totalWithdrawal.toFixed(2)),
        totalEarned: parseFloat(totalEarned.toFixed(2)),
        transactions
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Request withdrawal to bank account for artist
// @route   POST /api/artist/payments/withdraw
// @access  Private (Artist only)
exports.requestWithdrawal = async (req, res, next) => {
  try {
    if (req.user.role !== 'artist') {
      return res.status(403).json({
        success: false,
        message: 'Only artists can request withdrawals'
      });
    }

    const { amount, bankDetails, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'A valid withdrawal amount is required'
      });
    }

    const artistIdStr = req.user.id;
    const artistId = new mongoose.Types.ObjectId(artistIdStr);

    const totalEarnedData = await Transaction.aggregate([
      { $match: { artistId, type: 'deposit', status: 'succeeded' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalEarned = totalEarnedData.length > 0 ? totalEarnedData[0].total : 0;

    const totalWithdrawalData = await Transaction.aggregate([
      { $match: { artistId, type: 'withdrawal', status: { $in: ['succeeded', 'in_transit', 'pending'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const totalWithdrawal = totalWithdrawalData.length > 0 ? totalWithdrawalData[0].total : 0;

    const availableBalance = totalEarned - totalWithdrawal;

    if (amount > availableBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Available balance is ${availableBalance} AED`
      });
    }

    const transaction = await Transaction.create({
      artistId: req.user.id,
      type: 'withdrawal',
      amount,
      currency: 'AED',
      status: 'in_transit',
      paymentMethod: bankDetails ? 'bank_transfer' : 'other',
      bankDetails: bankDetails || {},
      description: description || 'Withdrawal request to bank account',
      metadata: {
        requestedAt: new Date().toISOString()
      }
    });

    res.status(200).json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      data: {
        transaction
      }
    });
  } catch (error) {
    next(error);
  }
};
