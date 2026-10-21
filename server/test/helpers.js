// Test helpers. Tests run with FACE_MODE=mock: a "frame" is the string mock:<person>:<yaw>,
// so the real liveness/matching LOGIC runs without needing a camera.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import otplib from 'otplib';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function resetDatabase() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  execFileSync(process.execPath, ['scripts/migrate.js'], { cwd: root, env: process.env, stdio: 'pipe' });
}

const YAW = { straight: 0.02, left: 0.32, right: -0.31 };

/** Frames in the challenge's pose order, all showing `person`. */
export function framesFor(poses, person, overrides = {}) {
  return poses.map((pose) => ({ pose, image: overrides[pose] ?? `mock:${person}:${YAW[pose]}` }));
}

export const codeFor = (secret) => otplib.authenticator.generate(secret);

/** TOTP replay protection allows one code per 30 s; tests reset the marker instead of waiting. */
export async function allowNewCode(db, userId) {
  await db.query('UPDATE users SET totp_last_step = NULL WHERE id = $1', [userId]);
}

/** Full registration: password -> face enrolment -> authenticator. Returns { agent, user, secret, person }. */
export async function registerUser(app, { name, email, person }) {
  const agent = request.agent(app);
  const reg = await agent.post('/api/auth/register').send({ name, email, password: 'correct horse battery' });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const ch = await agent.post('/api/auth/face-challenge').send({});
  const enroll = await agent.post('/api/auth/enroll/face').send({ challengeId: ch.body.challengeId, frames: framesFor(ch.body.poses, person) });
  if (enroll.status !== 200) throw new Error(`enroll failed: ${JSON.stringify(enroll.body)}`);
  const setup = await agent.post('/api/auth/enroll/totp').send({});
  const secret = setup.body.secret;
  const confirm = await agent.post('/api/auth/enroll/totp/confirm').send({ code: codeFor(secret) });
  if (confirm.status !== 200) throw new Error(`totp confirm failed: ${JSON.stringify(confirm.body)}`);
  return { agent, user: confirm.body.user, secret, person };
}

export { request };
