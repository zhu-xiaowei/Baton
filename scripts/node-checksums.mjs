// Prints NODE_SHA256 for server/core/install.mjs from the official SHASUMS256.txt of its NODE_VERSION.
// After changing NODE_VERSION: node scripts/node-checksums.mjs, then paste the output.
import { NODE_SHA256, NODE_VERSION } from '../server/core/install.mjs';

const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`);
if (!response.ok) throw new Error(`SHASUMS256.txt: HTTP ${response.status}`);
const sums = new Map((await response.text()).trim().split('\n').map((line) => line.split(/\s+/).reverse()));
console.log('export const NODE_SHA256 = {');
for (const file of Object.keys(NODE_SHA256)) {
  const sum = sums.get(`node-${NODE_VERSION}-${file}`);
  if (!sum) throw new Error(`missing node-${NODE_VERSION}-${file}`);
  console.log(`  '${file}': '${sum}',`);
}
console.log('};');
