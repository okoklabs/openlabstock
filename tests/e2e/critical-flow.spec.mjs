import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
let appProcess;
let baseUrl;
let dataDir;
let serverOutput = '';

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApp() {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'openlabstock-e2e-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  appProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: rootDir,
    env: { ...process.env, DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collectOutput = (chunk) => {
    serverOutput = `${serverOutput}${chunk}`.slice(-12_000);
  };
  appProcess.stdout.on('data', collectOutput);
  appProcess.stderr.on('data', collectOutput);

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (appProcess.exitCode !== null) throw new Error(`OpenLabStock exited during startup:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`OpenLabStock did not become healthy:\n${serverOutput}`);
}

async function stopApp() {
  if (appProcess?.exitCode === null) {
    const exited = new Promise((resolve) => appProcess.once('exit', resolve));
    appProcess.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

async function readBootstrap(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/bootstrap');
    if (!response.ok) throw new Error(`Bootstrap failed with ${response.status}`);
    return response.json();
  });
}

test.beforeAll(startApp);
test.afterAll(stopApp);

test('登录、二维码定位与确认登记只产生一次库存写入', async ({ page }, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(baseUrl);
  await expect(page.locator('[data-login-form]')).toBeVisible();
  await page.locator('#login-username').fill('student');
  await page.locator('#login-password').fill('demo123');
  await page.locator('[data-login-form] button[type="submit"]').click();
  await expect(page.locator('body')).toHaveClass(/auth-ready/);
  await expect(page.getByRole('heading', { name: '库存总览' })).toBeVisible();

  const before = await readBootstrap(page);
  const material = before.materials.find((item) => item.active && item.trackingMode === 'quantity' && item.quantity > 0);
  expect(material, '演示库存应包含可领用的普通数量耗材').toBeTruthy();

  await page.goto(`${baseUrl}/?material=${encodeURIComponent(material.id)}`);
  const transactionModal = page.locator('[data-modal="transaction"]');
  await expect(transactionModal).toHaveClass(/open/);
  await expect(page.locator('#material-name')).toHaveValue(material.name);
  expect(new URL(page.url()).searchParams.has('material')).toBe(false);

  const afterQrOpen = await readBootstrap(page);
  expect(afterQrOpen.transactionTotal).toBe(before.transactionTotal);
  expect(afterQrOpen.materials.find((item) => item.id === material.id).quantity).toBe(material.quantity);

  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow, `${testInfo.project.name} 不应出现页面级横向滚动`).toBe(false);

  await page.locator('#material-quantity').fill('1');
  await page.locator('#material-person').fill(`浏览器回归-${testInfo.project.name}`);
  await page.locator('[data-transaction-form] button[type="submit"]').click();
  await expect(transactionModal).not.toHaveClass(/open/);
  await expect(page.locator('[data-toast-message]')).toHaveText('领用 / 使用记录已保存');

  await expect.poll(async () => {
    const current = await readBootstrap(page);
    const currentMaterial = current.materials.find((item) => item.id === material.id);
    return { quantity: currentMaterial?.quantity, total: current.transactionTotal };
  }).toEqual({ quantity: material.quantity - 1, total: before.transactionTotal + 1 });

  expect(pageErrors, `页面运行错误：${pageErrors.join('; ')}`).toEqual([]);
});
