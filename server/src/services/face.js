// Face verification, run on the SERVER so a modified browser cannot fake a pass.
//
// Models (shipped inside the @vladmandic/face-api npm package, free and offline):
//   SSD MobileNet v1   -> finds the face
//   68-point landmarks -> nose, eyes, jaw (used for the head-turn check)
//   faceRecognitionNet -> a 128-number "descriptor"; two photos of the same person are close together
//
// A scan = 3 frames in the random pose order of a one-time challenge, e.g. [right, straight, left].
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { config } from '../config.js';

const require = createRequire(import.meta.url);

let faceapi = null;
let tf = null;
let loading = null;

/** Loads TensorFlow (WASM backend) and the three models once. Takes ~2 s on first call. */
export function loadFaceModels() {
  if (config.face.mode !== 'real') return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      tf = require('@tensorflow/tfjs');
      const wasm = require('@tensorflow/tfjs-backend-wasm');
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      const wasmDir = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist') + path.sep;
      wasm.setWasmPaths(wasmDir);
      await tf.setBackend('wasm');
      await tf.ready();
      const modelDir = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
      await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
      await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
      await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);
    })();
  }
  return loading;
}

/**
 * Head turn ("yaw") from landmarks. Compares the nose tip's distance to each side of the jaw.
 *   ~0      -> looking straight at the camera
 *   > 0     -> head turned to the person's LEFT  (nose moves to the right of the raw camera image)
 *   < 0     -> head turned to the person's RIGHT
 * Frames must be raw camera frames, NOT the mirrored preview.
 */
export function yawFromLandmarks(points) {
  const nose = points[30];
  const jawRight = points[0];    // person's right jaw edge (left side of the image)
  const jawLeft = points[16];    // person's left jaw edge (right side of the image)
  const dRight = Math.hypot(nose.x - jawRight.x, nose.y - jawRight.y);
  const dLeft = Math.hypot(nose.x - jawLeft.x, nose.y - jawLeft.y);
  return (dRight - dLeft) / (dRight + dLeft);
}

export function distance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// ---------- frame analysis ----------

let queue = Promise.resolve();   // one scan at a time keeps memory flat on small servers

function decodeDataUrl(image) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
  if (!match) throw new FaceError('frame is not a JPEG/PNG data URL');
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 1_500_000) throw new FaceError('frame too large');
  return buf;
}

async function analyzeRealFrame(image) {
  const sharp = (await import('sharp')).default;
  const { data, info } = await sharp(decodeDataUrl(image))
    .rotate()
    .resize({ width: 480, withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  try {
    const results = await faceapi
      .detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();
    if (results.length !== 1) return { faces: results.length };
    const r = results[0];
    return {
      faces: 1,
      width: r.detection.box.width,
      yaw: yawFromLandmarks(r.landmarks.positions),
      descriptor: Array.from(r.descriptor),
    };
  } finally {
    tf.dispose(tensor);
  }
}

// MOCK mode (tests only): a frame is "mock:<person>:<yaw>" or "mock:none" / "mock:two".
function mockDescriptor(person) {
  const seed = crypto.createHash('sha256').update(String(person)).digest();
  const out = [];
  for (let i = 0; i < 128; i++) out.push((seed[i % 32] ^ (i * 37)) % 200 / 1000 - 0.1);
  return out;
}

function analyzeMockFrame(image) {
  const parts = String(image || '').split(':');
  if (parts[0] !== 'mock') throw new FaceError('mock frames look like mock:<person>:<yaw>');
  if (parts[1] === 'none') return { faces: 0 };
  if (parts[1] === 'two') return { faces: 2 };
  return { faces: 1, width: 200, yaw: Number(parts[2] || 0), descriptor: mockDescriptor(parts[1]) };
}

export class FaceError extends Error {}

async function analyzeFrames(frames) {
  if (config.face.mode === 'mock') return frames.map((f) => analyzeMockFrame(f.image));
  await loadFaceModels();
  const run = queue.then(async () => {
    const out = [];
    for (const f of frames) out.push(await analyzeRealFrame(f.image));
    return out;
  });
  queue = run.catch(() => {});
  return run;
}

// ---------- the decision ----------

const POSE_LABEL = { straight: 'look straight', left: 'turn left', right: 'turn right' };

function poseOk(pose, yaw) {
  const { straightMaxYaw, turnMinYaw } = config.face;
  if (pose === 'straight') return Math.abs(yaw) <= straightMaxYaw;
  if (pose === 'left') return yaw >= turnMinYaw;
  if (pose === 'right') return yaw <= -turnMinYaw;
  return false;
}

/**
 * Checks one scan against its challenge (and the stored template, if given).
 * Returns { passed, reason, yaws, matchDistance, descriptor }.
 */
export async function evaluateScan({ poses, frames, template = null }) {
  if (!Array.isArray(frames) || frames.length !== poses.length) {
    return { passed: false, reason: `expected ${poses.length} frames` };
  }
  for (let i = 0; i < poses.length; i++) {
    if (frames[i]?.pose !== poses[i]) return { passed: false, reason: 'frames are not in the challenge order' };
  }

  const analyzed = await analyzeFrames(frames);
  const yaws = analyzed.map((a) => (typeof a.yaw === 'number' ? Number(a.yaw.toFixed(3)) : null));

  for (let i = 0; i < analyzed.length; i++) {
    const a = analyzed[i];
    const step = POSE_LABEL[poses[i]];
    if (a.faces === 0) return { passed: false, reason: `no face found at "${step}"`, yaws };
    if (a.faces > 1) return { passed: false, reason: `more than one face at "${step}"`, yaws };
    if (a.width < config.face.minFaceWidth) return { passed: false, reason: `face too far from the camera at "${step}"`, yaws };
    if (!poseOk(poses[i], a.yaw)) return { passed: false, reason: `head position wrong at "${step}"`, yaws };
  }

  // Liveness consistency: the turned frames must be the same person as the straight frame.
  const straight = analyzed[poses.indexOf('straight')].descriptor;
  for (let i = 0; i < analyzed.length; i++) {
    if (poses[i] === 'straight') continue;
    if (distance(straight, analyzed[i].descriptor) > config.face.consistencyThreshold) {
      return { passed: false, reason: 'the face changed during the scan', yaws };
    }
  }

  // Identity: the straight frame must match the enrolled template.
  let matchDistance = null;
  if (template) {
    matchDistance = Number(distance(straight, template).toFixed(4));
    if (matchDistance > config.face.matchThreshold) {
      return { passed: false, reason: 'face does not match this account', yaws, matchDistance };
    }
  }
  return { passed: true, reason: 'ok', yaws, matchDistance, descriptor: straight };
}

// Templates are stored encrypted: 128 float32 values -> 512 bytes -> AES-GCM.
export function descriptorToBuffer(descriptor) {
  return Buffer.from(new Float32Array(descriptor).buffer);
}
export function bufferToDescriptor(buf) {
  const b = Buffer.from(buf);
  return Array.from(new Float32Array(b.buffer, b.byteOffset, b.length / 4));
}
