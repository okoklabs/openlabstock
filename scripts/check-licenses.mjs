import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const allowedExpressions = new Set([
  '(Unlicense OR Apache-2.0)',
  'Apache-2.0',
  'Apache-2.0 AND LGPL-3.0-or-later',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'LGPL-3.0-or-later',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
]);

if (metadata.license !== 'AGPL-3.0-only') {
  throw new Error(`package.json license must be AGPL-3.0-only, got ${metadata.license ?? '(missing)'}`);
}

const licenseText = readFileSync(path.join(rootDir, 'LICENSE'), 'utf8').replaceAll('\r\n', '\n');
const licenseHash = createHash('sha256').update(licenseText).digest('hex').toUpperCase();
const officialAgplHash = '0D96A4FF68AD6D4B6F1F30F713B18D5184912BA8DD389F86AA7710DB079ABCB0';
if (licenseHash !== officialAgplHash) {
  throw new Error(`LICENSE does not match the canonical GNU AGPL v3 text (${licenseHash})`);
}

const pnpmScript = process.env.npm_execpath ?? '';
const command = pnpmScript ? process.execPath : (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const args = pnpmScript
  ? [pnpmScript, 'licenses', 'list', '--prod', '--json']
  : ['licenses', 'list', '--prod', '--json'];
const result = spawnSync(command, args, { cwd: rootDir, encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  throw new Error('pnpm licenses list returned invalid JSON');
}

const expressions = Object.keys(report).sort();
const unexpected = expressions.filter((expression) => !allowedExpressions.has(expression));
if (unexpected.length) {
  throw new Error(`Unreviewed production dependency license expression(s): ${unexpected.join(', ')}`);
}

let packagePaths = 0;
for (const packages of Object.values(report)) {
  for (const dependency of packages) {
    if (!dependency.name || !Array.isArray(dependency.versions) || dependency.versions.length === 0) {
      throw new Error('Production dependency license metadata is incomplete');
    }
    packagePaths += Array.isArray(dependency.paths) ? dependency.paths.length : 0;
  }
}

console.log(`License policy: AGPL-3.0-only; canonical text ${licenseHash}`);
console.log(`Production dependency licenses: ${expressions.length} reviewed expressions, ${packagePaths} installed package paths`);
