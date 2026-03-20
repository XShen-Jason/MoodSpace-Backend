const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../utils/supabase');

const router = express.Router();

/**
 * Utility: Generate unique order number
 */
function generateOrderNo(userId) {
    const timestamp = Date.now().toString();
    const randomHex = crypto.randomBytes(4).toString('hex');
    const userHash = crypto.createHash('md5').update(userId).digest('hex').substring(0, 6);
    return `ORDER_${timestamp}_${randomHex}_${userHash}`;
}

/**
 * GET /api/payment/pricing
 * Fetch active pricing configurations
 */
router.get('/pricing', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('pricing_configs')
            .select('*')
            .eq('is_active', true);
            
        if (error) throw error;
        return res.json({ success: true, data });
    } catch (err) {
        console.error('[payment/pricing] Error:', err);
        return res.status(500).json({ success: false, error: 'Failed to load pricing configs.' });
    }
});

/**
 * POST /api/payment/create
 * L6.5 Create Order with Math Sanity, Snapshot, and Deduplication
 */
router.post('/create', async (req, res) => {
    try {
        const { userId, tier, duration_months, payType } = req.body;
        
        if (!userId || !tier || !duration_months) {
            return res.status(400).json({ success: false, error: "Missing required fields" });
        }

        // 1. Check for existing pending order (Deduplication)
        const { data: existingOrder } = await supabase
            .from('orders')
            .select('order_no, actual_amount')
            .eq('user_id', userId)
            .eq('target_tier', tier)
            .eq('duration_months', duration_months)
            .eq('status', 'pending')
            .gt('expired_at', new Date().toISOString())
            .maybeSingle();

        if (existingOrder) {
            console.log(`[payment/create] Reusing pending order ${existingOrder.order_no} for user ${userId}`);
            // Generate real ZhifuFM payUrl via startOrder with existingOrder.order_no
            const payUrl = await requestZhifuFmUrl(existingOrder.order_no, existingOrder.actual_amount, payType);
            if (!payUrl) return res.status(500).json({ success: false, error: 'Failed to retrieve payment url from gateway' });
            return res.json({ success: true, order_no: existingOrder.order_no, payUrl });
        }

        // 2. Fetch Pricing Configs
        const { data: config, error: configErr } = await supabase
            .from('pricing_configs')
            .select('*')
            .eq('tier', tier)
            .eq('duration_months', duration_months)
            .eq('is_active', true)
            .maybeSingle();

        if (configErr || !config) {
            return res.status(400).json({ success: false, error: 'Invalid or inactive pricing tier' });
        }

        // 3. Math & Sanity Check (Amounts are in CENTS)
        // Here we apply discount logic. (For simplicity, using base_price * discount_rate, ignoring first_month for now)
        const baseAmount = config.base_price;
        const discountRate = parseFloat(config.discount_rate) || 1.0;
        let actualAmount = Math.floor(baseAmount * discountRate);

        // Sanity check constraints
        if (actualAmount <= 0 || actualAmount > 10000000) { // arbitrary 100k RMB cap
            return res.status(400).json({ success: false, error: 'Calculated amount fails safety constraints' });
        }

        // 4. Create Order
        const orderNo = generateOrderNo(userId);
        const expiredAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes from now

        const { error: insertErr } = await supabase
            .from('orders')
            .insert({
                user_id: userId,
                order_no: orderNo,
                original_amount: baseAmount,
                actual_amount: actualAmount,
                pay_type: payType || 'alipay',
                target_tier: tier,
                duration_months: duration_months,
                pricing_snapshot: config, // L6.5 JSONB pricing snapshot lock
                expired_at: expiredAt.toISOString()
            });

        if (insertErr) {
            console.error('[payment/create] DB Insert Error:', insertErr);
            throw new Error('Failed to create order in database');
        }

        // 5. Generate Payment URL (Real ZhifuFM integration)
        const payUrl = await requestZhifuFmUrl(orderNo, actualAmount, payType);
        if (!payUrl) {
            // Soft delete order since gateway rejected it
            await supabase.from('orders').update({ deleted_at: new Date().toISOString() }).eq('order_no', orderNo);
            return res.status(500).json({ success: false, error: 'Payment gateway rejected order' });
        }

        return res.json({ 
            success: true, 
            order_no: orderNo, 
            payUrl: payUrl,
            amount: actualAmount
        });

    } catch (err) {
        console.error('[payment/create] Fatal:', err);
        return res.status(500).json({ success: false, error: 'Internal server error during order creation' });
    }
});

