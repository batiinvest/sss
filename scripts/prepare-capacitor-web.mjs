import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const outputDir = join(root, 'www');

const entries = [
  'admin.html',
  'app.html',
  'fees.html',
  'index.html',
  'members.html',
  'mypage.html',
  'offline.html',
  'picks.html',
  'presentations.html',
  'schedule-calendar.html',
  'schedule-order.html',
  'settle.html',
  'trade.html',
  'manifest.webmanifest',
  'sw.js',
  'assets',
  'css',
  'js'
];

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const entry of entries) {
  const source = join(root, entry);
  const target = join(outputDir, entry);
  try {
    await stat(source);
    await cp(source, target, { recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const copied = await readdir(outputDir);
console.log(`Prepared Capacitor web assets in www (${copied.length} top-level entries).`);
