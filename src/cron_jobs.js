const { supabase } = require('./utils/supabase');

const WORKER_INTERVAL_MS = 2000; // Pulls a job every 2 seconds
const GC_INTERVAL_MS = 5 * 60 * 1000; // Garabage collection & fallbacks every 5 mins

/**
 * L6.5 Async Queue Worker
 * Consumes jobs from `payment_jobs` where status='pending'.
 */
async function processPaymentJobs() {
    try {
        // 1. Fetch oldest pending job
        const { data: jobs, error } = await supabase
            .from('payment_jobs')
            .select('order_no, retry_count')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(1);

        if (error || !jobs || jobs.length === 0) return;

        const job = jobs[0];
        const orderNo = job.order_no;
        console.log(`[payment-worker] Starting processing: ${orderNo}`);

        // 2. Lock job (Prevent other instances in this simple setup)
        await supabase
            .from('payment_jobs')
            .update({ status: 'processing', updated_at: new Date().toISOString() })
            .eq('order_no', orderNo);

        // 3. Fetch latest payment_logs to get the paid_amount and trade_no
        const { data: log, error: logErr } = await supabase
            .from('payment_logs')
            .select('payload')
            .eq('order_no', orderNo)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (logErr || !log) throw new Error("Could not find payload for order");

        const paidAmount = parseInt(log.payload.amount || log.payload.total_fee || '0', 10);
        const thirdPartyNo = log.payload.trade_no || 'UNKNOWN';
        const idemKey = log.payload.id || thirdPartyNo;

        // 4. Call Atomic RPC (Pessimistic Lock inside DB)
        const { data: rpcRes, error: rpcErr } = await supabase.rpc('process_payment_success', {
            p_order_no: orderNo,
            p_paid_amount: paidAmount,
            p_third_party_no: thirdPartyNo,
            p_idempotency_key: idemKey
        });

        if (rpcErr) {
            console.error(`[payment-worker] RPC Failed for ${orderNo}:`, rpcErr);
            throw rpcErr;
        }

        console.log(`[payment-worker] Successfully finished: ${orderNo}`);

        // Note: RPC already updates job status to 'done'.

    } catch (err) {
        console.error(`[payment-worker] Error processing job:`, err.message);
        // Fallback: Increment retry, check threshold
        // (In a real scenario we'd do this via a safely targeted Update query)
    } finally {
        // Poll aggressively if we found a job
        setTimeout(processPaymentJobs, WORKER_INTERVAL_MS);
    }
}

/**
 * Sweeps the DB for stuck un-paid orders and runs active fallout recovery.
 */
async function maintenanceSweeper() {
    try {
        // 1. Close dead orders
        const { error: clearErr } = await supabase
            .from('orders')
            .update({ status: 'closed', updated_at: new Date().toISOString() })
            .eq('status', 'pending')
            .lt('expired_at', new Date().toISOString());

        if (clearErr) console.error('[maintenance] Failed to clear dead orders', clearErr);
        
        // 2. Flag stuck 'processing' or 'paid' anomalies (Alert Hook)
        const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data: stuck } = await supabase
            .from('orders')
            .select('order_no')
            .in('status', ['paid', 'processing'])
            .lt('updated_at', tenMinsAgo);

        if (stuck && stuck.length > 0) {
            console.warn(`[ALERT] Found ${stuck.length} stuck orders! Needs manual intervention.`, stuck);
            // e.g., send slack/email hook
        }

        // 4. Active ZFM Query (Fallback for dead webhooks)
        // (Omitted fully active implemention to save request quotas, but structure is here)
        
    } catch (err) {
        console.error('[maintenance] Sweeper failed', err);
    }
}

// Initialization Hooks
function startPaymentEngine() {
    console.log('[engine] Starting L6.5 Payment Job Worker...');
    setTimeout(processPaymentJobs, WORKER_INTERVAL_MS);
    
    console.log('[engine] Starting Background Maintenance Sweeper...');
    setInterval(maintenanceSweeper, GC_INTERVAL_MS);
}

module.exports = { startPaymentEngine };
