import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUDIT_MAX_AGE_MS,
  dependencyState,
  documentationState,
  evidenceIsFresh,
  licenseState,
  readDocumentationReceipt,
  readPublicBoundaryReceipt,
  readVerificationReceipt,
  repositoryState,
  verificationState,
} from './verification-state.mjs';
import { releaseBaseState } from './release-version.mjs';

const rootDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const metadata = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const runtimeReceipt = readVerificationReceipt(rootDir);
const dependencies = dependencyState(rootDir);
const licenses = licenseState(rootDir);
const docsState = documentationState(rootDir);
const docsReceipt = readDocumentationReceipt(rootDir);
const publicState = repositoryState(rootDir);
const publicReceipt = readPublicBoundaryReceipt(rootDir);
const releaseBase = releaseBaseState(rootDir, metadata.version);

const distExists = existsSync(path.join(rootDir, 'dist'));
const runtimeFresh = [1, 2].includes(runtimeReceipt?.format)
  && runtimeReceipt.version === metadata.version
  && distExists
  && runtimeReceipt.fingerprint === verificationState(rootDir).fingerprint
  && runtimeReceipt.node === process.version;
const docsFresh = docsReceipt?.format === 1 && docsReceipt.fingerprint === docsState.fingerprint;
const publicFresh = publicReceipt?.format === 1 && publicReceipt.fingerprint === publicState.fingerprint;
const licensesFresh = evidenceIsFresh(runtimeReceipt?.licenses, licenses);
const auditFresh = evidenceIsFresh(runtimeReceipt?.audit, dependencies, {
  maxAgeMs: AUDIT_MAX_AGE_MS,
  node: process.version,
});

console.log(`版本：${metadata.version}`);
console.log(`运行时验证：${runtimeFresh ? `可复用（${runtimeReceipt.verifiedAt}）` : '需要刷新'}`);
console.log(`许可证检查：${licensesFresh ? `可复用（${runtimeReceipt.licenses.verifiedAt}）` : '需要刷新'}`);
console.log(`生产依赖审计：${auditFresh ? `可复用（${runtimeReceipt.audit.verifiedAt}，24 小时内）` : '需要刷新'}`);
console.log(`文档检查：${docsFresh ? `可复用（${docsReceipt.verifiedAt}）` : '需要刷新'}`);
console.log(`公共边界：${publicFresh ? `可复用（${publicReceipt.verifiedAt}）` : '需要刷新'}`);
if (releaseBase.issues.length) {
  console.log(`发布基线：不可发布；${releaseBase.issues.join(' ')}`);
} else {
  console.log(`发布基线：${releaseBase.upstreamVersion ? `当前主线 ${releaseBase.upstreamVersion}` : '未检测到 upstream/main'}；${releaseBase.newestTagVersion ? `最新标签 ${releaseBase.newestTagVersion}` : '未检测到发布标签'}`);
}
console.log(runtimeFresh && docsFresh && publicFresh && licensesFresh && auditFresh && releaseBase.issues.length === 0
  ? '结论：可以直接运行 release，或由 release:prepare 复用全部结果。'
  : '结论：先运行 pnpm run verify:auto；若发布基线过旧，先安全同步公开主线或递增版本。');
