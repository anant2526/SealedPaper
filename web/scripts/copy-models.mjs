// Copies the two small face-api models used for live guidance in the browser into public/models,
// plus the TensorFlow.js WebAssembly runtime into public/tfjs.
// (The server runs its own, larger models for the real verification.)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'model');
const dest = path.join(process.cwd(), 'public', 'models');
fs.mkdirSync(dest, { recursive: true });
for (const name of ['tiny_face_detector_model', 'face_landmark_68_tiny_model']) {
  for (const ext of ['-weights_manifest.json', '.bin']) {
    fs.copyFileSync(path.join(src, name + ext), path.join(dest, name + ext));
  }
}
// WebAssembly fallback for browsers without WebGL (the bundled TensorFlow.js is 4.22.0).
const wasmSrc = path.join(path.dirname(require.resolve('@tensorflow/tfjs-backend-wasm/package.json')), 'dist');
const wasmDest = path.join(process.cwd(), 'public', 'tfjs');
fs.mkdirSync(wasmDest, { recursive: true });
for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm']) {
  fs.copyFileSync(path.join(wasmSrc, f), path.join(wasmDest, f));
}
console.log('face models copied to public/models, wasm runtime to public/tfjs');