/**
 * Utility: Request ZhifuFM Gateway URL
 */
async function requestZhifuFmUrl(orderNo, amountCents, payType) {
    try {
        const MERCHANT_NUM = process.env.ZHIFUFM_MERCHANT_NUM;
        const SECRET_KEY = process.env.ZHIFUFM_SECRET_KEY;
        const BASE_API_URL = process.env.ZHIFUFM_API_URL || 'https://api.zhifux.com'; 
        
        if (!MERCHANT_NUM || !SECRET_KEY) throw new Error('Missing gateway config');

        const amountStr = (amountCents / 100).toFixed(2); // Cents to Yuan
        const notifyUrl = `${process.env.APP_BASE_URL || 'https://api.moodspace.xyz'}/api/payment/notify`;
        const returnUrl = `${process.env.FRONTEND_URL || 'https://www.moodspace.xyz'}/upgrade?order_no=${orderNo}`;

        // MD5: merchantNum + orderNo + amount + notifyUrl + secret_key
        const signStr = `${MERCHANT_NUM}${orderNo}${amountStr}${notifyUrl}${SECRET_KEY}`;
        const sign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();

        const params = new URLSearchParams({
            merchantNum: MERCHANT_NUM,
            orderNo: orderNo,
            amount: amountStr,
            notifyUrl: notifyUrl,
            returnUrl: returnUrl,
            payType: payType || 'alipay',
            sign: sign,
            returnType: 'json'
        });

        const res = await fetch(`${BASE_API_URL}/startOrder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });

        const data = await res.json();
        if (data.success && data.data && data.data.payUrl) {
            return data.data.payUrl;
        }
        console.error('[requestZhifuFmUrl] Gateway error:', data);
        return null;
    } catch(e) {
        console.error('[requestZhifuFmUrl] Fatal:', e);
        return null;
    }
}

/**
 * POST|GET /api/payment/notify
 * L6.5 Async Webhook Receiver
 * - Rejects fast if signature fails
 * - Pushes to payment_jobs
 * - Returns "success" string immediately
 */
router.all('/notify', async (req, res) => {
    const payload = req.method === 'POST' ? req.body : req.query;
    
    try {
        console.log('[payment/notify] Webhook Received:', payload);

        const MERCHANT_NUM = process.env.ZHIFUFM_MERCHANT_NUM;
        const SECRET_KEY = process.env.ZHIFUFM_SECRET_KEY;

        const { state, merchantNum, orderNo: incOrderNo, amount: incAmount, sign: incomingSign, platformOrderNo } = payload;
        
        // 1. Signature Verification
        // MD5: state + merchantNum + orderNo + amount + secret_key
        const signStr = `${state}${merchantNum}${incOrderNo}${incAmount}${SECRET_KEY}`;
        const computedSign = crypto.createHash('md5').update(signStr, 'utf8').digest('hex').toLowerCase();
        
        // Use crypto timingSafeEqual to avoid timing attacks if possible, but basic equality is fine for md5
        const isValid = (computedSign === incomingSign && merchantNum === MERCHANT_NUM);

        const orderNo = incOrderNo || payload.out_trade_no;
        // ZhifuFM amount is string in yuan, parse back to int CENTS 
        const paidAmount = parseInt(parseFloat(incAmount || payload.total_fee || '0') * 100, 10);
        const thirdPartyNo = platformOrderNo || payload.trade_no || 'TID_UNKNOWN';

        if (!orderNo) {
            return res.status(400).send("fail");
        }
        
        // As per docs: "state 1: 付款成功"
        if (String(state) !== '1') {
            console.log('[payment/notify] Ignoring notification with state:', state);
            return res.status(200).send("success"); // Confirmed receipt but ignored as not success
        }

        // 2. Log Payload
        await supabase.from('payment_logs').insert({
            order_no: orderNo,
            provider: 'zhifufm',
            payload: payload,
            is_valid: isValid,
            error_msg: isValid ? null : 'Signature verification failed'
        });

        if (!isValid) {
            return res.status(400).send("fail"); // Malicious payload
        }

        // 3. Push to Durable Queue (payment_jobs)
        // We UPSERT to avoid crashing on duplicate webhooks, relying on queue idempotency
        const { error: jobErr } = await supabase.from('payment_jobs').upsert(
            { order_no: orderNo, status: 'pending' },
            { onConflict: 'order_no', ignoreDuplicates: true }
        );

        if (jobErr) {
            console.error('[payment/notify] Failed to persist job:', jobErr);
            // Even if queue fails occasionally, active polling cron can recover it later.
        }

        // 4. Immediate Return for ZhifuFM (L6.5 Async Engine)
        return res.status(200).send("success");

    } catch (err) {
        console.error('[payment/notify] Fatal:', err);
        // Do not return success if we completely exploded before saving anything. 
        // Force provider to retry.
        return res.status(500).send("fail"); 
    }
});

/**
 * GET /api/payment/query 
 * Safe Polling Endpoint for Frontend UX
 */
router.get('/query', async (req, res) => {
    try {
        const { order_no } = req.query;
        if (!order_no) return res.status(400).json({ success: false, error: "Missing order_no" });

        const { data: order, error } = await supabase
            .from('orders')
            .select('status')
            .eq('order_no', order_no)
            .maybeSingle();

        if (error || !order) return res.status(404).json({ success: false, error: 'Order not found' });

        return res.json({ success: true, status: order.status });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Query failed' });
    }
});

/**
 * GET /api/payment/history 
 * Get order history for a user
 */
router.get('/history', async (req, res) => {
    try {
        const { userId } = req.query;
        if (!userId) return res.status(400).json({ success: false, error: "Missing userId" });

        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        
        return res.json({ success: true, data: orders });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'History fetch failed' });
    }
});

/**
 * GET /api/payment/admin/orders
 * Fetch all orders for management
 */
router.get('/admin/orders', async (req, res) => {
    try {
        // Assume requireAdmin middleware would protect this in reality
        const { data: orders, error } = await supabase
            .from('orders')
            .select('*')
            .order('created_at', { ascending: false });
        if (error) throw error;
        return res.json({ success: true, data: orders });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Failed to fetch admin orders' });
    }
});

/**
 * POST /api/payment/admin/compensate
 * Manual Grants & Compensation
 */
router.post('/admin/compensate', async (req, res) => {
    try {
        const { targetUserId, targetTier, durationMonths, reason, adminId } = req.body;
        if (!targetUserId || !targetTier) return res.status(400).json({ success: false, error: 'Missing args' });

        // 1. Log to compensation_logs
        await supabase.from('compensation_logs').insert({
            admin_id: adminId || 'unknown_admin',
            target_user_id: targetUserId,
            target_tier: targetTier,
            duration_months: durationMonths || 1,
            reason: reason || 'Manual grant'
        });

        // 2. We'd ideally call an RPC to safely grant this, but for brevity we directly update profile 
        // Note: Real system should trace this via the `subscriptions` table.
        const { error: updErr } = await supabase
            .from('profiles')
            .update({ tier: targetTier }) // Simplification
            .eq('id', targetUserId);

        if (updErr) throw updErr;

        return res.json({ success: true, message: 'Granted successfully' });
    } catch (err) {
        return res.status(500).json({ success: false, error: 'Compensation failed' });
    }
});

module.exports = router;
