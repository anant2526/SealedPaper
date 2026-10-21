import { config } from './config.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';
import { loadFaceModels } from './services/face.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`SealedPaper API on http://localhost:${config.port}  (face mode: ${config.face.mode})`);
});

// Warm up the face models in the background so the first scan is fast.
loadFaceModels()
  .then(() => config.face.mode === 'real' && console.log('Face models loaded'))
  .catch((err) => console.error('Face models failed to load:', err.message));

if (config.runWorker) {
  startWorker();
  console.log('Release worker running every 30 s');
}
