const { createClient } = require('@supabase/supabase-js');

// Required env variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in .env');
}

// Create Supabase client with Service Role Key
// This allows backend-level admin access without Row Level Security (RLS) policies getting in the way
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * L6.7 "Pseudo-Realtime" Subscription Sync
 * Fetches profile and automatically downgrades to 'free' if expired.
 */
async function getProfileWithSubscriptionSync(userId) {
    if (!userId) return null;

    // 1. Fetch
    const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

    if (error || !profile) return profile;

    // 2. Logic: If Pro/Partner but expired, downgrade on-the-fly
    if (['pro', 'partner'].includes(profile.tier)) {
        const isExpired = profile.subscription_expires_at && new Date(profile.subscription_expires_at) < new Date();
        if (isExpired) {
            console.log(`[subscription-sync] User ${userId} (${profile.tier}) expired. Auto-downgrading...`);
            const { error: updErr } = await supabase
                .from('profiles')
                .update({ tier: 'free', updated_at: new Date().toISOString() })
                .eq('id', userId);
            
            if (!updErr) {
                profile.tier = 'free'; // Reflect change in memory for current request
            }
        }
    }
    return profile;
}

module.exports = {
    supabase,
    getProfileWithSubscriptionSync
};
