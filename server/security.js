// security.js — headers, rate limiting, doctor auth, safe errors
// This is the defense layer that sits in front of every request.

// 1) Security headers on every response.
//    CSP is strict for scripts (only same-origin files, no inline JS),
//    inline styles allowed (React + doctor console use them), frames denied.
export function securityHeaders(req, res, next) {
  const proto = req.headers['x-forwarded-proto'] || '';
  const isHttps = req.secure || proto.startsWith('https');

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  if (isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// 2) Tiny in-memory per-IP rate limiter (no external dep).
//    Good enough for a hackathon: resets each minute, no persistence.
const buckets = new Map();
setInterval(() => buckets.clear(), 60_000).unref();

export function rateLimit({ windowMs = 60_000, max = 60, name = 'rl' }) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${name}:${ip}`;
    const now = Date.now();
    const b = buckets.get(key) || { hits: 0, reset: now + windowMs };
    if (now > b.reset) { b.hits = 0; b.reset = now + windowMs; }
    b.hits += 1;
    buckets.set(key, b);
    if (b.hits > max) {
      res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — please slow down.' });
    }
    next();
  };
}

// 3) Doctor console PIN gate — applied to every /api/doctor/* route.
//    The patient side NEVER needs this; only the doctor console sends the header.
const DOCTOR_PIN = process.env.DOCTOR_PIN || 'medikiosk-demo'; // override in prod!
export function doctorAuth(req, res, next) {
  const provided = req.get('X-Doctor-Pin') || '';
  if (provided === DOCTOR_PIN) return next();
  res.status(401).json({ error: 'Doctor authentication required' });
}

// 4) Safe error responses: log the full detail server-side, but never
//    leak SQL/internal messages to the browser in production.
export function sendError(res, err) {
  console.error(err);
  const msg = process.env.NODE_ENV === 'production'
    ? 'Something went wrong on the server.'
    : (err?.message || 'Internal server error');
  res.status(500).json({ error: msg });
}
