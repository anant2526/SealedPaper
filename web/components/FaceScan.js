'use client';

// Guided face scan, like an ID-verification app: look straight, turn left, turn right,
// in the random order the server's one-time challenge asks for.
//
// The browser runs two tiny models only to GUIDE the person and auto-capture at the right moment.
// The real decision (liveness + identity) is made on the server from the three raw frames.

import { useCallback, useEffect, useRef, useState } from 'react';

const STRAIGHT_MAX = 0.1;   // a little stricter than the server (0.15) so captured frames pass
const TURN_MIN = 0.26;      // server needs 0.2
const HOLD_TICKS = 4;       // ~0.5 s steady before auto-capture
const TICK_MS = 120;

const POSE_TEXT = {
  straight: { title: 'Look straight at the camera', short: 'Straight' },
  left: { title: 'Turn your head to your left', short: 'Left' },
  right: { title: 'Turn your head to your right', short: 'Right' },
};

// Same formula as the server: > 0 = person turned to their left (raw, unmirrored frame).
function yawOf(points) {
  const nose = points[30];
  const a = points[0];
  const b = points[16];
  const dRight = Math.hypot(nose.x - a.x, nose.y - a.y);
  const dLeft = Math.hypot(nose.x - b.x, nose.y - b.y);
  return (dRight - dLeft) / (dRight + dLeft);
}

function poseMet(pose, yaw) {
  if (pose === 'straight') return Math.abs(yaw) <= STRAIGHT_MAX;
  if (pose === 'left') return yaw >= TURN_MIN;
  return yaw <= -TURN_MIN;
}

function hintFor(pose, yaw) {
  if (pose === 'straight') return yaw > 0 ? 'Turn slightly to your right' : 'Turn slightly to your left';
  if (pose === 'left') return yaw > 0.1 ? 'A little more to your left' : 'Turn your head to your left';
  return yaw < -0.1 ? 'A little more to your right' : 'Turn your head to your right';
}

let faceapiPromise = null;
function loadGuideModels() {
  if (!faceapiPromise) {
    faceapiPromise = (async () => {
      const faceapi = await import('@vladmandic/face-api/dist/face-api.esm.js');
      // WebGL is used when available; otherwise TensorFlow.js falls back to WebAssembly from /tfjs.
      faceapi.tf.setWasmPaths?.('/tfjs/');
      await faceapi.tf.ready();
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      await faceapi.nets.faceLandmark68TinyNet.loadFromUri('/models');
      return faceapi;
    })();
    faceapiPromise.catch(() => (faceapiPromise = null));
  }
  return faceapiPromise;
}

