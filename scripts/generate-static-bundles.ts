import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAndroidStudioZip,
  buildBrowserCamZip,
  buildPcWindowsZip,
  buildWindowsVcamZip,
} from '../lib/bundles.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'public', 'downloads');

const defaultOrigin = (
  process.env.APP_URL ||
  'https://ais-pre-uezvraxz5h2xsf4xr5nkjk-789221242334.asia-southeast1.run.app'
)
  .trim()
  .replace(/\/+$/, '');
const defaultWsOrigin = defaultOrigin
  .replace(/^https:\/\//i, 'wss://')
  .replace(/^http:\/\//i, 'ws://');

fs.mkdirSync(outDir, { recursive: true });

const browserZip = buildBrowserCamZip(rootDir, defaultOrigin);
if (browserZip) {
  fs.writeFileSync(path.join(outDir, 'lenslink-browser-webcam.zip'), browserZip);
}

const vcamZip = buildWindowsVcamZip(rootDir, defaultWsOrigin);
if (vcamZip) {
  fs.writeFileSync(path.join(outDir, 'lenslink-windows-vcam.zip'), vcamZip);
}

const pcZip = buildPcWindowsZip(rootDir, defaultOrigin);
fs.writeFileSync(path.join(outDir, 'lenslink-pc-windows.zip'), pcZip);

const androidZip = buildAndroidStudioZip(rootDir, defaultOrigin);
if (androidZip) {
  fs.writeFileSync(path.join(outDir, 'lenslink-android-studio.zip'), androidZip);
}

console.log(`Generated static bundles in ${outDir}`);
