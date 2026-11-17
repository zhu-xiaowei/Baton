// Prints NODE_SHA256 for server/core/install.mjs from the official SHASUMS256.txt of a Node.js release.
// Usage: node scripts/node-checksums.mjs v24.22.3
import { NODE_SHA256 } from '../server/core/install.mjs';

const version = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(version || '')) throw new Error('usage: node scripts/node-checksums.mjs v<major>.<minor>.<patch>');
const response = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
if (!response.ok) throw new Error(`SHASUMS256.txt: HTTP ${response.status}`);
const sums = new Map((await response.text()).trim().split('\n').map((line) => line.split(/\s+/).reverse()));
console.log('export const NODE_SHA256 = {');
for (const file of Object.keys(NODE_SHA256)) {
  const sum = sums.get(`node-${version}-${file}`);
  if (!sum) throw new Error(`missing node-${version}-${file}`);
  console.log(`  '${file}': '${sum}',`);
}
console.log('};');