function PoseIcon({ pose }) {
  if (pose === 'straight') {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <circle cx="12" cy="12" r="4" fill="currentColor" />
      </svg>
    );
  }
  // Preview is mirrored, so "your left" is on the left of the screen.
  return (
    <svg viewBox="0 0 24 24" className={`h-4 w-4 ${pose === 'right' ? 'rotate-180' : ''}`} aria-hidden="true">
      <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Props:
 *   getChallenge(): Promise<{ challengeId, poses }>
 *   onFrames(challengeId, frames): Promise — throw to show the error and offer a retry
 *   intro: text shown before starting
 *   startLabel: button text
 */
export default function FaceScan({ getChallenge, onFrames, intro, startLabel = 'Start face scan' }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const stateRef = useRef({ poses: [], index: 0, hold: 0, frames: [], challengeId: null });

  const [phase, setPhase] = useState('idle');   // idle | starting | scanning | sending | done | error
  const [poses, setPoses] = useState([]);
  const [index, setIndex] = useState(0);
  const [hint, setHint] = useState('');
  const [error, setError] = useState('');
  const [manual, setManual] = useState(false);

  // Always call the latest onFrames, even from a scan loop started on an earlier render.
  const onFramesRef = useRef(onFrames);
  useEffect(() => {
    onFramesRef.current = onFrames;
  }, [onFrames]);

  const stopCamera = useCallback(() => {
    clearTimeout(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    const width = 480;
    const height = Math.round((video.videoHeight / video.videoWidth) * width);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(video, 0, 0, width, height);   // raw frame, not mirrored
    return canvas.toDataURL('image/jpeg', 0.85);
  }, []);

  const finish = useCallback(async () => {
    stopCamera();
    setPhase('sending');
    const s = stateRef.current;
    try {
      await onFramesRef.current(s.challengeId, s.frames);
      setPhase('done');
    } catch (err) {
      setError(err.message || 'Face scan failed');
      setPhase('error');
    }
  }, [stopCamera]);

  const takeFrame = useCallback(() => {
    const s = stateRef.current;
    s.frames.push({ pose: s.poses[s.index], image: capture() });
    s.index += 1;
    s.hold = 0;
    setIndex(s.index);
    if (s.index >= s.poses.length) finish();
  }, [capture, finish]);

  const tick = useCallback(async (faceapi) => {
    const s = stateRef.current;
    const video = videoRef.current;
    if (!video || s.index >= s.poses.length) return;
    try {
      const result = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
        .withFaceLandmarks(true);
      const pose = s.poses[s.index];
      if (!result) {
        s.hold = 0;
        setHint('No face found. Face the camera in good light.');
      } else if (result.detection.box.width < video.videoWidth * 0.2) {
        s.hold = 0;
        setHint('Move a little closer');
      } else {
        const yaw = yawOf(result.landmarks.positions);
        if (poseMet(pose, yaw)) {
          s.hold += 1;
          setHint('Hold still');
          if (s.hold >= HOLD_TICKS) takeFrame();
        } else {
          s.hold = 0;
          setHint(hintFor(pose, yaw));
        }
      }
    } catch {
      /* a dropped frame is fine */
    }
    if (streamRef.current) timerRef.current = setTimeout(() => tick(faceapi), TICK_MS);
  }, [takeFrame]);

  const start = useCallback(async () => {
    setError('');
    setPhase('starting');
    setIndex(0);
    try {
      const challenge = await getChallenge();
      stateRef.current = { poses: challenge.poses, index: 0, hold: 0, frames: [], challengeId: challenge.challengeId };
      setPoses(challenge.poses);

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot open the camera. Use Chrome, Edge, Firefox or Safari over https or localhost.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      setPhase('scanning');
      // wait until React has mounted the <video>
      for (let i = 0; i < 30 && !videoRef.current; i++) await new Promise((r) => setTimeout(r, 30));
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      try {
        const faceapi = await loadGuideModels();
        setManual(false);
        setHint('Finding your face…');
        tick(faceapi);
      } catch {
        setManual(true);   // guidance models failed: capture with a button instead
        setHint('');
      }
    } catch (err) {
      stopCamera();
      const denied = err?.name === 'NotAllowedError';
      setError(denied ? 'Camera permission was blocked. Allow the camera for this site and try again.' : err.message);
      setPhase('error');
    }
  }, [getChallenge, stopCamera, tick]);

  const current = poses[index];

  return (
    <div className="panel overflow-hidden">
      {(phase === 'idle' || phase === 'error') && (
        <div className="p-6">
          {intro && <p className="mb-4 max-w-prose text-[15px] leading-relaxed text-ink-soft">{intro}</p>}
          <ul className="mb-5 space-y-1.5 text-[15px] text-ink-soft">
            <li>Good, even light on your face. No cap, mask or sunglasses.</li>
            <li>You will look straight and turn your head left and right, in a random order.</li>
            <li>Frames go only to the SealedPaper server and are not stored.</li>
          </ul>
          {error && (
            <p role="alert" className="mb-4 rounded-md bg-wax-soft px-3 py-2.5 text-[15px] text-wax">
              {error}
            </p>
          )}
          <button className="btn-primary" onClick={start}>
            {phase === 'error' ? 'Scan again' : startLabel}
          </button>
        </div>
      )}

      {phase === 'starting' && <p className="p-6 text-ink-soft">Opening the camera…</p>}

      {phase === 'scanning' && (
        <div>
          <ol className="flex border-b border-line">
            {poses.map((p, i) => (
              <li
                key={p}
                aria-current={i === index ? 'step' : undefined}
                className={`flex flex-1 items-center justify-center gap-2 py-3 text-sm font-semibold ${
                  i < index ? 'bg-open-soft text-open' : i === index ? 'bg-ink text-paper' : 'text-ink-soft'
                }`}
              >
                <PoseIcon pose={p} />
                {i < index ? `${POSE_TEXT[p].short} done` : POSE_TEXT[p].short}
              </li>
            ))}
          </ol>
          <div className="relative mx-auto aspect-[4/3] w-full max-w-xl bg-ink">
            <video ref={videoRef} playsInline muted className="h-full w-full -scale-x-100 object-cover" />
            {/* oval guide */}
            <svg viewBox="0 0 400 300" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
              <defs>
                <mask id="oval-cut">
                  <rect width="400" height="300" fill="white" />
                  <ellipse cx="200" cy="145" rx="88" ry="115" fill="black" />
                </mask>
              </defs>
              <rect width="400" height="300" fill="#1c2840" fillOpacity="0.55" mask="url(#oval-cut)" />
              <ellipse cx="200" cy="145" rx="88" ry="115" fill="none" stroke="white" strokeWidth="2" strokeDasharray="6 5" />
            </svg>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div aria-live="polite">
              <p className="text-lg font-semibold">{current ? POSE_TEXT[current].title : ''}</p>
              <p className="text-[15px] text-ink-soft">
                {manual
                  ? 'Press capture when you are in position.'
                  : hint && hint !== POSE_TEXT[current]?.title ? hint : 'Keep your face inside the oval'}
              </p>
            </div>
            {manual && current && (
              <button className="btn-primary" onClick={takeFrame}>
                Capture
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'sending' && <p className="p-6 text-ink-soft">Checking your face on the server…</p>}
      {phase === 'done' && <p className="p-6 font-semibold text-open">Face verified.</p>}
    </div>
  );
}
