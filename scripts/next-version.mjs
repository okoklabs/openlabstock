import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagePath = path.join(rootDir, 'package.json');
const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})-r(\d+)$/.exec(String(metadata.version ?? ''));
if (!match) throw new Error(`package.json version is invalid: ${metadata.version ?? '(empty)'}`);

const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
const current = match.slice(1, 4).map(Number);
const currentDate = current[0] * 10_000 + current[1] * 100 + current[2];
const todayDate = today[0] * 10_000 + today[1] * 100 + today[2];
if (currentDate > todayDate) throw new Error(`Current version date ${current.join('.')} is later than local date ${today.join('.')}`);

const revision = currentDate === todayDate ? Number(match[4]) + 1 : 1;
metadata.version = `${today[0]}.${today[1]}.${today[2]}-r${revision}`;
writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
console.log(`Version updated: ${match[0]} -> ${metadata.version}`);
