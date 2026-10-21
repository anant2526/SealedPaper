// All settings come from environment variables (see .env.example).
// Secrets are never hard-coded and never committed.

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see .env.example)`);
  return value;
}

function number(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}

const isProduction = process.env.NODE_ENV === 'production';

// The master key wraps short-lived secrets (TOTP secrets, face templates, key-file pickup copies,
// released document keys). It must be exactly 32 bytes, given as 64 hex characters.
const masterKeyHex = required('MASTER_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex)) {
  throw new Error('MASTER_KEY must be 64 hex characters (32 bytes). Generate one with: npm run keygen');
}

// FACE_MODE:
//   real -> runs the face-api models on every scan (default, required in production)
//   mock -> frames are strings like "mock:<person>:<yaw>"; only for automated tests
const faceMode = process.env.FACE_MODE || 'real';
if (!['real', 'mock'].includes(faceMode)) throw new Error('FACE_MODE must be "real" or "mock"');
if (isProduction && faceMode !== 'real') throw new Error('FACE_MODE=mock is not allowed in production');

export const config = {
  isProduction,
  port: number('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  databaseSsl: process.env.DATABASE_SSL === 'true',
  jwtSecret: required('JWT_SECRET'),
  masterKey: Buffer.from(masterKeyHex, 'hex'),
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProduction,
  maxUploadBytes: number('MAX_UPLOAD_MB', 4) * 1024 * 1024,
  appName: process.env.APP_NAME || 'SealedPaper',
  runWorker: process.env.RUN_WORKER !== 'false',
  trustProxy: number('TRUST_PROXY', 1),
  // a paper can only be sealed if its unlock time is at least this far away
  minSealLeadSeconds: number('MIN_SEAL_LEAD_SECONDS', 60),

  face: {
    mode: faceMode,
    matchThreshold: number('FACE_MATCH_THRESHOLD', 0.5),             // straight frame vs stored template
    consistencyThreshold: number('FACE_CONSISTENCY_THRESHOLD', 0.6), // turned frames vs straight frame
    straightMaxYaw: number('FACE_STRAIGHT_MAX_YAW', 0.15),
    turnMinYaw: number('FACE_TURN_MIN_YAW', 0.2),
    minFaceWidth: number('FACE_MIN_WIDTH_PX', 80),
    challengeSeconds: number('FACE_CHALLENGE_SECONDS', 120),
  },

  lockout: {
    maxFailures: number('KEY_MAX_FAILURES', 5),                       // per 10 minutes, per custodian per document
  },
};
