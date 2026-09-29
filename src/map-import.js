import { validateMapFile } from './map-tiles.js';

export async function prepareMapTiles(file, onProgress = () => {}) {
  validateMapFile(file.size);
  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./map-tile-worker.js', import.meta.url), { type: 'module' });
    const finish = (callback, value) => { worker.terminate(); callback(value); };
    worker.onerror = () => finish(reject, new Error('Kartbearbetningen avbröts. Försök med en mindre karta eller en annan webbläsare.'));
    worker.onmessageerror = () => finish(reject, new Error('Kunde inte läsa resultatet av kartbearbetningen.'));
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress({ value: Math.round(data.value * 0.65), text: data.text });
      else if (data.type === 'complete') finish(resolve, data);
      else if (data.type === 'error') finish(reject, new Error(data.message));
    };
    worker.postMessage({ buffer }, [buffer]);
  });
}
