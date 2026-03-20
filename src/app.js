/**
 * Backend API — Express entry point
 * CQRS write-side: all writes to R2/KV happen here, never in the Worker.
 *
 * v2 additions:
 *  - express-rate-limit: throttle API abuse from bots
 *  - express.static: serve the compiled React frontend from dist/
 *    (Replaces Cloudflare Pages; the VPS is now the origin for www.885201314.xyz)
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const templateRouter = require('./routes/template');
const { router: projectRouter } = require('./routes/project');
const paymentRouter = require('./routes/payment');
const { startPaymentEngine } = require('./cron_jobs');

const app = express();

// ── Rate Limiting ────────────────────────────────────────────────────────────
// Applied only to /api/* — protects the render endpoint from bots.
// Adjust windowMs / max as traffic grows.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15-minute window
    max: 200,                  // max 200 requests per IP per window (relaxed from 60 to avoid 4290 errors)
    standardHeaders: true,     // Return rate limit info in RateLimit-* headers
    legacyHeaders: false,
    message: {
        code: 4290,
        message: '请求过于频繁，请稍后再试',
        data: null,
    },
});

// ── Core Middleware ──────────────────────────────────────────────────────────

// Allow the frontend (now served from the same origin or VPS) to call this API
app.use(
    cors({
        origin: process.env.ALLOWED_ORIGIN ?? '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Admin-Key'],
    })
);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'backend-api', ts: new Date().toISOString() });
});

// ── API Routes (rate-limited) ────────────────────────────────────────────────
app.use('/api/', apiLimiter);
app.use('/api/template', templateRouter);
app.use('/api/project', projectRouter);
app.use('/api/payment', paymentRouter);

// ── Template Asset Serving (NOT rate-limited — public CDN-like route) ────────
// Serves CSS/JS/images for templates from R2 via /assets/:type/:filepath
// This route must be before the SPA fallback to avoid serving index.html for assets.
app.use('/assets', templateRouter);

// ── Frontend Static Site Serving ─────────────────────────────────────────────
// Serve the compiled React bundle from a configured path, or fallback to relative.
const FRONTEND_DIST = process.env.FRONTEND_DIST_PATH || path.join(__dirname, '../../MoodSpace-Frontend/dist');
app.use(express.static(FRONTEND_DIST));

// SPA fallback: for any unknown path (e.g. /builder/anniversary), return index.html
// so React Router can handle it client-side.
app.get('*', (_req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[unhandled]', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
    // Start L6.5 Payment Worker
    startPaymentEngine();
    console.log(`[backend-api] Listening on http://0.0.0.0:${PORT}`);
    console.log(`[backend-api] Serving frontend from: ${FRONTEND_DIST}`);
});
