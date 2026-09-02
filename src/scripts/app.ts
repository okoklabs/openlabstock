import { detectMobileKeyboard, measureMobileViewport } from './mobile-viewport.mjs';
import { DEFAULT_RECORD_PAGE_SIZE } from './record-pagination.mjs';
import { terminalStateConfirmation } from './inventory-operation.mjs';
import { effectiveManualOutboundTransactions, groupConsumptionRows } from './inventory-export.mjs';
import { inventoryAnomalyEntryLabel, inventoryAnomalyResolutionBody } from './inventory-anomaly.mjs';
import { serializeJsonRequestBody } from './api-request.mjs';
import {
  createInventoryUnitQrPayload,
  createMaterialQrPayload,
  inventoryTargetFromQrText,
  inventoryUnitIdPattern,
  materialIdPattern,
} from './material-qr.mjs';

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((error) => {
      console.warn('PWA service worker registration failed', error);
    });
  }, { once: true });
}

type UserRole = 'admin' | 'inventory' | 'member';
type User = { id: string; username: string; name: string; note: string; role: UserRole; groupId: string; tagIds: string[]; active: boolean; lastLoginAt: string | null; isOwner: boolean };
type DirectoryUser = { id: string; name: string; note: string; role: UserRole; groupId: string; tagIds: string[]; isOwner: boolean };
type TrackingMode = 'quantity' | 'stateful' | 'tracked';
type Material = { id: string; name: string; category: string; quantity: number; availableQuantity: number; safetyStock: number; unit: string; spec: string; expiryWarningDays: number; trackingMode: TrackingMode; positionCodeHelp: string; usageContextHelp: string; active: boolean; updatedAt: string };
type InventoryStatus = { id: string; materialId: string; code: string; name: string; usable: boolean; terminal: boolean; active: boolean; sortOrder: number; quantity?: number };
type ExpiryInfo = { status: 'none' | 'normal' | 'expiring' | 'expired'; daysRemaining: number | null; expiryDate: string };
type ExpiryAlert = { materialId: string; materialName: string; inventoryUnitId: string; inventoryUnitLabel: string; expiryDate: string; status: 'expiring' | 'expired'; daysRemaining: number; quantity: number; unit: string };
type InventoryBalance = { inventoryUnitId: string; statusId: string; statusName: string; accessScope: 'shared' | 'user'; ownerUserId: string; ownerName: string; positionCode: string; displayCode: string; quantity: number; usable: boolean; terminal: boolean; expiry?: ExpiryInfo };
type InventoryUnit = { id: string; materialId: string; unitType: 'aggregate' | 'lot' | 'container' | 'position'; label: string; positionCode: string; displayLabel: string; capacity: number; expiryDate: string; expiry: ExpiryInfo; note: string; active: boolean; quantity: number; balances: InventoryBalance[]; createdAt: string; updatedAt: string };
type InventorySummary = { materialId: string; total: number; usable: number; unavailable: number; shared: number; reserved: number; sharedUsable: number; reservedUsable: number; expired: number; expiring: number; expiryWarningDays: number; unitCount: number; activeUnitCount: number; statuses: InventoryStatus[] };
type InventoryEvent = { id: string; materialId: string; materialName: string; inventoryUnitId: string; inventoryUnitLabel: string; quantity: number; eventType: 'use' | 'use_correction' | 'state_change' | 'access_change' | 'transfer' | 'dispose' | 'adjustment'; fromStatusId: string; fromStatusName: string; toStatusId: string; toStatusName: string; fromAccessScope: string; fromOwnerUserId: string; fromOwnerName: string; fromPositionCode: string; toAccessScope: string; toOwnerUserId: string; toOwnerName: string; toPositionCode: string; userId: string; userName: string; groupName: string; counterparty: string; note: string; correctionOfId: string; occurredAt: string; corrected?: boolean };
type InventoryAnomalyEntry = { statusId: string; statusName: string; accessScope: 'shared' | 'user'; ownerUserId: string; ownerName: string; positionCode: string; displayCode: string; quantity: number; repairable: boolean };
type InventoryAnomaly = { id: string; type: 'position_conflict' | 'capacity_exceeded' | 'material_quantity_mismatch'; materialId: string; materialName: string; materialUnit: string; inventoryUnitId: string; inventoryUnitLabel: string; positionCode: string; duplicate: boolean; invalidQuantities: boolean; totalQuantity: number; capacity?: number; storedQuantity?: number; entries: InventoryAnomalyEntry[] };
type InventoryDetailResponse = { material: Material; summary: InventorySummary; statuses: InventoryStatus[]; units: InventoryUnit[]; total: number };
type Transaction = { id: string; type: 'in' | 'out'; materialId: string; materialName: string; quantity: number; unit: string; userId: string; userName: string; groupId: string; groupName: string; sourceType: 'manual' | 'inventory_adjustment'; counterparty: string; note: string; occurredAt: string; operation?: 'stock' | 'dispose'; inventoryUnitId?: string; inventoryUnitLabel?: string; statusName?: string; accessScope?: string; ownerName?: string; positionCode?: string; correctionOfId?: string; correctedQuantity?: number | null };
type RecordPageItem = { kind: 'transaction'; occurredAt: string; record: Transaction } | { kind: 'event'; occurredAt: string; event: InventoryEvent };
type RecordPageResponse = { items: RecordPageItem[]; total: number; hasMore: boolean; nextCursor: string };
type AuditLog = { id: string; actorUserId: string; actorName: string; actorRole: 'owner' | 'admin' | 'inventory' | 'member' | 'system'; action: string; targetType: string; targetId: string; targetName: string; summary: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; sourceIp: string; requestId: string; occurredAt: string };
type AuditPageResponse = { items: AuditLog[]; total: number; hasMore: boolean; nextCursor: string; exportedAt?: string };
type StocktakeStatus = 'open' | 'completed' | 'cancelled';
type StocktakeScopeMode = 'all' | 'category' | 'material';
type Stocktake = { id: string; title: string; status: StocktakeStatus; createdByUserId: string; createdByName: string; createdAt: string; completedByUserId: string; completedByName: string; completedAt: string; cancelledByUserId: string; cancelledByName: string; cancelledAt: string; cancellationReason: string; itemCount: number; countedCount: number; differenceCount: number; adjustmentCount: number };
type StocktakeItem = { id: string; stocktakeId: string; scopeType: 'material' | 'inventory_unit'; materialId: string; materialName: string; materialUnit: string; trackingMode: TrackingMode; inventoryUnitId: string; inventoryUnitLabel: string; expectedQuantity: number; countedQuantity: number | null; currentQuantity: number | null; reason: string; resolutionNote: string; countedByUserId: string; countedByName: string; countedAt: string; adjustmentTransactionId: string; resolvedAt: string };
type StocktakeDetail = Stocktake & { items: StocktakeItem[] };
type UnitStats = { unit: string; totalIn: number; totalOut: number; inRecords: number; outRecords: number };
type MaterialStats = { materialId: string; currentUnit: UnitStats; otherUnits: UnitStats[]; lastInAt: string | null; lastOutAt: string | null };
type TrendPoint = { label: string; in: number; out: number };
type LabSettings = { appName: string; labName: string; brandIcon: string };
type Group = { id: string; name: string; isDefault: boolean };
type Tag = { id: string; name: string };
type Bootstrap = { version: string; user: User; settings: LabSettings; groups: Group[]; tags: Tag[]; directory: DirectoryUser[]; members: User[]; materials: Material[]; materialStats: MaterialStats[]; inventorySummaries: InventorySummary[]; expiryAlerts: ExpiryAlert[]; transactions: Transaction[]; transactionTotal: number; recentlyUsedMaterialIds: string[]; stats: { items: number; categories: number; lowStock: number; warningCount?: number; expiry?: number; normalStock: number; monthInRecords: number; monthOutRecords: number; monthInMaterials: number; monthOutMaterials: number }; trend: TrendPoint[] };
type ExportSnapshot = { exportedAt: string; settings: LabSettings; groups: Group[]; directory: DirectoryUser[]; materials: Material[]; materialStats: MaterialStats[]; inventorySummaries: InventorySummary[]; inventoryUnits: InventoryUnit[]; expiryAlerts: ExpiryAlert[]; transactions: Transaction[]; total: number; inventoryEvents: InventoryEvent[]; eventTotal: number };

const $ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document) => [...root.querySelectorAll<T>(selector)];

function ensureExpiryWarningField() {
  if ($('#edit-material-expiry-warning-days')) return;
  const trackingField = $('#edit-material-tracking-mode')?.closest<HTMLElement>('.field');
  if (!trackingField) return;
  const field = document.createElement('div');
  field.className = 'field';
  field.innerHTML = '<label for="edit-material-expiry-warning-days">临期提醒提前天数</label><input id="edit-material-expiry-warning-days" type="number" min="0" max="3650" step="1" value="30" required><span class="field-hint">每种耗材独立设置，默认 30 天；设为 0 关闭临期窗口，但过期仍会提醒。</span>';
  trackingField.before(field);
}

ensureExpiryWarningField();
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
const initial = (name: string) => [...name.trim()][0] || '员';
const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const exportPrefix = () => (state?.settings.appName.trim() || 'OpenLabStock').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 50);
const formatTime = (value: string | null) => {
  if (!value) return '尚未登录';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
};
const formatExportTime = (value: string | null) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
};
const localDateTimeValue = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const currentTransactionType = () => $('[data-transaction-type].active')?.getAttribute('data-transaction-type') === 'out' ? 'out' : 'in';
const roleLabel = (user: Pick<User, 'role' | 'isOwner'>) => user.isOwner
  ? '系统所有者'
  : user.role === 'admin'
    ? '系统管理员'
    : user.role === 'inventory'
      ? '库存管理员'
      : '普通成员';
const canManageInventory = (user: User) => user.role === 'admin' || user.role === 'inventory';
const canManageMembers = (user: User) => user.role === 'admin';

let state: Bootstrap | null = null;
let toastTimer = 0;
let xlsxModulePromise: Promise<typeof import('xlsx')> | null = null;
let qrCodeModulePromise: Promise<typeof import('qrcode')> | null = null;
let zxingModulePromise: Promise<typeof import('@zxing/browser')> | null = null;
let transactionLoadPromise: Promise<boolean> | null = null;
let transactionLoadController: AbortController | null = null;
let transactionLoadSequence = 0;
let bootstrapGeneration = 0;
let workspaceSlowTimer = 0;

const loadXlsx = () => {
  xlsxModulePromise ??= import('xlsx');
  return xlsxModulePromise;
};

const loadQrCode = () => {
  qrCodeModulePromise ??= import('qrcode');
  return qrCodeModulePromise;
};

const loadZxing = () => {
  zxingModulePromise ??= import('@zxing/browser');
  return zxingModulePromise;
};

const toast = (message: string) => {
  const node = $('[data-toast]');
  const label = $('[data-toast-message]');
  if (!node || !label) return;
  label.textContent = message;
  node.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2800);
};

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const body = serializeJsonRequestBody(options.body);
  const response = await fetch(url, {
    ...options,
    body,
    headers: body !== undefined && body !== null ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await response.json() : {};
  if (!response.ok) throw Object.assign(new Error(payload.error ?? '请求失败'), { status: response.status });
  return payload as T;
}

function beginWorkspaceLoading() {
  window.clearTimeout(workspaceSlowTimer);
  document.body.classList.remove('startup-slow');
  document.body.classList.add('workspace-loading');
  workspaceSlowTimer = window.setTimeout(() => document.body.classList.add('startup-slow'), 8000);
}

function finishWorkspaceLoading() {
  window.clearTimeout(workspaceSlowTimer);
  document.body.classList.remove('workspace-loading', 'startup-slow');
}

const views = $$<HTMLElement>('[data-view]');
const navItems = $$<HTMLButtonElement>('[data-view-target]');
const transactionModal = $('[data-modal="transaction"]');
const importModal = $('[data-modal="import"]');
const memberModal = $('[data-modal="member"]');
const memberActionModal = $('[data-modal="member-action"]');
const materialActionModal = $('[data-modal="material-action"]');
const materialInfoModal = $('[data-modal="material-info"]');
const inventoryDetailModal = $('[data-modal="inventory-detail"]');
const inventoryUnitEditModal = $('[data-modal="inventory-unit-edit"]');
const inventoryOperationModal = $('[data-modal="inventory-operation"]');
const settingsModal = $('[data-modal="settings"]');
const notificationsModal = $('[data-modal="notifications"]');
const permissionsModal = $('[data-modal="permissions"]');
const materialGuideModal = $('[data-modal="material-guide"]');
const scannerModal = $('[data-modal="scanner"]');
const materialQrModal = $('[data-modal="material-qr"]');
const batchLabelModal = $('[data-modal="batch-labels"]');
const correctionModal = $('[data-modal="transaction-correction"]');
const auditDetailModal = $('[data-modal="audit-detail"]');
const stocktakeModal = $('[data-modal="stocktakes"]');
const stocktakeCreateModal = $('[data-modal="stocktake-create"]');
const stocktakeCountModal = $('[data-modal="stocktake-count"]');
const stocktakeCancelModal = $('[data-modal="stocktake-cancel"]');
const confirmModal = $('[data-modal="confirm"]');
const sidebar = $('.sidebar');
const drawerScrim = $('[data-drawer-scrim]');
const menuToggle = $<HTMLButtonElement>('[data-menu-toggle]');
const inventoryOverflow = $('[data-inventory-overflow]');
const inventoryMoreButton = $<HTMLButtonElement>('[data-inventory-more]');
const inventoryCommandMenu = $('[data-inventory-command-menu]');
let memberActionTargetId = '';
let materialActionTargetId = '';
let materialInfoTargetId = '';
let inventoryDetailTargetId = '';
let inventoryDetailData: InventoryDetailResponse | null = null;
let inventoryUnitEditTarget: InventoryUnit | null = null;
let inventoryAnomalies: InventoryAnomaly[] = [];
let inventoryAnomalyTarget: { anomaly: InventoryAnomaly; entry: InventoryAnomalyEntry } | null = null;
let inventoryEventsLoaded = false;
const expandedInventoryUnitIds = new Set<string>();
let inventoryOperationUnit: InventoryUnit | null = null;
let inventoryOperationBalance: InventoryBalance | null = null;
let inventoryOperationReturnFocus: HTMLElement | null = null;
let unitQuantityFollowsCapacity = true;
let qrMaterialTargetId = '';
let qrInventoryUnitTarget: InventoryUnit | null = null;
let qrMaterialDataUrl = '';
let recordPageItems: RecordPageItem[] = [];
let recordTotal = 0;
let recordHasMore = false;
let recordNextCursor = '';
let recordCursorHistory = [''];
let recordFrom = '';
let recordPageLoadController: AbortController | null = null;
let recordPageLoadSequence = 0;
let recordSearchTimer = 0;
let exportSnapshot: ExportSnapshot | null = null;
let recordPage = 1;
let recordScope: 'all' | 'mine' = 'all';
let auditPageItems: AuditLog[] = [];
let auditTotal = 0;
let auditHasMore = false;
let auditNextCursor = '';
let auditCursorHistory = [''];
let auditPage = 1;
let auditLoadController: AbortController | null = null;
let auditLoadSequence = 0;
let auditSearchTimer = 0;
let stocktakes: Stocktake[] = [];
let stocktakeFilter: StocktakeStatus | 'all' = 'open';
let stocktakeDetail: StocktakeDetail | null = null;
let stocktakeCountTarget: StocktakeItem | null = null;
let inventoryDetailStocktakeReturn: { stocktakeId: string; unitId: string; countItemId: string; reopenCount: boolean; returnFocus: HTMLElement | null } | null = null;
let correctionTarget: Transaction | null = null;
let inventoryEventCorrectionTarget: InventoryEvent | null = null;
const batchLabelSelectedIds = new Set<string>();
type MaterialLabelSizeKey = '40x25' | '50x30' | '70x40' | '86x54' | 'custom';
type MaterialLabelSize = { key: string; width: number; height: number; padding: number; gap: number; titleSize: number; brandSize: number; metaSize: number; idSize: number };
const materialLabelPresetDimensions: Record<Exclude<MaterialLabelSizeKey, 'custom'>, [number, number]> = {
  '40x25': [40, 25],
  '50x30': [50, 30],
  '70x40': [70, 40],
  '86x54': [86, 54],
};
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));
const materialLabelSize = (key: string, width: number, height: number): MaterialLabelSize => ({
  key,
  width,
  height,
  padding: clamp(height * 0.08, 1.75, 4),
  gap: clamp(height * 0.073, 1.6, 4),
  titleSize: clamp(height * 0.103, 2.4, 4.4),
  brandSize: clamp(height * 0.06, 1.45, 2.4),
  metaSize: clamp(height * 0.06, 1.45, 2.5),
  idSize: clamp(height * 0.045, 1.1, 1.8),
});
let materialLabelPreviewGeneration = 0;
let materialLabelPreviewTimer = 0;
let materialLabelPreviewDataUrl = '';
let materialLabelPreviewSignature = '';
let scannerReturnToTransaction = false;
let scannerReturnFocus: HTMLElement | null = null;
let scannerControls: { stop: () => void } | null = null;
let scannerOpening = false;
let scannerResultHandled = false;
let scannerGeneration = 0;
let brandIconDraft = '';
let selectMenuSequence = 0;
let modalReturnFocus: HTMLElement | null = null;
let confirmReturnFocus: HTMLElement | null = null;
let confirmResolver: ((confirmed: boolean) => void) | null = null;
let modalLayerSequence = 50;
let mobileDrawerScrollY = 0;
let mobileDrawerLocked = false;
let modalPageScrollY = 0;
let modalPageLocked = false;
let modalPagePreviousBodyTop = '';
let modalViewportBaselineHeight = 0;
let mobileViewportUpdateTimer = 0;
const mobileDrawerMedia = window.matchMedia('(max-width: 760px)');

type M3SelectController = {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  value: HTMLElement;
  menu: HTMLElement;
};

const m3SelectControllers = new WeakMap<HTMLSelectElement, M3SelectController>();

function closeM3Menus(except?: HTMLElement) {
  $$<HTMLElement>('.m3-select.open, .m3-autocomplete.open').forEach((root) => {
    if (root === except) return;
    root.classList.remove('open');
    $<HTMLButtonElement>('.m3-select-trigger', root)?.setAttribute('aria-expanded', 'false');
    $<HTMLInputElement>('.m3-autocomplete-input', root)?.setAttribute('aria-expanded', 'false');
  });
}

function refreshM3Select(select: HTMLSelectElement) {
  const controller = m3SelectControllers.get(select);
  if (!controller) return;
  const selected = select.selectedOptions[0];
  controller.value.textContent = selected?.textContent?.trim() || '请选择';
  controller.trigger.disabled = select.disabled;
  controller.trigger.setAttribute('aria-label', `${select.labels?.[0]?.textContent?.trim() || select.getAttribute('aria-label') || '选择'}：${controller.value.textContent}`);
  controller.menu.replaceChildren();
  [...select.options].forEach((option, index) => {
    if (option.hidden) return;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'm3-select-option';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option.selected));
    item.dataset.optionIndex = String(index);
    item.disabled = option.disabled;
    item.classList.toggle('selected', option.selected);
    const label = document.createElement('span');
    label.textContent = option.textContent;
    const check = document.createElement('span');
    check.className = 'm3-select-check';
    check.setAttribute('aria-hidden', 'true');
    item.append(label, check);
    item.addEventListener('click', () => {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      refreshM3Select(select);
      closeM3Menus();
      controller.trigger.focus();
    });
    item.addEventListener('keydown', (event) => {
      const options = $$<HTMLButtonElement>('.m3-select-option:not(:disabled)', controller.menu);
      const current = options.indexOf(item);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        options[(current + offset + options.length) % options.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        options[event.key === 'Home' ? 0 : options.length - 1]?.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeM3Menus();
        controller.trigger.focus();
      }
    });
    controller.menu.append(item);
  });
}

function revealStocktakeScopeMenu(menu: HTMLElement) {
  if (!menu.closest('[data-modal="stocktake-create"]')) return;
  requestAnimationFrame(() => menu.scrollIntoView({ block: 'nearest' }));
}

function setM3SelectOpen(select: HTMLSelectElement, open: boolean) {
  const controller = m3SelectControllers.get(select);
  if (!controller || select.disabled) return;
  closeM3Menus(open ? controller.root : undefined);
  controller.root.classList.toggle('open', open);
  controller.trigger.setAttribute('aria-expanded', String(open));
  if (open) {
    refreshM3Select(select);
    requestAnimationFrame(() => {
      $<HTMLButtonElement>('.m3-select-option.selected', controller.menu)?.focus();
      revealStocktakeScopeMenu(controller.menu);
    });
  }
}

function enhanceM3Select(select: HTMLSelectElement) {
  if (m3SelectControllers.has(select)) return;
  const root = document.createElement('div');
  root.className = `m3-select ${select.classList.contains('filter-select') ? 'toolbar-select' : 'field-select'}`;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'm3-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const value = document.createElement('span');
  value.className = 'm3-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'm3-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  const menu = document.createElement('div');
  menu.className = 'm3-select-menu';
  menu.id = `m3-select-menu-${++selectMenuSequence}`;
  menu.setAttribute('role', 'listbox');
  trigger.setAttribute('aria-controls', menu.id);
  select.before(root);
  root.append(select, trigger, menu);
  select.dataset.m3Enhanced = 'true';
  select.hidden = true;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  m3SelectControllers.set(select, { root, trigger, value, menu });
  trigger.addEventListener('click', () => setM3SelectOpen(select, !root.classList.contains('open')));
  trigger.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      setM3SelectOpen(select, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeM3Menus();
    }
  });
  select.addEventListener('change', () => refreshM3Select(select));
  select.labels?.forEach((label) => label.addEventListener('click', (event) => {
    event.preventDefault();
    trigger.focus();
  }));
  refreshM3Select(select);
}

function enhanceM3Selects() {
  $$<HTMLSelectElement>('select').forEach(enhanceM3Select);
}

function renderM3Autocomplete(input: HTMLInputElement, open = true) {
  const root = input.closest<HTMLElement>('.m3-autocomplete');
  const menu = root ? $<HTMLElement>('.m3-autocomplete-menu', root) : null;
  const sourceId = input.dataset.listSource;
  const datalist = sourceId ? document.getElementById(sourceId) as HTMLDataListElement | null : null;
  if (!root || !menu || !datalist) return;
  if (input.readOnly || input.disabled) {
    closeM3Menus();
    return;
  }
  const query = input.value.trim().toLowerCase();
  const options = [...datalist.options]
    .filter((option) => !query || `${option.value} ${option.label}`.toLowerCase().includes(query))
    .slice(0, 8);
  menu.replaceChildren();
  options.forEach((option) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'm3-select-option m3-autocomplete-option';
    item.setAttribute('role', 'option');
    const content = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = option.value;
    content.append(name);
    if (option.label && option.label !== option.value) {
      const meta = document.createElement('small');
      meta.textContent = option.label;
      content.append(meta);
    }
    item.append(content);
    item.addEventListener('click', () => {
      input.value = option.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
      closeM3Menus();
    });
    item.addEventListener('keydown', (event) => {
      const items = $$<HTMLButtonElement>('.m3-autocomplete-option', menu);
      const current = items.indexOf(item);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const offset = event.key === 'ArrowDown' ? 1 : -1;
        items[(current + offset + items.length) % items.length]?.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        item.click();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeM3Menus();
        input.focus();
      }
    });
    menu.append(item);
  });
  const shouldOpen = open && options.length > 0;
  closeM3Menus(shouldOpen ? root : undefined);
  root.classList.toggle('open', shouldOpen);
  input.setAttribute('aria-expanded', String(shouldOpen));
  if (shouldOpen) revealStocktakeScopeMenu(menu);
}

function enhanceM3Autocomplete(input: HTMLInputElement) {
  if (input.dataset.listSource || !input.list?.id) return;
  const sourceId = input.list.id;
  const root = document.createElement('div');
  root.className = 'm3-autocomplete';
  const menu = document.createElement('div');
  menu.className = 'm3-select-menu m3-autocomplete-menu';
  menu.id = `m3-autocomplete-menu-${++selectMenuSequence}`;
  menu.setAttribute('role', 'listbox');
  input.before(root);
  root.append(input, menu);
  input.dataset.listSource = sourceId;
  input.removeAttribute('list');
  input.classList.add('m3-autocomplete-input');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', menu.id);
  input.setAttribute('aria-expanded', 'false');
  input.addEventListener('focus', () => renderM3Autocomplete(input));
  input.addEventListener('input', () => renderM3Autocomplete(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      renderM3Autocomplete(input);
      requestAnimationFrame(() => $<HTMLButtonElement>('.m3-autocomplete-option', menu)?.focus());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeM3Menus();
    }
  });
}

function enhanceM3Autocompletes() {
  $$<HTMLInputElement>('input[list]').forEach(enhanceM3Autocomplete);
}

function inventoryCommandItems() {
  return inventoryCommandMenu
    ? $$<HTMLButtonElement>('[data-inventory-action]:not(.is-hidden)', inventoryCommandMenu)
    : [];
}

function setInventoryMoreOpen(open: boolean, restoreFocus = false, focusFirst = false) {
  if (!inventoryOverflow || !inventoryMoreButton || !inventoryCommandMenu) return;
  inventoryOverflow.classList.toggle('open', open);
  inventoryMoreButton.setAttribute('aria-expanded', String(open));
  inventoryCommandMenu.setAttribute('aria-hidden', String(!open));
  if (open && focusFirst) requestAnimationFrame(() => inventoryCommandItems()[0]?.focus());
  else if (restoreFocus) inventoryMoreButton.focus();
}

const switchView = (name = 'dashboard') => {
  if (name === 'audit' && state?.user.role !== 'admin') name = 'dashboard';
  setInventoryMoreOpen(false);
  closeM3Menus();
  views.forEach((view) => view.classList.toggle('active', view.dataset.view === name));
  navItems.forEach((item) => item.classList.toggle('active', item.dataset.viewTarget === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'transactions') void loadRecordPage();
  if (name === 'audit') void loadAuditPage();
};

const closeModals = () => {
  const hadOpenModal = Boolean($('.modal-backdrop.open'));
  stopScanner();
  scannerReturnFocus = null;
  scannerReturnToTransaction = false;
  setInventoryMoreOpen(false);
  closeM3Menus();
  if (confirmResolver) {
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve(false);
  }
  confirmReturnFocus = null;
  correctionTarget = null;
  inventoryEventCorrectionTarget = null;
  inventoryAnomalyTarget = null;
  inventoryDetailStocktakeReturn = null;
  inventoryUnitEditTarget = null;
  [transactionModal, importModal, memberModal, memberActionModal, materialActionModal, materialInfoModal, inventoryDetailModal, inventoryUnitEditModal, inventoryOperationModal, settingsModal, notificationsModal, permissionsModal, materialGuideModal, scannerModal, materialQrModal, batchLabelModal, correctionModal, auditDetailModal, stocktakeModal, stocktakeCreateModal, stocktakeCountModal, stocktakeCancelModal, confirmModal, $('[data-modal="inventory-anomaly-fix"]')].forEach((modal) => hideModal(modal));
  modalLayerSequence = 50;
  document.body.classList.remove('modal-open');
  unlockModalPage();
  if (hadOpenModal && modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
};

function bringModalToFront(modal: Element | null) {
  if (!modal) return;
  modalLayerSequence = Math.max(50, modalLayerSequence) + 1;
  modal.style.zIndex = String(modalLayerSequence);
  modal.classList.add('open');
}

function hideModal(modal: Element | null) {
  modal?.classList.remove('open');
  modal?.style.removeProperty('z-index');
}

function lockModalPage() {
  if (!mobileDrawerMedia.matches || modalPageLocked) return;
  modalPageScrollY = window.scrollY;
  modalPagePreviousBodyTop = document.body.style.top;
  document.documentElement.classList.add('modal-page-locked');
  document.body.classList.add('modal-page-locked');
  document.body.style.top = `-${modalPageScrollY}px`;
  modalPageLocked = true;
}

function unlockModalPage() {
  if (!modalPageLocked) return;
  document.documentElement.classList.remove('modal-page-locked');
  document.body.classList.remove('modal-page-locked');
  document.body.style.top = modalPagePreviousBodyTop;
  modalPageLocked = false;
  modalViewportBaselineHeight = 0;
  document.documentElement.classList.remove('mobile-keyboard-open');
  window.scrollTo(0, modalPageScrollY);
}

function updateMobileViewportMetrics() {
  const viewport = window.visualViewport;
  const { height, offsetTop } = measureMobileViewport(viewport, window.innerHeight);
  document.documentElement.style.setProperty('--mobile-viewport-height', `${height}px`);
  document.documentElement.style.setProperty('--mobile-viewport-offset-top', `${offsetTop}px`);
  if (mobileDrawerLocked) document.documentElement.style.setProperty('--mobile-drawer-height', `${height}px`);

  const activeElement = document.activeElement;
  const focusedFormControl = activeElement instanceof HTMLInputElement
    || activeElement instanceof HTMLTextAreaElement
    || activeElement instanceof HTMLSelectElement;
  const focusedInsideModal = Boolean(focusedFormControl && activeElement?.closest('.modal-backdrop.open'));
  const keyboardOpen = detectMobileKeyboard({
    mobile: mobileDrawerMedia.matches,
    focusedInsideModal,
    baselineHeight: modalViewportBaselineHeight,
    height,
    offsetTop,
  });
  document.documentElement.classList.toggle('mobile-keyboard-open', keyboardOpen);
}

function scheduleMobileViewportUpdates() {
  window.clearTimeout(mobileViewportUpdateTimer);
  updateMobileViewportMetrics();
  mobileViewportUpdateTimer = window.setTimeout(updateMobileViewportMetrics, 80);
  window.setTimeout(updateMobileViewportMetrics, 220);
  window.setTimeout(updateMobileViewportMetrics, 420);
}

const openModal = (modal: Element | null) => {
  setInventoryMoreOpen(false);
  closeM3Menus();
  if (modal) lockModalPage();
  modalViewportBaselineHeight = measureMobileViewport(window.visualViewport, window.innerHeight).height;
  updateMobileViewportMetrics();
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  bringModalToFront(modal);
  const modalBody = modal?.querySelector<HTMLElement>('.modal-body');
  if (modalBody) modalBody.scrollTop = 0;
  document.body.classList.toggle('modal-open', Boolean(modal));
  requestAnimationFrame(() => {
    if (mobileDrawerMedia.matches) {
      const dialog = modal?.querySelector<HTMLElement>('.modal');
      if (dialog) {
        dialog.tabIndex = -1;
        dialog.focus({ preventScroll: true });
      }
      return;
    }
    const target = modal?.querySelector<HTMLElement>('input:not([type="file"]):not([aria-hidden="true"]), textarea, .m3-select-trigger, button:not([data-close-modal])');
    target?.focus();
  });
};

const finishConfirmation = (confirmed: boolean) => {
  const resolve = confirmResolver;
  confirmResolver = null;
  hideModal(confirmModal);
  document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
  if (!$('.modal-backdrop.open')) unlockModalPage();
  if (confirmReturnFocus?.isConnected) confirmReturnFocus.focus();
  confirmReturnFocus = null;
  resolve?.(confirmed);
};

const askConfirmation = ({ title, message, confirmLabel }: { title: string; message: string; confirmLabel: string }) => {
  if (confirmResolver) finishConfirmation(false);
  const titleNode = $('[data-confirm-title]');
  const messageNode = $('[data-confirm-message]');
  const submit = $<HTMLButtonElement>('[data-confirm-submit]');
  if (titleNode) titleNode.textContent = title;
  if (messageNode) messageNode.textContent = message;
  if (submit) submit.textContent = confirmLabel;
  confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  updateMobileViewportMetrics();
  bringModalToFront(confirmModal);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => submit?.focus());
  return new Promise<boolean>((resolve) => { confirmResolver = resolve; });
};

const setMobileDrawer = (open: boolean) => {
  const nextOpen = open && mobileDrawerMedia.matches;
  if (nextOpen && !mobileDrawerLocked) {
    if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) {
      document.activeElement.blur();
    }
    mobileDrawerScrollY = window.scrollY;
    document.documentElement.classList.add('drawer-open');
    document.body.classList.add('drawer-open');
    mobileDrawerLocked = true;
    updateMobileViewportMetrics();
    window.setTimeout(updateMobileViewportMetrics, 320);
    document.body.style.top = `-${mobileDrawerScrollY}px`;
  } else if (!nextOpen && mobileDrawerLocked) {
    document.documentElement.classList.remove('drawer-open');
    document.body.classList.remove('drawer-open');
    document.body.style.top = '';
    document.documentElement.style.removeProperty('--mobile-drawer-height');
    mobileDrawerLocked = false;
    window.scrollTo(0, mobileDrawerScrollY);
  }
  sidebar?.classList.toggle('mobile-open', nextOpen);
  drawerScrim?.classList.toggle('open', nextOpen);
  menuToggle?.setAttribute('aria-expanded', String(nextOpen));
  menuToggle?.setAttribute('aria-label', nextOpen ? '关闭导航' : '打开导航');
  menuToggle?.setAttribute('title', nextOpen ? '关闭导航' : '打开导航');
};

mobileDrawerMedia.addEventListener('change', (event) => {
  setInventoryMoreOpen(false);
  if (!event.matches) setMobileDrawer(false);
  if (state) renderDirectory();
});
window.addEventListener('orientationchange', () => setMobileDrawer(false));
window.visualViewport?.addEventListener('resize', updateMobileViewportMetrics);
window.visualViewport?.addEventListener('scroll', updateMobileViewportMetrics);
window.addEventListener('resize', scheduleMobileViewportUpdates);
document.addEventListener('focusin', (event) => {
  if ((event.target as Element | null)?.closest('.modal-backdrop.open')) scheduleMobileViewportUpdates();
});
document.addEventListener('focusout', (event) => {
  if ((event.target as Element | null)?.closest('.modal-backdrop.open')) scheduleMobileViewportUpdates();
});

const materialRippleSelector = '.button, .icon-button, .text-button, .material-info-trigger, .nav-item, .quick-action, .segment, .m3-select-trigger, .m3-select-option, .inventory-command-item, .stocktake-batch-row, .mobile-nav button';
document.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const target = (event.target as Element).closest<HTMLElement>(materialRippleSelector);
  if (!target || target.matches(':disabled') || target.getAttribute('aria-disabled') === 'true') return;
  const rect = target.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));
  const ripple = document.createElement('span');
  ripple.className = 'm3-ripple';
  ripple.setAttribute('aria-hidden', 'true');
  ripple.style.width = `${radius * 2}px`;
  ripple.style.height = `${radius * 2}px`;
  ripple.style.left = `${x - radius}px`;
  ripple.style.top = `${y - radius}px`;
  target.append(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});

function stockStatus(material: Material) {
  if (!material.active) return 'archived';
  if (material.availableQuantity === 0) return 'out';
  return material.availableQuantity <= material.safetyStock ? 'low' : 'ok';
}

function materialStatusPresentation(material: Material, expiryStatus: ReturnType<typeof materialExpiryStatus>) {
  const summary = state?.inventorySummaries.find((candidate) => candidate.materialId === material.id);
  if (!material.active) return { label: '已归档', className: 'archived', description: '已归档，不参与日常库存、预警或登记' };
  if (expiryStatus === 'expired') {
    const count = summary?.expired ? `有 ${formatNumber(summary.expired)} ${material.unit} ` : '';
    return { label: '过期批次', className: 'low', description: `${count}已过期，不能正常领用；请登记处置` };
  }
  if (expiryStatus === 'expiring') {
    const count = summary?.expiring ? `有 ${formatNumber(summary.expiring)} ${material.unit} ` : '';
    const days = summary?.expiryWarningDays ?? 30;
    return { label: '临期批次', className: 'warning', description: `${count}将在 ${days} 天内到期，请及时确认` };
  }
  const stockLevel = stockStatus(material);
  if (stockLevel === 'out') {
    return { label: '缺货', className: 'low', description: `开放可用数量为 0 ${material.unit}，暂无可用库存` };
  }
  if (stockLevel === 'low') {
    return { label: '低库存', className: 'low', description: `开放可用数量 ${formatNumber(material.availableQuantity)} ${material.unit}，已达到或低于安全库存线 ${formatNumber(material.safetyStock)} ${material.unit}` };
  }
  return {
    label: '正常',
    className: 'ok',
    description: material.trackingMode === 'quantity'
      ? '库存高于安全库存线；普通数量模式未启用批次有效期'
      : '库存高于安全库存线，当前没有临期或过期批次',
  };
}

function lowStockPresentation(material: Material) {
  if (material.availableQuantity === 0) {
    return { label: '缺货', description: '开放库存为 0，暂无可用库存' };
  }
  return { label: '低库存', description: `开放库存 ${formatNumber(material.availableQuantity)} ${material.unit}，已达到或低于安全库存线 ${formatNumber(material.safetyStock)} ${material.unit}` };
}

function statusChipMarkup(label: string, className: string, description: string) {
  const accessibleLabel = `${label}：${description}`;
  return `<span class="status-chip ${className}" title="${escapeHtml(description)}" aria-label="${escapeHtml(accessibleLabel)}">${escapeHtml(label)}</span>`;
}

function materialExpiryStatus(material: Material): 'normal' | 'expiring' | 'expired' | 'none' {
  const summary = state?.inventorySummaries.find((candidate) => candidate.materialId === material.id);
  if (!summary || material.trackingMode === 'quantity') return 'none';
  return summary.expired > 0 ? 'expired' : summary.expiring > 0 ? 'expiring' : 'normal';
}

function expiryDescription(expiry: ExpiryInfo) {
  if (expiry.status === 'expired') return `已于 ${expiry.expiryDate} 过期`;
  if (expiry.status === 'expiring') return expiry.daysRemaining === 0 ? `今日到期（${expiry.expiryDate}）` : `${expiry.expiryDate} 到期（剩 ${expiry.daysRemaining} 天）`;
  return expiry.expiryDate ? `${expiry.expiryDate} 到期` : '未设置有效期';
}

function lowStockMaterials() {
  return state?.materials.filter((material) => ['out', 'low'].includes(stockStatus(material))).sort((a, b) => (a.availableQuantity / Math.max(1, a.safetyStock)) - (b.availableQuantity / Math.max(1, b.safetyStock))) ?? [];
}

function renderMaterialOptions(type: 'in' | 'out' = currentTransactionType()) {
  if (!state) return;
  const options = $('[data-material-options]');
  if (!options) return;
  const recentRanks = new Map((state.recentlyUsedMaterialIds ?? []).map((materialId, index) => [materialId, index]));
  const materials = state.materials.filter((material) => material.active).sort((left, right) => {
    if (type === 'out') {
      const leftRank = recentRanks.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightRank = recentRanks.get(right.id) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    return left.name.localeCompare(right.name, 'zh-CN-u-co-pinyin', { numeric: true, sensitivity: 'base' });
  });
  options.innerHTML = materials.map((material) => {
    const recent = type === 'out' && recentRanks.has(material.id);
    const prefix = recent ? '最近使用 · ' : '';
    return `<option value="${escapeHtml(material.name)}" label="${prefix}开放可用 ${formatNumber(material.availableQuantity)} ${escapeHtml(material.unit)}"></option>`;
  }).join('');
}

function renderMaterials() {
  if (!state) return;
  const inventoryBody = $('[data-inventory-body]');
  if (inventoryBody) {
    const template = $<HTMLTemplateElement>('[data-inventory-row-template]');
    const fragment = document.createDocumentFragment();
    state.materials.forEach((material) => {
      const row = template?.content.firstElementChild?.cloneNode(true) as HTMLTableRowElement | undefined;
      if (!row) return;
      const lifecycleStatus = stockStatus(material);
      const low = lifecycleStatus === 'out' || lifecycleStatus === 'low';
      const expiryStatus = materialExpiryStatus(material);
      const expirySummary = state.inventorySummaries.find((candidate) => candidate.materialId === material.id);
      row.dataset.stockStatus = lifecycleStatus;
      row.dataset.expired = String((expirySummary?.expired ?? 0) > 0);
      row.dataset.expiring = String((expirySummary?.expiring ?? 0) > 0);
      $('[data-inventory-initial]', row)!.textContent = initial(material.name);
      $('[data-inventory-name]', row)!.textContent = material.name;
      $('[data-inventory-spec]', row)!.textContent = material.spec ? `规格、型号：${material.spec}` : '规格、型号：未填写';
      const trackingLabel = $<HTMLElement>('[data-inventory-tracking]', row)!;
      trackingLabel.hidden = material.trackingMode === 'quantity';
      trackingLabel.textContent = material.trackingMode === 'tracked' ? '按批次 / 单件管理' : '按状态统计';
      $$<HTMLButtonElement>('[data-material-info]', row).forEach((infoAction) => {
        infoAction.dataset.materialInfo = material.id;
        infoAction.setAttribute('aria-label', `查看 ${material.name} 的耗材详情`);
      });
      $('[data-inventory-category]', row)!.textContent = material.category;
      const quantity = $('[data-inventory-quantity]', row)!;
      quantity.textContent = formatNumber(material.availableQuantity);
      quantity.setAttribute('data-unit', material.unit);
      quantity.classList.toggle('stock-low', low);
      const total = $<HTMLElement>('[data-inventory-total]', row)!;
      total.hidden = material.trackingMode === 'quantity';
      total.textContent = `总数 ${formatNumber(material.quantity)} ${material.unit}`;
      const safety = $('[data-inventory-safety]', row)!;
      safety.textContent = formatNumber(material.safetyStock);
      safety.setAttribute('data-unit', material.unit);
      $('[data-inventory-unit]', row)!.textContent = material.unit;
      $('[data-inventory-updated]', row)!.textContent = formatTime(material.updatedAt);
      const status = $('[data-inventory-status]', row)!;
      const statusView = materialStatusPresentation(material, expiryStatus);
      status.classList.remove('ok', 'low', 'warning', 'archived');
      status.classList.add(statusView.className);
      status.textContent = statusView.label;
      status.title = statusView.description;
      status.setAttribute('aria-label', `${statusView.label}：${statusView.description}`);
      const action = $<HTMLButtonElement>('[data-material-action]', row)!;
      action.dataset.materialAction = material.id;
      action.setAttribute('aria-label', `管理耗材 ${material.name}`);
      action.classList.toggle('is-hidden', !canManageInventory(state!.user));
      const detailAction = $<HTMLButtonElement>('[data-inventory-detail]', row)!;
      detailAction.dataset.inventoryDetail = material.id;
      detailAction.setAttribute('aria-label', `查看 ${material.name} 的库存明细`);
      detailAction.classList.toggle('is-hidden', material.trackingMode === 'quantity');
      const qrAction = $<HTMLButtonElement>('[data-material-qr]', row)!;
      qrAction.dataset.materialQr = material.id;
      qrAction.setAttribute('aria-label', `查看 ${material.name} 的二维码标签`);
      fragment.append(row);
    });
    inventoryBody.replaceChildren(fragment);
    applyInventoryFilters();
  }

  const lowMaterials = lowStockMaterials();
  const lowSubtitle = $('[data-low-stock-panel-subtitle]');
  if (lowSubtitle) lowSubtitle.textContent = lowMaterials.length ? `共 ${lowMaterials.length} 种耗材需要补货，列表可滚动查看` : '当前所有耗材均高于安全库存';
  const lowBody = $('[data-low-stock-body]');
  if (lowBody) {
    lowBody.innerHTML = lowMaterials.length ? lowMaterials.map((material) => {
      const statusView = lowStockPresentation(material);
      return `<tr><td><div class="stock-item"><span class="item-avatar">${escapeHtml(initial(material.name))}</span><span><strong>${escapeHtml(material.name)}</strong><span>${escapeHtml(material.category)}${material.spec ? ` · ${escapeHtml(material.spec)}` : ''}</span></span></div></td><td class="stock-number stock-low">${formatNumber(material.availableQuantity)} ${escapeHtml(material.unit)}</td><td>${formatNumber(material.safetyStock)} ${escapeHtml(material.unit)}</td><td>${statusChipMarkup(statusView.label, 'low', statusView.description)}</td></tr>`;
    }).join('') : '<tr><td colspan="4" class="empty-note">当前没有低库存耗材</td></tr>';
  }

  renderExpiryAlerts();

  renderMaterialOptions();
}

function renderExpiryAlerts() {
  const panel = $('[data-expiry-panel]');
  const body = $('[data-expiry-body]');
  if (!panel || !body) return;
  const alerts = state?.expiryAlerts ?? [];
  const expired = alerts.filter((alert) => alert.status === 'expired');
  const expiring = alerts.filter((alert) => alert.status === 'expiring');
  panel.classList.toggle('is-hidden', alerts.length === 0);
  const subtitle = $('[data-expiry-panel-subtitle]');
  if (subtitle) subtitle.textContent = alerts.length
    ? `${expired.length ? `${expired.length} 个过期批次` : ''}${expired.length && expiring.length ? ' · ' : ''}${expiring.length ? `${expiring.length} 个临期批次` : ''}；临期天数按耗材独立设置`
    : '当前没有临期或过期批次';
  $$<HTMLButtonElement>('[data-show-expiry]').forEach((button) => {
    const status = button.dataset.showExpiry;
    const count = status === 'expired' ? expired.length : expiring.length;
    button.hidden = count === 0;
    button.textContent = status === 'expired' ? `查看过期（${count}）` : `查看临期（${count}）`;
  });
  body.innerHTML = alerts.length ? alerts.map((alert) => {
    const isExpired = alert.status === 'expired';
    const statusLabel = isExpired ? '已过期' : '临期';
    const description = isExpired ? `已于 ${alert.expiryDate} 过期，请登记处置` : alert.daysRemaining === 0 ? `今日到期（${alert.expiryDate}）` : `${alert.expiryDate} 到期，剩 ${alert.daysRemaining} 天`;
    return `<tr><td><div class="stock-item"><span class="item-avatar expiry-avatar ${isExpired ? 'expired' : 'expiring'}">${escapeHtml(initial(alert.materialName))}</span><span><strong>${escapeHtml(alert.materialName)}</strong><span>${escapeHtml(alert.inventoryUnitLabel)}</span></span></div></td><td>${escapeHtml(alert.expiryDate)}</td><td>${statusChipMarkup(statusLabel, isExpired ? 'low' : 'warning', description)}</td><td class="stock-number ${isExpired ? 'stock-low' : 'stock-mid'}">${formatNumber(alert.quantity)} ${escapeHtml(alert.unit)}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="empty-note">当前没有临期或过期批次</td></tr>';
}

function materialTrackingLabel(material: Material) {
  if (material.trackingMode === 'tracked') return '按批次 / 盒 / 单件管理';
  if (material.trackingMode === 'stateful') return '按状态统计';
  return '普通数量';
}

function syncMaterialTrackingGuidance(trackingMode: string, material?: Material) {
  const select = $<HTMLSelectElement>('#edit-material-tracking-mode');
  const labels: Record<string, string> = { quantity: '普通数量', stateful: '按状态统计', tracked: '按批次 / 盒 / 单件管理' };
  [...(select?.options ?? [])].forEach((option) => { if (labels[option.value]) option.textContent = labels[option.value]; });
  const guidance = $<HTMLElement>('[data-material-tracking-guidance-panel]');
  if (guidance) guidance.hidden = trackingMode !== 'tracked';
  const detailButton = $<HTMLButtonElement>('[data-material-action-detail]');
  if (detailButton) detailButton.hidden = trackingMode !== 'tracked' || !material;
}

function syncInventoryUnitTypeForm() {
  const select = $<HTMLSelectElement>('#unit-type');
  const capacity = $<HTMLInputElement>('#unit-capacity');
  const quantity = $<HTMLInputElement>('#unit-quantity');
  if (!select || !capacity || !quantity) return;
  const options: Record<string, string> = {
    lot: '批次（试剂、耗材）',
    container: '盒 / 容器（可选容量）',
    position: '单件 / 序列号（数量固定 1）',
  };
  [...select.options].forEach((option) => { if (options[option.value]) option.textContent = options[option.value]; });
  const type = select.value || 'lot';
  const capacityField = capacity.closest<HTMLElement>('.field');
  const capacityLabel = capacityField?.querySelector('label');
  const quantityLabel = $<HTMLLabelElement>('label[for="unit-quantity"]');
  if (capacityField) capacityField.hidden = type !== 'container';
  if (capacityLabel) capacityLabel.textContent = '盒容量（选填）';
  if (type !== 'container') capacity.value = '0';
  quantity.readOnly = type === 'position';
  if (type === 'position') quantity.value = '1';
  if (quantityLabel) quantityLabel.textContent = type === 'position' ? '数量（固定 1）' : type === 'lot' ? '本批次初始数量' : '初始数量（未填写格位时）';
  const hint = quantity.parentElement?.querySelector<HTMLElement>('[data-unit-quantity-hint]') ?? (() => {
    const node = document.createElement('span');
    node.className = 'field-hint';
    node.dataset.unitQuantityHint = '';
    quantity.parentElement?.append(node);
    return node;
  })();
  if (hint) hint.textContent = type === 'position'
    ? '单件 / 序列号始终按 1 件入库。'
    : type === 'lot'
      ? '同一批来源、同一有效期的数量放在一个批次中。'
      : '盒 / 容器可按需要填写容量；留空或 0 表示不设上限。';
}

function openMaterialInfo(materialId: string) {
  const material = state?.materials.find((candidate) => candidate.id === materialId);
  if (!material || !state) return;
  materialInfoTargetId = material.id;
  const fields: Array<[string, string]> = [
    ['[data-material-info-name]', material.name],
    ['[data-material-info-category]', material.category || '未填写'],
    ['[data-material-info-spec]', material.spec || '未填写'],
    ['[data-material-info-stock]', material.trackingMode === 'quantity'
      ? `${formatNumber(material.quantity)} ${material.unit}`
      : `开放可用 ${formatNumber(material.availableQuantity)} / 总数 ${formatNumber(material.quantity)} ${material.unit}`],
    ['[data-material-info-safety]', `${formatNumber(material.safetyStock)} ${material.unit}`],
    ['[data-material-info-tracking]', materialTrackingLabel(material)],
    ['[data-material-info-lifecycle]', material.active ? '使用中' : '已归档'],
    ['[data-material-info-updated]', formatTime(material.updatedAt)],
  ];
  fields.forEach(([selector, value]) => {
    const field = $(selector);
    if (field) field.textContent = value;
  });
  const infoList = $('.material-info-list');
  if (infoList) {
    let expiryNode = $('[data-material-info-expiry]', infoList);
    if (!expiryNode) {
      const item = document.createElement('div');
      item.className = 'material-info-item';
      item.innerHTML = '<span>有效期提醒</span><strong data-material-info-expiry>-</strong>';
      infoList.append(item);
      expiryNode = $('[data-material-info-expiry]', infoList);
    }
    const summary = state.inventorySummaries.find((candidate) => candidate.materialId === material.id);
    expiryNode.textContent = material.trackingMode === 'quantity'
      ? `普通数量模式未启用批次有效期（提醒设置 ${material.expiryWarningDays ?? 30} 天）`
      : summary?.expired ? `有 ${formatNumber(summary.expired)} ${material.unit} 已过期`
        : summary?.expiring ? `有 ${formatNumber(summary.expiring)} ${material.unit} 将在 ${summary.expiryWarningDays} 天内到期`
          : `当前没有临期或过期库存（提前 ${material.expiryWarningDays ?? 30} 天提醒）`;
  }
  const title = $('[data-material-info-title]');
  const subtitle = $('[data-material-info-subtitle]');
  if (title) title.textContent = material.name;
  if (subtitle) subtitle.textContent = '完整信息与后续操作';
  const detailAction = $<HTMLButtonElement>('[data-material-info-detail]');
  const manageAction = $<HTMLButtonElement>('[data-material-info-manage]');
  detailAction?.toggleAttribute('hidden', material.trackingMode === 'quantity');
  manageAction?.toggleAttribute('hidden', !canManageInventory(state.user));
  openModal(materialInfoModal);
}

function inventoryOwnerOptions(selectedId = '') {
  if (!state) return '';
  const owners = state.user.role === 'admin' ? state.directory : state.directory.filter((candidate) => candidate.id === state!.user.id);
  return owners
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }))
    .map((owner) => {
      const groupName = state?.groups.find((group) => group.id === owner.groupId)?.name || '未分组';
      const username = state?.user.role === 'admin' ? state.members.find((member) => member.id === owner.id)?.username : '';
      const label = [owner.name, groupName, roleLabel(owner), username ? `@${username}` : ''].filter(Boolean).join(' · ');
      return `<option value="${escapeHtml(owner.id)}"${owner.id === selectedId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
}

function syncInventoryOwnerAutocomplete(select: HTMLSelectElement, inputId: string, listId: string, hintSelector: string) {
  const field = select.closest<HTMLElement>('.field');
  if (!field) return;
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.closest<HTMLElement>('.m3-select')?.setAttribute('hidden', '');
  let input = $<HTMLInputElement>(`#${inputId}`, field);
  let datalist = $<HTMLDataListElement>(`#${listId}`);
  if (!input) {
    input = document.createElement('input');
    input.id = inputId;
    input.autocomplete = 'off';
    input.placeholder = '搜索姓名或身份';
    const label = $('label', field);
    if (label) label.htmlFor = input.id;
    field.append(input);
  }
  if (!datalist) {
    datalist = document.createElement('datalist');
    datalist.id = listId;
    field.append(datalist);
  }
  input.setAttribute('list', listId);
  input.required = select.required;
  datalist.innerHTML = [...select.options].map((option) => `<option value="${escapeHtml(option.textContent ?? '')}" data-owner-id="${escapeHtml(option.value)}"></option>`).join('');
  input.value = select.selectedOptions[0]?.textContent ?? '';
  const resolve = () => {
    const value = input!.value.trim().toLocaleLowerCase('zh-CN');
    const option = [...select.options].find((candidate) => candidate.textContent?.trim().toLocaleLowerCase('zh-CN') === value);
    if (!option) {
      input!.setCustomValidity(value ? '请从候选列表中选择成员' : '请选择自用成员');
      return;
    }
    input!.setCustomValidity('');
    select.value = option.value;
    refreshM3Select(select);
    input!.value = option.textContent ?? '';
  };
  if (input.dataset.ownerAutocomplete !== 'true') {
    input.dataset.ownerAutocomplete = 'true';
    input.addEventListener('input', () => input!.setCustomValidity(''));
    input.addEventListener('change', resolve);
    input.addEventListener('blur', resolve);
    enhanceM3Autocomplete(input);
  }
  let hint = $<HTMLElement>(hintSelector, field);
  if (!hint) {
    hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.toggleAttribute(hintSelector.slice(1, -1), true);
    field.append(hint);
  }
  if (hint) hint.textContent = state?.user.role === 'admin' ? '可搜索并选择启用成员；自用归属会写入流水快照。' : '当前身份只能选择自己。';
}

function inventoryStatusKind(status: InventoryStatus) {
  return status.terminal ? 'terminal' : status.usable ? 'usable' : 'pending';
}

function inventoryStatusKindLabel(status: InventoryStatus) {
  return status.terminal ? '终止不可用' : status.usable ? '可用' : '暂不可用';
}

function unitTypeLabel(unitType: InventoryUnit['unitType']) {
  return unitType === 'aggregate' ? '状态总库存' : unitType === 'container' ? '盒 / 容器' : unitType === 'lot' ? '批次' : '序列 / 单件';
}

function materialStockLabel(material: Material) {
  return material.trackingMode === 'quantity'
    ? `当前 ${formatNumber(material.quantity)} ${material.unit}`
    : `开放可用 ${formatNumber(material.availableQuantity)} / 总数 ${formatNumber(material.quantity)} ${material.unit}`;
}

function renderInventoryStatuses() {
  const list = $('[data-tracking-status-list]');
  const createForm = $<HTMLFormElement>('[data-status-create-form]');
  if (!list || !inventoryDetailData || !state) return;
  const manageable = canManageInventory(state.user);
  createForm?.toggleAttribute('hidden', !manageable);
  list.innerHTML = inventoryDetailData.statuses.map((status) => manageable
    ? `<div class="tracking-status-row" data-status-id="${escapeHtml(status.id)}"><div class="field"><label>状态名称</label><input aria-label="状态名称" maxlength="30" value="${escapeHtml(status.name)}" data-status-name /></div><div class="field"><label>状态语义</label><select aria-label="状态语义" data-status-kind><option value="usable"${inventoryStatusKind(status) === 'usable' ? ' selected' : ''}>可用</option><option value="pending"${inventoryStatusKind(status) === 'pending' ? ' selected' : ''}>暂不可用</option><option value="terminal"${inventoryStatusKind(status) === 'terminal' ? ' selected' : ''}>终止不可用</option></select></div><button class="icon-button" type="button" title="保存状态" aria-label="保存状态" data-save-inventory-status>${document.querySelector('[data-inventory-save-icon-template]')?.innerHTML ?? '保存'}</button></div>`
    : `<div class="tracking-status-row"><strong>${escapeHtml(status.name)}</strong>${statusChipMarkup(inventoryStatusKindLabel(status), status.usable ? 'ok' : 'low', status.terminal ? '终止不可用，需要处置或管理员维护' : status.usable ? '可登记使用' : '暂不可用，需要处理后才能使用')}<span>${formatNumber(status.quantity ?? 0)} ${escapeHtml(inventoryDetailData.material.unit)}</span></div>`).join('');
  $$<HTMLSelectElement>('[data-status-kind]', list).forEach((select) => {
    enhanceM3Select(select);
    refreshM3Select(select);
  });
}

function setInventoryOwnerFieldValue(selector: string, userId: string) {
  const select = $<HTMLSelectElement>(selector);
  if (!select) return;
  select.value = userId;
  refreshM3Select(select);
  const input = selector === '#unit-owner' ? $<HTMLInputElement>('#unit-owner-search') : $<HTMLInputElement>('#inventory-operation-owner-search');
  if (input) input.value = select.selectedOptions[0]?.textContent ?? '';
}

function renderInventoryUnits() {
  const list = $('[data-tracking-unit-list]');
  if (!list || !inventoryDetailData || !state) return;
  ensureInventoryAnomalyUi();
  const { material, summary } = inventoryDetailData;
  const unitLabel = escapeHtml(material.unit);
  const values: Array<[string, number]> = [
    ['[data-tracking-shared]', summary.sharedUsable],
    ['[data-tracking-reserved]', summary.reservedUsable],
    ['[data-tracking-unavailable]', summary.unavailable],
    ['[data-tracking-total]', summary.total],
  ];
  values.forEach(([selector, value]) => {
    const node = $(selector);
    if (node) node.textContent = `${formatNumber(value)} ${material.unit}`;
  });
  const anomalyPanel = $('[data-inventory-anomaly-panel]');
  const anomalyList = $('[data-inventory-anomaly-list]');
  if (anomalyPanel && anomalyList) {
    const showAnomalies = state.user.role === 'admin' && inventoryAnomalies.length > 0;
    anomalyPanel.hidden = !showAnomalies;
    anomalyList.innerHTML = showAnomalies ? inventoryAnomalies.map((anomaly) => {
      if (anomaly.type === 'capacity_exceeded') {
        return `<article class="inventory-anomaly-item"><div><strong>${escapeHtml(anomaly.inventoryUnitLabel)} · 超出容量</strong><p>当前 ${formatNumber(anomaly.totalQuantity)} ${escapeHtml(anomaly.materialUnit)}，容量 ${formatNumber(anomaly.capacity ?? 0)}。请核对实物和入库记录后，使用正常出库或更正流程处理。</p></div><div class="inventory-anomaly-actions"><span>仅提示，不自动改库存</span></div></article>`;
      }
      if (anomaly.type === 'material_quantity_mismatch') {
        return `<article class="inventory-anomaly-item"><div><strong>${escapeHtml(anomaly.materialName)} · 库存汇总不一致</strong><p>耗材总数为 ${formatNumber(anomaly.storedQuantity ?? 0)} ${escapeHtml(anomaly.materialUnit)}，明细汇总为 ${formatNumber(anomaly.totalQuantity)} ${escapeHtml(anomaly.materialUnit)}。请联系系统所有者核对数据库备份。</p></div><div class="inventory-anomaly-actions"><span>仅提示，不自动改库存</span></div></article>`;
      }
      const entryText = anomaly.entries.map((entry) => `${entry.displayCode} · ${entry.statusName} · ${entry.accessScope === 'user' ? `自用 · ${entry.ownerName}` : '开放使用'}`).join('；');
      const actionIcon = document.querySelector('[data-inventory-settings-icon-template]')?.innerHTML ?? '';
      const actions = anomaly.entries.map((entry, index) => entry.repairable
        ? `<button class="button tonal" type="button" data-inventory-anomaly-fix data-anomaly-id="${escapeHtml(anomaly.id)}" data-anomaly-entry="${index}">${actionIcon}<span>调整“${escapeHtml(inventoryAnomalyEntryLabel(entry))}”位置</span></button>`
        : '').filter(Boolean).join('');
      return `<article class="inventory-anomaly-item"><div><strong>${escapeHtml(anomaly.inventoryUnitLabel)} · ${escapeHtml(anomaly.positionCode)}</strong><p>${escapeHtml(entryText)}</p></div><div class="inventory-anomaly-actions">${actions || '<span>数量异常需人工核对</span>'}</div></article>`;
    }).join('') : '';
  }
  const createButton = $<HTMLButtonElement>('[data-show-unit-create]');
  if (createButton) createButton.hidden = material.trackingMode !== 'tracked' || !material.active;
  const entryHint = $<HTMLElement>('.tracking-entry-hint');
  if (entryHint) entryHint.hidden = material.trackingMode !== 'tracked';
  const query = $<HTMLInputElement>('[data-tracking-search]')?.value.trim().toLocaleLowerCase('zh-CN') ?? '';
  const queryTerms = query.split(/\s+/).filter(Boolean);
  const exactBalanceMatches = new Map(inventoryDetailData.units.map((unit) => [unit.id, unit.balances.filter((balance) => [balance.positionCode, balance.displayCode]
    .some((value) => value.toLocaleLowerCase('zh-CN') === query))]));
  const hasExactBalanceMatches = [...exactBalanceMatches.values()].some((balances) => balances.length > 0);
  const units = inventoryDetailData.units.map((unit) => {
    if (!queryTerms.length) return unit;
    if (hasExactBalanceMatches) return { ...unit, balances: exactBalanceMatches.get(unit.id) ?? [] };
    const unitHaystack = `${unit.displayLabel} ${unit.label} ${unit.positionCode} ${unit.note}`.toLocaleLowerCase('zh-CN');
    if (queryTerms.every((term) => unitHaystack.includes(term))) return unit;
    const balances = unit.balances.filter((balance) => {
      const balanceHaystack = `${unitHaystack} ${balance.displayCode} ${balance.positionCode} ${balance.statusName} ${balance.ownerName}`.toLocaleLowerCase('zh-CN');
      return queryTerms.every((term) => balanceHaystack.includes(term));
    });
    return { ...unit, balances };
  }).filter((unit) => !queryTerms.length || unit.balances.length > 0);
  if (!units.length) {
    list.innerHTML = `<p class="empty-note">${query ? '没有符合条件的库存明细' : material.trackingMode === 'tracked' ? '尚未建立批次 / 单件' : '当前没有状态库存'}</p>`;
    return;
  }
  const statusOrder = new Map(inventoryDetailData.statuses.map((status) => [status.id, {
    priority: status.code === 'new' ? 0 : status.usable ? 1 : status.terminal ? 3 : 2,
    order: status.sortOrder,
  }]));
  const renderBalanceScope = (balance: InventoryBalance) => balance.accessScope === 'shared'
    ? '<span class="tracking-scope-label">开放使用</span>'
    : `<span class="tracking-scope"><span class="tracking-scope-chip">自用</span><span class="tracking-scope-owner" title="${escapeHtml(balance.ownerName)}">· ${escapeHtml(balance.ownerName)}</span></span>`;
  const renderBalanceRows = (unit: InventoryUnit, balances: InventoryBalance[]) => balances.map((balance) => {
    const balanceKey = escapeHtml(`${balance.statusId}|${balance.accessScope}|${balance.ownerUserId}|${balance.positionCode}`);
    const canRegisterUse = balance.accessScope === 'shared' || balance.ownerUserId === state!.user.id;
    const canOperate = canManageInventory(state!.user) || canRegisterUse;
    const expiry = balance.expiry ?? unit.expiry;
    const expiryMarkup = expiry?.status && expiry.status !== 'none' ? `<small class="tracking-expiry ${expiry.status}">${escapeHtml(expiryDescription(expiry))}</small>` : '';
    if (!canOperate) {
      return `<tr><td>${escapeHtml(balance.displayCode)}${expiryMarkup}</td><td>${statusChipMarkup(balance.statusName, balance.usable ? 'ok' : 'low', balance.terminal ? '终止不可用，需要处置或管理员维护' : balance.usable ? '可登记使用' : '暂不可用，需要处理后才能使用')}</td><td>${renderBalanceScope(balance)}</td><td>${formatNumber(balance.quantity)} ${unitLabel}</td><td><span class="tracking-restricted-action">仅限自用人</span></td></tr>`;
    }
    const primaryAction = balance.expiry?.status === 'expired' || unit.expiry.status === 'expired'
      ? `<button class="button tonal tracking-use-button" type="button" title="登记退货、报废或危废移交" data-unit-balance-manage data-preferred-operation="dispose" data-unit-id="${escapeHtml(unit.id)}" data-balance-key="${balanceKey}"><span>登记处置</span></button>`
      : balance.usable
      ? canRegisterUse
        ? `<button class="button tonal tracking-use-button" type="button" data-unit-balance-use data-unit-id="${escapeHtml(unit.id)}" data-balance-key="${balanceKey}">${document.querySelector('[data-inventory-register-icon-template]')?.innerHTML ?? ''}<span>登记使用</span></button>`
        : ''
      : `<button class="button tonal tracking-use-button" type="button" data-unit-balance-manage data-unit-id="${escapeHtml(unit.id)}" data-balance-key="${balanceKey}"><span>处理</span></button>`;
    const manageAction = balance.usable
      ? `<button class="icon-button tracking-manage-button" type="button" title="更多库存操作" aria-label="更多库存操作" data-unit-balance-manage data-unit-id="${escapeHtml(unit.id)}" data-balance-key="${balanceKey}">${document.querySelector('[data-inventory-more-icon-template]')?.innerHTML ?? ''}</button>`
      : '';
    return `<tr><td>${escapeHtml(balance.displayCode)}${expiryMarkup}</td><td>${statusChipMarkup(balance.statusName, balance.usable ? 'ok' : 'low', balance.terminal ? '终止不可用，需要处置或管理员维护' : balance.usable ? '可登记使用' : '暂不可用，需要处理后才能使用')}</td><td>${renderBalanceScope(balance)}</td><td>${formatNumber(balance.quantity)} ${unitLabel}</td><td><span class="tracking-balance-actions">${primaryAction}${manageAction}</span></td></tr>`;
  }).join('');
  const renderBalanceTable = (unit: InventoryUnit, balances: InventoryBalance[]) => `<table class="tracking-balance-table"><thead><tr><th>编号 / 格位</th><th>状态</th><th>使用范围</th><th>数量</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${renderBalanceRows(unit, balances)}</tbody></table>`;
  list.innerHTML = units.map((unit) => {
    const capacity = unit.capacity > 0 ? ` / 容量 ${formatNumber(unit.capacity)}` : '';
    const expanded = material.trackingMode !== 'tracked' || queryTerms.length > 0 || expandedInventoryUnitIds.has(unit.id);
    const sortedBalances = [...unit.balances].sort((left, right) => {
      const leftOrder = statusOrder.get(left.statusId) ?? { priority: 9, order: 0 };
      const rightOrder = statusOrder.get(right.statusId) ?? { priority: 9, order: 0 };
      return leftOrder.priority - rightOrder.priority || leftOrder.order - rightOrder.order
        || left.displayCode.localeCompare(right.displayCode, 'zh-CN', { numeric: true });
    });
    const availableBalances = sortedBalances.filter((balance) => balance.usable);
    const unavailableBalances = sortedBalances.filter((balance) => !balance.usable);
    const availableQuantity = availableBalances.reduce((total, balance) => total + balance.quantity, 0);
    const unavailableQuantity = unavailableBalances.reduce((total, balance) => total + balance.quantity, 0);
    const availableSection = availableBalances.length
      ? `<div class="tracking-balance-section-heading"><span>可登记明细</span><span>${formatNumber(availableQuantity)} ${unitLabel}</span></div>${renderBalanceTable(unit, availableBalances)}`
      : queryTerms.length ? '' : '<p class="empty-note">当前没有可登记的库存明细</p>';
    const unavailableSection = unavailableBalances.length
      ? `<details class="tracking-unavailable"${queryTerms.length ? ' open' : ''}><summary><span>不可用明细</span><span>${formatNumber(unavailableQuantity)} ${unitLabel}</span></summary>${renderBalanceTable(unit, unavailableBalances)}</details>`
      : '';
    const balances = unit.balances.length ? `${availableSection}${unavailableSection}` : '<p class="empty-note">该库存单元当前为空</p>';
    const editAction = canManageInventory(state!.user) && unit.unitType !== 'aggregate'
      ? `<button class="icon-button" type="button" title="${unit.label === '历史库存（未分批）' ? '补录库存单元信息' : '编辑库存单元信息'}" aria-label="${unit.label === '历史库存（未分批）' ? '补录库存单元信息' : '编辑库存单元信息'}" data-unit-edit data-unit-id="${escapeHtml(unit.id)}">${document.querySelector('[data-inventory-edit-icon-template]')?.innerHTML ?? ''}</button>`
      : '';
    const archiveAction = canManageInventory(state!.user) && unit.unitType !== 'aggregate'
      ? `<button class="icon-button" type="button" title="${unit.active ? '归档库存单元' : '恢复库存单元'}" aria-label="${unit.active ? '归档库存单元' : '恢复库存单元'}" data-unit-status="${unit.active ? 'archived' : 'active'}" data-unit-id="${escapeHtml(unit.id)}">${document.querySelector(unit.active ? '[data-inventory-archive-icon-template]' : '[data-inventory-restore-icon-template]')?.innerHTML ?? ''}</button>`
      : '';
    const expiryMarkup = unit.expiry.status !== 'none' ? `<span class="tracking-unit-expiry ${unit.expiry.status}">${escapeHtml(expiryDescription(unit.expiry))}</span>` : '';
    const inboundAllowed = unit.active && material.active && unit.expiry.status !== 'expired';
    const inboundTitle = unit.expiry.status === 'expired' ? '已过期批次不能入库' : '入库库存单元';
    return `<section class="tracking-unit${unit.active ? '' : ' archived'}${expanded ? ' expanded' : ''}"><div class="tracking-unit-header"><button class="tracking-unit-toggle" type="button" aria-expanded="${expanded}" data-unit-toggle data-unit-id="${escapeHtml(unit.id)}"><span class="tracking-unit-chevron" aria-hidden="true">${document.querySelector('[data-transaction-next-icon-template]')?.innerHTML ?? ''}</span><span class="tracking-unit-copy"><strong>${escapeHtml(unit.displayLabel)}</strong><small>${unitTypeLabel(unit.unitType)} · ${formatNumber(unit.quantity)} ${unitLabel}${capacity}${unit.note ? ` · ${escapeHtml(unit.note)}` : ''}${unit.active ? '' : ' · 已归档'}</small>${expiryMarkup}</span></button><div class="tracking-unit-actions"><button class="button tonal" type="button" title="${inboundTitle}" data-unit-in data-unit-id="${escapeHtml(unit.id)}"${inboundAllowed ? '' : ' disabled'}>${document.querySelector('[data-inventory-in-icon-template]')?.innerHTML ?? ''}<span>入库</span></button>${unit.unitType === 'aggregate' ? '' : `<button class="icon-button" type="button" title="查看库存单元二维码" aria-label="查看库存单元二维码" data-unit-qr data-unit-id="${escapeHtml(unit.id)}">${document.querySelector('[data-inventory-qr-icon-template]')?.innerHTML ?? ''}</button>`}${editAction}${archiveAction}</div></div><div class="tracking-unit-details"${expanded ? '' : ' hidden'}>${balances}</div></section>`;
  }).join('');
}

function ensureInventoryAnomalyUi() {
  const trackingPanel = $('[data-tracking-panel="units"]');
  if (!trackingPanel) return;
  let panel = $('[data-inventory-anomaly-panel]', trackingPanel);
  if (!panel) {
    panel = document.createElement('section');
    panel.className = 'inventory-anomaly-panel';
    panel.setAttribute('data-inventory-anomaly-panel', '');
    panel.hidden = true;
    panel.innerHTML = '<div class="inventory-anomaly-heading"><div><strong>发现库存数据异常</strong><p>系统已检查重复位置、位置数量、容量及库存汇总。可安全自动处理的异常会显示修复操作，历史记录不会被删除。</p></div></div><div class="inventory-anomaly-list" data-inventory-anomaly-list></div>';
    trackingPanel.insertBefore(panel, $('.tracking-toolbar', trackingPanel));
  }
  if (!$('[data-modal="inventory-anomaly-fix"]')) {
    const closeIcon = document.querySelector('[data-close-icon-template]')?.innerHTML ?? '关闭';
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop" data-modal="inventory-anomaly-fix"><section class="modal correction-modal" role="dialog" aria-modal="true" aria-labelledby="anomaly-fix-title"><div class="modal-header"><div><h2 id="anomaly-fix-title">修复库存位置异常</h2><p>只调整当前库存位置，不删除历史记录</p></div><button class="icon-button" type="button" data-close-modal title="关闭" aria-label="关闭">${closeIcon}</button></div><div class="modal-body"><div class="correction-summary" data-anomaly-fix-summary></div><form data-inventory-anomaly-fix-form><div class="form-grid"><div class="field"><label for="anomaly-fix-from">异常位置</label><input id="anomaly-fix-from" readonly /></div><div class="field"><label for="anomaly-fix-to">新的位置 <span aria-hidden="true">*</span></label><input id="anomaly-fix-to" maxlength="40" required placeholder="例如：2-3" /></div><div class="field full"><label for="anomaly-fix-reason">修复原因 <span aria-hidden="true">*</span></label><textarea id="anomaly-fix-reason" maxlength="300" required placeholder="例如：旧表重复录入，核对实物后调整格位"></textarea></div></div><div class="modal-footer"><button class="button" type="button" data-close-modal>取消</button><button class="button primary" type="submit">确认修复</button></div></form></div></section></div>`);
    $$<HTMLButtonElement>('[data-modal="inventory-anomaly-fix"] [data-close-modal]').forEach((button) => button.addEventListener('click', closeInventoryAnomalyFix));
    $<HTMLFormElement>('[data-inventory-anomaly-fix-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const target = inventoryAnomalyTarget;
      if (!target || !inventoryDetailTargetId) return;
      const submit = $<HTMLButtonElement>('button[type="submit"]', event.currentTarget);
      if (submit) submit.disabled = true;
      try {
        await api('/api/inventory-anomalies/position/resolve', {
          method: 'POST',
          body: inventoryAnomalyResolutionBody(
            target,
            $<HTMLInputElement>('#anomaly-fix-to')?.value,
            $<HTMLTextAreaElement>('#anomaly-fix-reason')?.value,
          ),
        });
        closeInventoryAnomalyFix();
        await reloadInventoryDetail();
        toast('库存位置异常已修复，已记录审计事件');
      } catch (failure) {
        toast((failure as Error).message);
      } finally {
        if (submit) submit.disabled = false;
      }
    });
  }
}

function closeInventoryAnomalyFix() {
  hideModal($('[data-modal="inventory-anomaly-fix"]'));
  inventoryAnomalyTarget = null;
  document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
  const returnFocus = modalReturnFocus;
  modalReturnFocus = null;
  requestAnimationFrame(() => {
    if (returnFocus?.isConnected) returnFocus.focus();
  });
}

function eventTypeLabel(event: InventoryEvent) {
  return event.eventType === 'use' ? '使用登记'
    : event.eventType === 'use_correction' ? '使用更正'
      : event.eventType === 'state_change' ? '状态变更'
    : event.eventType === 'access_change' ? '使用范围变更'
      : event.eventType === 'transfer' ? '位置调整'
        : event.eventType === 'dispose' ? '处置'
          : '库存调整';
}

function eventChangeLabel(event: InventoryEvent) {
  const fromScope = event.fromAccessScope === 'user' ? `自用 · ${event.fromOwnerName}` : event.fromAccessScope === 'shared' ? '开放使用' : '';
  const toScope = event.toAccessScope === 'user' ? `自用 · ${event.toOwnerName}` : event.toAccessScope === 'shared' ? '开放使用' : '';
  const from = [event.fromStatusName, fromScope, event.fromPositionCode].filter(Boolean).join(' / ');
  const to = [event.toStatusName, toScope, event.toPositionCode].filter(Boolean).join(' / ');
  if (event.eventType === 'use_correction') return '冲销原使用登记';
  if (event.eventType === 'use' && from === to) return from || '当前库存明细';
  return to ? `${from || '-'} → ${to}` : from || '-';
}

async function loadInventoryEvents() {
  const list = $('[data-tracking-event-list]');
  const meta = $('[data-tracking-event-meta]');
  if (!list || !inventoryDetailTargetId || inventoryEventsLoaded) return;
  list.innerHTML = '<p class="empty-note">正在读取操作记录</p>';
  if (meta) meta.textContent = '正在读取操作记录';
  try {
    const result = await api<{ events: InventoryEvent[]; total: number }>(`/api/inventory-events?materialId=${encodeURIComponent(inventoryDetailTargetId)}&limit=500`);
    inventoryEventsLoaded = true;
    if (meta) meta.textContent = result.total > result.events.length
      ? `共 ${result.total} 条，当前显示最近 ${result.events.length} 条`
      : `共 ${result.total} 条`;
    list.innerHTML = result.events.length ? result.events.map((event) => `<article class="tracking-event"><span>${formatTime(event.occurredAt)}</span><div><strong>${eventTypeLabel(event)}</strong><p>${escapeHtml(event.inventoryUnitLabel)}</p></div><div><strong>${escapeHtml(eventChangeLabel(event))}</strong><p>${escapeHtml(event.counterparty || event.note || '-')}</p></div><small>${escapeHtml(event.userName)} · ${formatNumber(event.quantity)} ${escapeHtml(inventoryDetailData?.material.unit ?? '')}</small></article>`).join('') : '<p class="empty-note">暂无使用、状态或处置记录</p>';
  } catch (failure) {
    if (meta) meta.textContent = '操作记录读取失败';
    list.innerHTML = `<p class="empty-note">${escapeHtml((failure as Error).message)}</p>`;
  }
}

function selectTrackingTab(name: 'units' | 'statuses' | 'events') {
  $$<HTMLButtonElement>('[data-tracking-tab]').forEach((button) => {
    const active = button.dataset.trackingTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$<HTMLElement>('[data-tracking-panel]').forEach((panel) => { panel.hidden = panel.dataset.trackingPanel !== name; });
  if (name === 'events') void loadInventoryEvents();
}

function syncInventoryDetailFormOptions() {
  if (!inventoryDetailData || !state) return;
  const statusOptions = inventoryDetailData.statuses
    .filter((status) => status.active && (canManageInventory(state!.user) || !status.terminal))
    .map((status) => `<option value="${escapeHtml(status.id)}">${escapeHtml(status.name)}</option>`).join('');
  const unitStatus = $<HTMLSelectElement>('#unit-status');
  const operationStatus = $<HTMLSelectElement>('#inventory-operation-status');
  if (unitStatus) {
    unitStatus.innerHTML = statusOptions;
    refreshM3Select(unitStatus);
  }
  if (operationStatus) {
    operationStatus.innerHTML = inventoryDetailData.statuses.filter((status) => status.active).map((status) => `<option value="${escapeHtml(status.id)}">${escapeHtml(status.name)}</option>`).join('');
    refreshM3Select(operationStatus);
  }
  const ownerOptions = inventoryOwnerOptions(state.user.id);
  const unitOwner = $<HTMLSelectElement>('#unit-owner');
  const operationOwner = $<HTMLSelectElement>('#inventory-operation-owner');
  if (unitOwner) {
    unitOwner.innerHTML = ownerOptions;
    refreshM3Select(unitOwner);
    syncInventoryOwnerAutocomplete(unitOwner, 'unit-owner-search', 'inventory-owner-options', '[data-unit-owner-hint]');
  }
  if (operationOwner) {
    operationOwner.innerHTML = ownerOptions;
    refreshM3Select(operationOwner);
    syncInventoryOwnerAutocomplete(operationOwner, 'inventory-operation-owner-search', 'inventory-operation-owner-options', '[data-operation-owner-hint]');
  }
}

async function reloadInventoryDetail() {
  if (!inventoryDetailTargetId) return;
  inventoryDetailData = await api<InventoryDetailResponse>(`/api/inventory-units?materialId=${encodeURIComponent(inventoryDetailTargetId)}`);
  await loadInventoryAnomalies();
  syncInventoryDetailFormOptions();
  renderInventoryUnits();
  renderInventoryStatuses();
}

async function loadInventoryAnomalies() {
  inventoryAnomalies = [];
  if (!state || state.user.role !== 'admin' || !inventoryDetailTargetId) return;
  try {
    const result = await api<{ anomalies: InventoryAnomaly[] }>(`/api/inventory-anomalies?materialId=${encodeURIComponent(inventoryDetailTargetId)}`);
    inventoryAnomalies = result.anomalies;
  } catch (failure) {
    if ((failure as Error).message) console.warn('库存异常读取失败', failure);
  }
}

async function openInventoryDetail(materialId = '', unitId = '') {
  const material = materialId ? state?.materials.find((candidate) => candidate.id === materialId) : null;
  if (material?.trackingMode === 'quantity') {
    openTransactionForMaterial(material, 'out');
    return;
  }
  const list = $('[data-tracking-unit-list]');
  if (list) list.innerHTML = '<p class="empty-note">正在读取库存明细</p>';
  inventoryDetailData = null;
  inventoryEventsLoaded = false;
  expandedInventoryUnitIds.clear();
  if (unitId) expandedInventoryUnitIds.add(unitId);
  const search = $<HTMLInputElement>('[data-tracking-search]');
  if (search) search.value = '';
  $<HTMLFormElement>('[data-unit-create-form]')?.toggleAttribute('hidden', true);
  openModal(inventoryDetailModal);
  try {
    const query = unitId ? `unitId=${encodeURIComponent(unitId)}` : `materialId=${encodeURIComponent(materialId)}`;
    inventoryDetailData = await api<InventoryDetailResponse>(`/api/inventory-units?${query}`);
    inventoryDetailTargetId = inventoryDetailData.material.id;
    await loadInventoryAnomalies();
    const title = $('[data-inventory-detail-title]');
    const subtitle = $('[data-inventory-detail-subtitle]');
    if (title) title.textContent = inventoryDetailData.material.name;
    if (subtitle) subtitle.textContent = inventoryDetailData.material.trackingMode === 'tracked' ? '批次 / 单件、状态与使用范围' : '状态与使用范围';
    const expiryHint = $<HTMLElement>('#unit-expiry-date')?.closest<HTMLElement>('.field')?.querySelector<HTMLElement>('.field-hint');
    if (expiryHint) expiryHint.textContent = `填写后按该耗材设置的提前 ${inventoryDetailData.material.expiryWarningDays ?? 30} 天提醒；未填写则不会提醒。`;
    syncInventoryDetailFormOptions();
    renderInventoryUnits();
    renderInventoryStatuses();
    selectTrackingTab('units');
    if (unitId && inventoryDetailData.units[0] && !inventoryDetailData.units[0].active) toast('该库存单元已归档，只能查看历史信息');
  } catch (failure) {
    if (inventoryDetailStocktakeReturn) await closeInventoryDetail();
    else closeModals();
    toast((failure as Error).message);
  }
}

async function closeInventoryDetail() {
  const stocktakeReturn = inventoryDetailStocktakeReturn;
  inventoryDetailStocktakeReturn = null;
  hideModal(inventoryDetailModal);
  inventoryDetailData = null;
  inventoryDetailTargetId = '';
  if (!stocktakeReturn) {
    document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
    if (!$('.modal-backdrop.open')) unlockModalPage();
    if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
    modalReturnFocus = null;
    return;
  }

  await openStocktakeDetail(stocktakeReturn.stocktakeId);
  document.body.classList.add('modal-open');
  if (stocktakeReturn.reopenCount) {
    const item = stocktakeDetail?.items.find((candidate) => candidate.id === stocktakeReturn.countItemId);
    if (item && stocktakeDetail?.status === 'open') {
      stocktakeCountTarget = item;
      const current = $('[data-stocktake-count-current]');
      if (current) current.textContent = item.currentQuantity === null ? '不可用' : `${formatNumber(item.currentQuantity)} ${item.materialUnit}`;
      bringModalToFront(stocktakeCountModal);
      syncStocktakeCountDifference();
    }
  }
  requestAnimationFrame(() => {
    if (stocktakeReturn.returnFocus?.isConnected) stocktakeReturn.returnFocus.focus();
    else stocktakeModal?.querySelector<HTMLElement>(`[data-stocktake-open-unit="${CSS.escape(stocktakeReturn.unitId)}"]`)?.focus();
  });
  modalReturnFocus = null;
}

function openStocktakeInventoryDetail(unitId: string, reopenCount: boolean) {
  if (!stocktakeDetail) return;
  inventoryDetailStocktakeReturn = {
    stocktakeId: stocktakeDetail.id,
    unitId,
    countItemId: reopenCount ? stocktakeCountTarget?.id ?? '' : '',
    reopenCount,
    returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  };
  if (reopenCount) hideModal(stocktakeCountModal);
  void openInventoryDetail('', unitId);
}

function openInventoryAnomalyFix(anomaly: InventoryAnomaly, entry: InventoryAnomalyEntry | undefined) {
  if (!entry) return toast('该异常数量不是单件，暂不能自动调整；请先联系系统所有者处理');
  inventoryAnomalyTarget = { anomaly, entry };
  const summary = $('[data-anomaly-fix-summary]');
  if (summary) summary.innerHTML = `<strong>${escapeHtml(anomaly.inventoryUnitLabel)} · ${escapeHtml(anomaly.positionCode)}</strong><span>${escapeHtml(anomaly.entries.map((item) => `${item.statusName} · ${item.accessScope === 'user' ? `自用 · ${item.ownerName}` : '开放使用'} · ${formatNumber(item.quantity)} ${anomaly.materialUnit}`).join('；'))}</span>`;
  const from = $<HTMLInputElement>('#anomaly-fix-from');
  const to = $<HTMLInputElement>('#anomaly-fix-to');
  if (from) from.value = entry.positionCode;
  if (to) to.value = '';
  const reason = $<HTMLTextAreaElement>('#anomaly-fix-reason');
  if (reason) reason.value = '';
  openModal($('[data-modal="inventory-anomaly-fix"]'));
  requestAnimationFrame(() => to?.focus());
}

function inventoryBalanceByKey(unit: InventoryUnit, key: string) {
  return unit.balances.find((balance) => `${balance.statusId}|${balance.accessScope}|${balance.ownerUserId}|${balance.positionCode}` === key) ?? null;
}

function openInventoryUnitEdit(unit: InventoryUnit) {
  if (!state || !inventoryDetailData || !canManageInventory(state.user) || unit.unitType === 'aggregate') return;
  inventoryUnitEditTarget = unit;
  const label = $<HTMLInputElement>('#edit-inventory-unit-label');
  const capacity = $<HTMLInputElement>('#edit-inventory-unit-capacity');
  const expiryDate = $<HTMLInputElement>('#edit-inventory-unit-expiry-date');
  const note = $<HTMLTextAreaElement>('#edit-inventory-unit-note');
  if (label) label.value = unit.label;
  if (capacity) capacity.value = String(unit.capacity);
  if (expiryDate) expiryDate.value = unit.expiryDate || '';
  if (note) note.value = unit.note || '';
  const title = $('[data-inventory-unit-edit-title]');
  const subtitle = $('[data-inventory-unit-edit-subtitle]');
  const isHistory = unit.label === '历史库存（未分批）';
  if (title) title.textContent = isHistory ? '补录历史库存信息' : '编辑库存单元信息';
  if (subtitle) subtitle.textContent = isHistory ? '完善批次资料，不改变当前数量或历史流水' : '只维护库存单元资料，不改变当前数量或历史流水';
  openModal(inventoryUnitEditModal);
}

function closeInventoryUnitEdit() {
  hideModal(inventoryUnitEditModal);
  inventoryUnitEditTarget = null;
  document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
  if (!$('.modal-backdrop.open')) unlockModalPage();
  requestAnimationFrame(() => inventoryDetailModal?.querySelector<HTMLElement>('[data-unit-edit]')?.focus());
}

function firstUseTargetStatus(statuses: InventoryStatus[], sourceStatusId = '') {
  const source = statuses.find((status) => status.id === sourceStatusId);
  if (source?.code !== 'new') return null;
  return statuses.find((status) => status.code === 'active' && status.active && status.usable && !status.terminal)
    ?? statuses.find((status) => status.id !== source.id && status.active && status.usable && !status.terminal)
    ?? null;
}

function closeInventoryOperation() {
  hideModal(inventoryOperationModal);
  document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
  const returnFocus = inventoryOperationReturnFocus;
  inventoryOperationReturnFocus = null;
  requestAnimationFrame(() => (returnFocus?.isConnected ? returnFocus : inventoryDetailModal?.querySelector<HTMLElement>('[data-unit-balance-use], [data-unit-balance-manage], [data-unit-in]'))?.focus());
}

function closeMaterialQr() {
  const returnUnitId = qrInventoryUnitTarget?.id ?? '';
  hideModal(materialQrModal);
  qrInventoryUnitTarget = null;
  if (returnUnitId && inventoryDetailData) {
    bringModalToFront(inventoryDetailModal);
    document.body.classList.add('modal-open');
    requestAnimationFrame(() => inventoryDetailModal?.querySelector<HTMLElement>(`[data-unit-qr][data-unit-id="${CSS.escape(returnUnitId)}"]`)?.focus());
    return;
  }
  document.body.classList.remove('modal-open');
  unlockModalPage();
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function syncInventoryOperationForm() {
  const operation = $<HTMLSelectElement>('#inventory-operation-type')?.value ?? 'use';
  const access = $<HTMLSelectElement>('#inventory-operation-access')?.value ?? 'shared';
  const inbound = operation === 'in';
  const assignsContainerPosition = inventoryOperationUnit?.unitType === 'container' && !inventoryOperationBalance?.positionCode
    && ['use', 'state_change', 'access_change', 'position_change'].includes(operation);
  const editsPosition = inbound || operation === 'position_change' || assignsContainerPosition;
  $('[data-operation-status-field]')?.toggleAttribute('hidden', !inbound && operation !== 'state_change');
  $('[data-operation-access-field]')?.toggleAttribute('hidden', !inbound && operation !== 'access_change');
  $('[data-operation-owner-field]')?.toggleAttribute('hidden', !(access === 'user' && (inbound || operation === 'access_change')));
  $('[data-operation-position-field]')?.toggleAttribute('hidden', !editsPosition);
  $('[data-operation-context-field]')?.toggleAttribute('hidden', !['in', 'use', 'out', 'dispose'].includes(operation));
  const quantity = $<HTMLInputElement>('#inventory-operation-quantity');
  const status = $<HTMLSelectElement>('#inventory-operation-status');
  if (status) status.required = inbound || operation === 'state_change';
  const accessSelect = $<HTMLSelectElement>('#inventory-operation-access');
  if (accessSelect) accessSelect.required = inbound || operation === 'access_change';
  const positioned = Boolean(inventoryOperationBalance?.positionCode);
  if (quantity) {
    quantity.disabled = positioned || assignsContainerPosition;
    if (positioned && inventoryOperationBalance) quantity.value = String(inventoryOperationBalance.quantity);
    else if (assignsContainerPosition) quantity.value = '1';
  }
  const position = $<HTMLInputElement>('#inventory-operation-position');
  if (position) position.required = assignsContainerPosition;
  const positionLabel = $('[data-operation-position-label]');
  if (positionLabel) positionLabel.textContent = inbound || assignsContainerPosition ? '格位 / 单件编号' : '新格位编号';
  const positionHint = $('[data-operation-position-hint]');
  if (positionHint) positionHint.textContent = assignsContainerPosition
    ? (inventoryDetailData?.material.positionCodeHelp || '例如：2-2 表示第二行第二个；保存后该单件会以完整编号显示')
    : operation === 'position_change'
      ? (inventoryDetailData?.material.positionCodeHelp || '仅在需要移动当前库存明细时修改')
      : (inventoryDetailData?.material.positionCodeHelp || '');
  const ownerSearch = $<HTMLInputElement>('#inventory-operation-owner-search');
  if (ownerSearch) ownerSearch.required = access === 'user' && (inbound || operation === 'access_change');
  const counterpartyLabel = $('[data-operation-counterparty-label]');
  if (counterpartyLabel) counterpartyLabel.textContent = inbound ? '来源（供应商）' : operation === 'use' ? '用途 / 实验项目' : operation === 'dispose' ? '处置去向' : '领出去向';
  const contextHint = $('[data-operation-context-hint]');
  if (contextHint) contextHint.textContent = operation === 'use' ? (inventoryDetailData?.material.usageContextHelp || '可填写项目名称、实验批次或样品编号') : '';
  const subtitle = $('[data-inventory-operation-subtitle]');
  const firstUseStatus = firstUseTargetStatus(inventoryDetailData?.statuses ?? [], inventoryOperationBalance?.statusId);
  if (subtitle) subtitle.textContent = operation === 'use'
    ? (assignsContainerPosition
      ? `先为本次使用的单件填写格位 / 单件编号${firstUseStatus ? `，保存后自动更新为“${firstUseStatus.name}”` : ''}`
      : firstUseStatus ? `首次使用后自动更新为“${firstUseStatus.name}”，库存数量不变` : '记录本次使用，当前状态和库存数量不变')
    : operation === 'out' ? '物品离开当前库存后数量减少' : operation === 'dispose' ? '登记退货、报废或危废移交，数量从当前库存移除' : assignsContainerPosition ? '先定位具体单件，再保存本次变更' : '维护当前状态、使用范围或格位';
}

function openInventoryOperation(unit: InventoryUnit, balance: InventoryBalance | null, preferredOperation: string = '') {
  if (!inventoryDetailData || !state) return;
  inventoryOperationUnit = unit;
  inventoryOperationBalance = balance;
  inventoryOperationReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $<HTMLFormElement>('[data-inventory-operation-form]')?.reset();
  syncInventoryDetailFormOptions();
  const operation = $<HTMLSelectElement>('#inventory-operation-type');
  if (operation) {
    const selectedOperation = preferredOperation || (balance?.terminal ? 'dispose' : balance ? 'state_change' : 'in');
    operation.innerHTML = selectedOperation === 'use'
      ? '<option value="use">登记使用</option>'
      : selectedOperation === 'in'
        ? '<option value="in">入库</option>'
        : '<option value="state_change">变更状态</option><option value="access_change">变更使用范围</option><option value="position_change">调整位置</option><option value="out">领出库存（数量减少）</option><option value="dispose">处置</option>';
    operation.value = selectedOperation;
    refreshM3Select(operation);
  }
  $('[data-operation-type-field]')?.toggleAttribute('hidden', (operation?.options.length ?? 0) <= 1);
  const title = $('[data-inventory-operation-title]');
  if (title) title.textContent = preferredOperation === 'use' ? '登记使用' : preferredOperation === 'in' ? '入库库存明细' : preferredOperation === 'dispose' ? '登记处置' : '维护库存明细';
  const submitLabel = $('[data-inventory-operation-submit-label]');
  if (submitLabel) submitLabel.textContent = preferredOperation === 'use' ? '保存使用登记' : preferredOperation === 'in' ? '确认入库' : preferredOperation === 'dispose' ? '确认处置' : '保存变更';
  const quantity = $<HTMLInputElement>('#inventory-operation-quantity');
  if (quantity) quantity.value = String(balance ? Math.min(1, balance.quantity) : 1);
  const status = $<HTMLSelectElement>('#inventory-operation-status');
  if (status) {
    const sourceStatus = inventoryDetailData.statuses.find((candidate) => candidate.id === balance?.statusId);
    const target = sourceStatus?.code === 'new'
      ? firstUseTargetStatus(inventoryDetailData.statuses, sourceStatus.id)
      : sourceStatus?.usable
        ? inventoryDetailData.statuses.find((candidate) => candidate.id !== sourceStatus.id && candidate.active && !candidate.usable)
          ?? inventoryDetailData.statuses.find((candidate) => candidate.id !== sourceStatus.id && candidate.active)
        : inventoryDetailData.statuses.find((candidate) => candidate.id !== sourceStatus?.id && candidate.active && candidate.usable && !candidate.terminal)
          ?? inventoryDetailData.statuses.find((candidate) => candidate.id !== sourceStatus?.id && candidate.active);
    status.value = target?.id ?? balance?.statusId ?? inventoryDetailData.statuses[0]?.id ?? '';
    refreshM3Select(status);
  }
  const access = $<HTMLSelectElement>('#inventory-operation-access');
  if (access) {
    access.value = balance?.accessScope ?? 'shared';
    refreshM3Select(access);
  }
  const owner = $<HTMLSelectElement>('#inventory-operation-owner');
  if (owner) {
    setInventoryOwnerFieldValue('#inventory-operation-owner', balance?.ownerUserId || state.user.id);
  }
  const position = $<HTMLInputElement>('#inventory-operation-position');
  if (position) position.value = balance?.positionCode ?? '';
  const date = $<HTMLInputElement>('#inventory-operation-date');
  if (date) date.value = localDateTimeValue();
  const source = $('[data-operation-source]');
  if (source) source.innerHTML = balance
    ? `<strong>${escapeHtml(balance.displayCode)}</strong><span>${escapeHtml(balance.statusName)} · ${balance.accessScope === 'shared' ? '开放使用' : `自用 · ${escapeHtml(balance.ownerName)}`} · ${formatNumber(balance.quantity)} ${escapeHtml(inventoryDetailData.material.unit)}${unit.expiry.status !== 'none' ? ` · ${escapeHtml(expiryDescription(unit.expiry))}` : ''}</span>`
    : `<strong>${escapeHtml(unit.displayLabel)}</strong><span>${unitTypeLabel(unit.unitType)} · 当前 ${formatNumber(unit.quantity)} ${escapeHtml(inventoryDetailData.material.unit)}${unit.expiry.status !== 'none' ? ` · ${escapeHtml(expiryDescription(unit.expiry))}` : ''}</span>`;
  syncInventoryOperationForm();
  openModal(inventoryOperationModal);
}

async function openInventoryUnitQr(unit: InventoryUnit) {
  const material = state?.materials.find((candidate) => candidate.id === unit.materialId);
  if (!material) return;
  qrInventoryUnitTarget = unit;
  qrMaterialTargetId = material.id;
  qrMaterialDataUrl = '';
  materialLabelPreviewDataUrl = '';
  materialLabelPreviewSignature = '';
  materialLabelPreviewGeneration += 1;
  const title = $('[data-material-qr-title]') ?? $('#material-qr-title');
  const subtitle = $('[data-material-qr-subtitle]') ?? $('#material-qr-title')?.nextElementSibling;
  if (title) title.textContent = `${material.name} · ${unit.displayLabel}`;
  if (subtitle) subtitle.textContent = '此二维码定位到具体库存单元，扫码后仍需确认登记内容';
  $$<HTMLButtonElement>('[data-print-material-qr], [data-download-material-qr], [data-download-material-label]').forEach((button) => { button.disabled = true; });
  const image = $<HTMLImageElement>('[data-material-label-preview-image]');
  const loading = $('[data-material-label-preview-loading]');
  if (image) { image.hidden = true; image.removeAttribute('src'); }
  if (loading) { loading.textContent = '正在生成二维码'; loading.removeAttribute('hidden'); }
  syncMaterialLabelControls(false);
  const returnFocus = modalReturnFocus;
  hideModal(inventoryDetailModal);
  openModal(materialQrModal);
  modalReturnFocus = returnFocus;
  try {
    const qr = await loadQrCode();
    qrMaterialDataUrl = await qr.toDataURL(createInventoryUnitQrPayload(unit.id, window.location.href), { errorCorrectionLevel: 'M', margin: 3, width: 640, color: { dark: '#10251f', light: '#ffffff' } });
    syncMaterialLabelControls(true);
    await renderMaterialLabelPreview();
  } catch {
    if (loading) loading.textContent = '二维码生成失败，请关闭后重试';
  }
}

function materialFromInput() {
  const value = $<HTMLInputElement>('#material-name')?.value.trim().toLowerCase();
  return value ? state?.materials.find((material) => material.active && material.name.trim().toLowerCase() === value) : undefined;
}

function newMaterialTrackingMode() {
  const select = $<HTMLSelectElement>('#material-tracking-mode');
  return (select?.value ?? 'quantity') as TrackingMode;
}

function syncNewMaterialTrackingMode(mode: TrackingMode, isNewInbound: boolean) {
  const select = $<HTMLSelectElement>('#material-tracking-mode');
  const labels: Record<string, string> = { quantity: '普通数量', stateful: '按状态统计', tracked: '按批次 / 盒 / 单件管理' };
  [...(select?.options ?? [])].forEach((option) => { if (labels[option.value]) option.textContent = labels[option.value]; });
  const hint = $('[data-new-material-tracking-hint]');
  if (hint) hint.textContent = mode === 'quantity'
    ? '普通数量可直接填写数量；入库后可在管理耗材中切换为按状态或按批次 / 单件管理。'
    : mode === 'tracked'
      ? '保存耗材档案后进入库存明细，下一步建立批次、盒 / 容器或序列 / 单件并完成首次入库。'
      : '保存耗材档案后进入库存明细，下一步选择状态并完成首次入库。';
  if (select) select.required = isNewInbound;
}

function updateMaterialSelection() {
  const material = materialFromInput();
  const materialName = $<HTMLInputElement>('#material-name')?.value.trim() ?? '';
  const unit = $<HTMLInputElement>('#material-unit');
  const hint = $('[data-material-hint]');
  const newFields = $<HTMLElement>('[data-new-material-fields]');
  const type = currentTransactionType();
  const unavailableMaterial = materialName ? state?.materials.find((candidate) => !candidate.active && candidate.name.trim().toLowerCase() === materialName.toLowerCase()) : undefined;
  const hasMatchingMaterial = Boolean(materialName && !material && state?.materials.some((candidate) => candidate.name.toLowerCase().includes(materialName.toLowerCase())));
  const isNewInbound = Boolean(materialName && !material && !unavailableMaterial && !hasMatchingMaterial && type === 'in');
  const selectedNewTrackingMode = newMaterialTrackingMode();
  if (material && unit) {
    unit.value = material.unit;
  }
  if (unit) unit.readOnly = Boolean(material);
  if (newFields) newFields.hidden = !isNewInbound;
  syncNewMaterialTrackingMode(selectedNewTrackingMode, isNewInbound);
  const routesToInventoryDetail = Boolean(material && material.trackingMode !== 'quantity') || Boolean(isNewInbound && selectedNewTrackingMode !== 'quantity');
  $$<HTMLElement>('[data-transaction-direct-field]').forEach((field) => {
    field.hidden = routesToInventoryDetail;
    $$<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea', field).forEach((control) => {
      control.disabled = routesToInventoryDetail;
    });
  });
  const submitLabel = $('[data-transaction-submit-label]');
  if (submitLabel) submitLabel.textContent = routesToInventoryDetail ? '下一步：库存明细' : '保存记录';
  const submitIcon = $('[data-transaction-submit-icon]');
  const submitIconTemplate = document.querySelector(routesToInventoryDetail ? '[data-transaction-next-icon-template]' : '[data-transaction-save-icon-template]');
  if (submitIcon && submitIconTemplate) submitIcon.innerHTML = submitIconTemplate.innerHTML;
  const transactionSubtitle = $('[data-transaction-subtitle]');
  if (transactionSubtitle && routesToInventoryDetail) {
    const trackingMode = material?.trackingMode ?? selectedNewTrackingMode;
    transactionSubtitle.textContent = trackingMode === 'tracked'
      ? '下一步建立批次、盒 / 容器或序列 / 单件，再完成首次入库'
      : '下一步选择状态明细并完成首次入库';
  }
  if (hint) {
    if (material) hint.textContent = material.trackingMode === 'quantity'
      ? `当前库存 ${formatNumber(material.quantity)} ${material.unit}${material.safetyStock > 0 ? ` · 安全库存 ${formatNumber(material.safetyStock)} ${material.unit}` : ''}`
      : `开放可用 ${formatNumber(material.availableQuantity)} ${material.unit} · 请在库存明细中选择状态、使用范围和批次 / 盒 / 单件`;
    else if (unavailableMaterial) hint.textContent = '该耗材已归档，请联系管理员恢复后再登记';
    else if (hasMatchingMaterial) hint.textContent = type === 'out' ? '匹配到已有耗材，请从候选菜单中选择' : '匹配到已有耗材，请选择；如需新名称请继续输入';
    else if (materialName && type === 'out') hint.textContent = '领用 / 使用只能选择已有耗材';
    else if (isNewInbound) hint.textContent = selectedNewTrackingMode === 'quantity'
      ? '保存后将创建新耗材并登记首次入库'
      : '保存后将创建耗材档案，并进入库存明细完成首次入库';
    else hint.textContent = '选择已有耗材，或直接填写新耗材名称入库';
  }
}

function routeTrackedMaterialSelection() {
  const material = materialFromInput();
  if (!material || material.trackingMode === 'quantity') return;
  const type = currentTransactionType();
  closeModals();
  void openInventoryDetail(material.id);
  toast(material.trackingMode === 'tracked'
    ? `已打开“${material.name}”，请选择${type === 'in' ? '入库盒子' : '盒子和位置'}`
    : `已打开“${material.name}”，请选择状态明细登记数量`);
}

function qrPayloadForMaterial(materialId: string) {
  return createMaterialQrPayload(materialId, window.location.href);
}

function setScannerStatus(message: string, error = false) {
  const status = $('[data-scanner-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', error);
}

function selectedScanTransactionType(): 'in' | 'out' {
  return $('[data-scan-transaction-type].active')?.getAttribute('data-scan-transaction-type') === 'in' ? 'in' : 'out';
}

function setScanTransactionType(type: 'in' | 'out') {
  $$<HTMLButtonElement>('[data-scan-transaction-type]').forEach((button) => {
    const active = button.dataset.scanTransactionType === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function stopScanner() {
  scannerGeneration += 1;
  try { scannerControls?.stop(); } catch {}
  scannerControls = null;
  scannerOpening = false;
  $('[data-scanner-viewport]')?.classList.remove('camera-active');
  const video = $<HTMLVideoElement>('[data-scanner-video]');
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  const button = $<HTMLButtonElement>('[data-start-scanner]');
  if (button) button.disabled = false;
  const label = $('[data-start-scanner-label]');
  if (label) label.textContent = '打开摄像头';
}

function closeScanner(restoreTransaction = scannerReturnToTransaction) {
  stopScanner();
  hideModal(scannerModal);
  const imageInput = $<HTMLInputElement>('[data-scanner-image]');
  if (imageInput) imageInput.value = '';
  if (restoreTransaction) bringModalToFront(transactionModal);
  const hasOpenModal = Boolean($('.modal-backdrop.open'));
  document.body.classList.toggle('modal-open', hasOpenModal);
  if (!hasOpenModal) unlockModalPage();
  if (scannerReturnFocus?.isConnected) scannerReturnFocus.focus();
  scannerReturnFocus = null;
  scannerReturnToTransaction = false;
}

function openTransactionForMaterial(material: Material, type: 'in' | 'out', preserveForm = false) {
  if (!material.active) {
    toast(`耗材“${material.name}”已归档，请先由管理员恢复`);
    return;
  }
  if (material.trackingMode !== 'quantity') {
    hideModal(transactionModal);
    void openInventoryDetail(material.id);
    toast(`“${material.name}”使用按状态或按批次 / 盒 / 单件管理，请在库存明细中登记`);
    return;
  }
  const form = $<HTMLFormElement>('[data-transaction-form]');
  if (!preserveForm) form?.reset();
  setTransactionType(type);
  const materialInput = $<HTMLInputElement>('#material-name');
  if (materialInput) materialInput.value = material.name;
  const date = $<HTMLInputElement>('#material-date');
  if (date && !date.value) date.value = localDateTimeValue();
  updateMaterialSelection();
  openModal(transactionModal);
  if (!mobileDrawerMedia.matches) requestAnimationFrame(() => $<HTMLInputElement>('#material-quantity')?.focus());
}

async function acceptScannedText(value: string) {
  if (!state || scannerResultHandled) return;
  const target = inventoryTargetFromQrText(value);
  if (!target) {
    const appName = state.settings.appName.trim() || '当前系统';
    setScannerStatus(`没有识别到有效的“${appName}”库存二维码，请调整距离或更换图片。`, true);
    return;
  }
  if (target.type === 'unit') {
    scannerResultHandled = true;
    closeScanner(false);
    await openInventoryDetail('', target.id);
    toast('已定位库存单元，请确认明细后登记');
    return;
  }
  const materialId = target.id;
  const material = state.materials.find((candidate) => candidate.id === materialId);
  if (!material) {
    setScannerStatus('该二维码对应的耗材不在当前系统中，可能来自其他实验室或已被永久删除。', true);
    return;
  }
  if (!material.active) {
    setScannerStatus(`“${material.name}”已归档，恢复使用后才能登记出入库。`, true);
    stopScanner();
    return;
  }
  scannerResultHandled = true;
  const preserveForm = scannerReturnToTransaction;
  const type = selectedScanTransactionType();
  closeScanner(false);
  if (material.trackingMode !== 'quantity') {
    await openInventoryDetail(material.id);
    toast(material.trackingMode === 'tracked' ? '已定位耗材，请选择盒子和位置登记' : '已定位耗材，请选择状态明细登记数量');
    return;
  }
  openTransactionForMaterial(material, type, preserveForm);
  toast(`已识别“${material.name}”，请确认数量后保存`);
}

async function startCameraScanner() {
  if (scannerOpening || scannerControls) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setScannerStatus('当前地址不能调用摄像头。请使用 HTTPS，或选择手机中的二维码图片识别。', true);
    return;
  }
  const video = $<HTMLVideoElement>('[data-scanner-video]');
  if (!video) return;
  const generation = ++scannerGeneration;
  scannerOpening = true;
  const startButton = $<HTMLButtonElement>('[data-start-scanner]');
  if (startButton) startButton.disabled = true;
  const startLabel = $('[data-start-scanner-label]');
  if (startLabel) startLabel.textContent = '正在打开';
  setScannerStatus('正在请求摄像头权限…');
  try {
    const { BrowserQRCodeReader } = await loadZxing();
    const reader = new BrowserQRCodeReader(undefined, { delayBetweenScanAttempts: 180, delayBetweenScanSuccess: 700 });
    const controls = await reader.decodeFromConstraints(
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      video,
      (result) => {
        if (result) void acceptScannedText(result.getText());
      },
    );
    if (generation !== scannerGeneration || !scannerModal?.classList.contains('open')) {
      controls.stop();
      return;
    }
    scannerControls = controls;
    $('[data-scanner-viewport]')?.classList.add('camera-active');
    if (startLabel) startLabel.textContent = '摄像头已开启';
    setScannerStatus('摄像头已开启，将二维码完整放入取景框。');
  } catch (failure) {
    if (generation !== scannerGeneration) return;
    const name = (failure as { name?: string }).name;
    if (startButton) startButton.disabled = false;
    if (startLabel) startLabel.textContent = '重新打开摄像头';
    setScannerStatus(
      name === 'NotAllowedError'
        ? '摄像头权限被拒绝。可在浏览器站点设置中允许摄像头，或上传二维码图片。'
        : '无法启动摄像头，请确认没有被其他应用占用，或上传二维码图片。',
      true,
    );
  } finally {
    if (generation === scannerGeneration) scannerOpening = false;
  }
}

function openScanner(returnToTransaction = false) {
  if (!state) return;
  stopScanner();
  scannerResultHandled = false;
  scannerReturnToTransaction = returnToTransaction;
  scannerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (returnToTransaction) {
    setScanTransactionType(currentTransactionType());
    hideModal(transactionModal);
  } else {
    setScanTransactionType('out');
  }
  setScannerStatus('准备扫描耗材二维码');
  lockModalPage();
  bringModalToFront(scannerModal);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => {
    const dialog = $<HTMLElement>('.modal', scannerModal ?? document);
    if (dialog) {
      dialog.tabIndex = -1;
      dialog.focus({ preventScroll: true });
    }
  });
  void startCameraScanner();
}

async function decodeScannerImage(file: File) {
  if (file.size > 12 * 1024 * 1024) {
    setScannerStatus('二维码图片不能超过 12 MB，请压缩或裁剪后重试。', true);
    const imageInput = $<HTMLInputElement>('[data-scanner-image]');
    if (imageInput) imageInput.value = '';
    return;
  }
  stopScanner();
  setScannerStatus('正在识别图片中的二维码…');
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('图片读取失败')), { once: true });
      reader.addEventListener('error', () => reject(reader.error ?? new Error('图片读取失败')), { once: true });
      reader.readAsDataURL(file);
    });
    const { BrowserQRCodeReader } = await loadZxing();
    const result = await new BrowserQRCodeReader().decodeFromImageUrl(dataUrl);
    await acceptScannedText(result.getText());
  } catch {
    setScannerStatus('图片中没有识别到有效二维码，请选择清晰、完整的二维码图片。', true);
  } finally {
    const imageInput = $<HTMLInputElement>('[data-scanner-image]');
    if (imageInput) imageInput.value = '';
  }
}

async function openMaterialQr(materialId: string) {
  const material = state?.materials.find((candidate) => candidate.id === materialId);
  if (!material) return;
  qrInventoryUnitTarget = null;
  qrMaterialTargetId = material.id;
  qrMaterialDataUrl = '';
  materialLabelPreviewDataUrl = '';
  materialLabelPreviewSignature = '';
  materialLabelPreviewGeneration += 1;
  const title = $('[data-material-qr-title]') ?? $('#material-qr-title');
  const subtitle = $('[data-material-qr-subtitle]') ?? $('#material-qr-title')?.nextElementSibling;
  if (title) title.textContent = `${material.name} 标签输出`;
  if (subtitle) subtitle.textContent = '预览、下载与打印使用同一版式，可选择预设或自定义尺寸';
  $$<HTMLButtonElement>('[data-print-material-qr], [data-download-material-qr], [data-download-material-label]').forEach((button) => { button.disabled = true; });
  const image = $<HTMLImageElement>('[data-material-label-preview-image]');
  const loading = $('[data-material-label-preview-loading]');
  if (image) {
    image.hidden = true;
    image.removeAttribute('src');
  }
  if (loading) {
    loading.textContent = '正在生成二维码';
    loading.removeAttribute('hidden');
  }
  syncMaterialLabelControls(false);
  openModal(materialQrModal);
  try {
    const dataUrl = await createMaterialQrDataUrl(material.id);
    if (qrMaterialTargetId !== material.id) return;
    qrMaterialDataUrl = dataUrl;
    syncMaterialLabelControls(true);
    await renderMaterialLabelPreview();
  } catch {
    if (loading) loading.textContent = '二维码生成失败，请关闭后重试';
  }
}

async function createMaterialQrDataUrl(materialId: string) {
  const QRCode = await loadQrCode();
  return QRCode.toDataURL(qrPayloadForMaterial(materialId), {
    width: 640,
    margin: 3,
    errorCorrectionLevel: 'M',
    color: { dark: '#10251f', light: '#ffffff' },
  });
}

function selectedLabelSize(selectSelector: string, widthSelector: string, heightSelector: string) {
  const key = $<HTMLSelectElement>(selectSelector)?.value as MaterialLabelSizeKey | undefined;
  if (key !== 'custom') {
    const presetKey = key && key in materialLabelPresetDimensions ? key as Exclude<MaterialLabelSizeKey, 'custom'> : '86x54';
    const [width, height] = materialLabelPresetDimensions[presetKey];
    return materialLabelSize(presetKey, width, height);
  }
  const widthInput = $<HTMLInputElement>(widthSelector);
  const heightInput = $<HTMLInputElement>(heightSelector);
  const width = Number(widthInput?.value);
  const height = Number(heightInput?.value);
  if (!widthInput?.checkValidity() || !heightInput?.checkValidity() || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('自定义标签宽度应为 35–120 mm，高度应为 22–80 mm');
  }
  if (width / height < 1.4) throw new Error('自定义标签需要横向排版，宽度至少应为高度的 1.4 倍');
  const formatDimension = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, '');
  return materialLabelSize(`${formatDimension(width)}x${formatDimension(height)}`, width, height);
}

function selectedMaterialLabelSize() {
  return selectedLabelSize('[data-material-label-size]', '[data-custom-label-width]', '[data-custom-label-height]');
}

function selectedBatchLabelSize() {
  return selectedLabelSize('[data-batch-label-size]', '[data-batch-label-width]', '[data-batch-label-height]');
}

function shortMaterialId(id: string) {
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

function applyMaterialLabelPreviewSize(size: MaterialLabelSize) {
  const preview = $<HTMLElement>('[data-material-label-preview]');
  if (!preview) return;
  preview.dataset.labelSize = size.key;
  preview.style.setProperty('--label-aspect', `${size.width} / ${size.height}`);
  preview.style.setProperty('--label-preview-natural-width', `${Math.min(540, 340 * size.width / size.height)}px`);
}

function materialLabelSignature(material: Material, size: MaterialLabelSize) {
  return `${material.id}:${qrInventoryUnitTarget?.id ?? ''}:${size.width}:${size.height}:${state?.settings.appName || ''}`;
}

function setMaterialLabelStatus(message: string, warning = false) {
  const status = $('[data-material-label-status]');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('warning', warning);
}

function materialPrintLayout() {
  return $<HTMLSelectElement>('[data-material-print-layout]')?.value === 'a4' ? 'a4' : 'single';
}

function selectedMaterialPrintCopies() {
  const input = $<HTMLInputElement>('[data-material-print-copies]');
  const copies = Number(input?.value);
  if (!input?.checkValidity() || !Number.isInteger(copies)) throw new Error('A4 打印份数应为 1–100 的整数');
  return copies;
}

function a4MaterialLabelLayout(size: MaterialLabelSize) {
  const contentWidth = 190;
  const contentHeight = 277;
  const gap = 3;
  const columns = Math.max(1, Math.floor((contentWidth + gap) / (size.width + gap)));
  const rows = Math.max(1, Math.floor((contentHeight + gap) / (size.height + gap)));
  return { columns, rows, perPage: columns * rows, gap, contentWidth, contentHeight };
}

function syncMaterialPrintControls(size: MaterialLabelSize | null) {
  const a4 = materialPrintLayout() === 'a4';
  $('[data-material-sheet-options]')?.toggleAttribute('hidden', !a4);
  const status = $('[data-material-sheet-status]');
  let valid = true;
  if (a4) {
    try {
      const copies = selectedMaterialPrintCopies();
      if (size && status) {
        const layout = a4MaterialLabelLayout(size);
        const pages = Math.ceil(copies / layout.perPage);
        status.textContent = `A4 纵向每行 ${layout.columns} 个、每页最多 ${layout.perPage} 个；本次打印 ${copies} 个，共 ${pages} 页。`;
      }
    } catch (failure) {
      valid = false;
      if (status) status.textContent = (failure as Error).message;
    }
  }
  return valid;
}

function syncMaterialLabelControls(qrReady = Boolean(qrMaterialDataUrl)) {
  const select = $<HTMLSelectElement>('[data-material-label-size]');
  const custom = select?.value === 'custom';
  $('[data-custom-label-size]')?.toggleAttribute('hidden', !custom);
  let size: MaterialLabelSize | null = null;
  try {
    size = selectedMaterialLabelSize();
    applyMaterialLabelPreviewSize(size);
    const compact = size.width < 40 || size.height < 25;
    setMaterialLabelStatus(compact
      ? '此尺寸小于推荐的 40 × 25 mm，文字可能截短；更小标签建议使用纯二维码。'
      : '内容会按标签尺寸自动缩放。打印时选择“实际大小”或 100%，并关闭页眉和页脚。', compact);
  } catch (failure) {
    setMaterialLabelStatus((failure as Error).message, true);
  }
  const labelReady = qrReady && Boolean(size);
  const printReady = syncMaterialPrintControls(size);
  const qrButton = $<HTMLButtonElement>('[data-download-material-qr]');
  if (qrButton) qrButton.disabled = !qrReady;
  const labelButton = $<HTMLButtonElement>('[data-download-material-label]');
  if (labelButton) labelButton.disabled = !labelReady;
  const printButton = $<HTMLButtonElement>('[data-print-material-qr]');
  if (printButton) printButton.disabled = !labelReady || !printReady;
  return size;
}

function scheduleMaterialLabelPreview() {
  window.clearTimeout(materialLabelPreviewTimer);
  materialLabelPreviewTimer = window.setTimeout(() => void renderMaterialLabelPreview(), 120);
}

async function renderMaterialLabelPreview() {
  const material = state?.materials.find((candidate) => candidate.id === qrMaterialTargetId);
  const image = $<HTMLImageElement>('[data-material-label-preview-image]');
  const loading = $('[data-material-label-preview-loading]');
  if (!material || !image || !loading || !qrMaterialDataUrl) return;
  const generation = ++materialLabelPreviewGeneration;
  image.hidden = true;
  loading.textContent = '正在生成标签预览';
  loading.removeAttribute('hidden');
  try {
    const size = selectedMaterialLabelSize();
    applyMaterialLabelPreviewSize(size);
    const dataUrl = await createMaterialLabelPng(material, size, qrMaterialDataUrl, qrInventoryUnitTarget);
    if (generation !== materialLabelPreviewGeneration || material.id !== qrMaterialTargetId) return;
    materialLabelPreviewDataUrl = dataUrl;
    materialLabelPreviewSignature = materialLabelSignature(material, size);
    image.src = dataUrl;
    image.alt = `${material.name} 的 ${size.width} × ${size.height} mm 标签预览`;
    image.hidden = false;
    loading.setAttribute('hidden', '');
  } catch (failure) {
    if (generation !== materialLabelPreviewGeneration) return;
    loading.textContent = (failure as Error).message || '标签预览生成失败';
  }
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function safeMaterialFilename(name: string) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || '耗材';
}

function loadCanvasImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('标签图片生成失败')), { once: true });
    image.src = source;
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const character of Array.from(text.trim())) {
    const candidate = line + character;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = character;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

function ellipsizeCanvasLine(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  let value = text;
  while (value && context.measureText(`${value}…`).width > maxWidth) value = value.slice(0, -1);
  return `${value}…`;
}

function drawCanvasLines(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, fontSize: number, maxLines: number, color: string, weight = 400) {
  context.font = `${weight} ${fontSize}px Inter, "Microsoft YaHei", sans-serif`;
  context.fillStyle = color;
  context.textBaseline = 'top';
  const allLines = wrapCanvasText(context, text, maxWidth);
  const lines = allLines.slice(0, maxLines);
  if (allLines.length > maxLines) lines[maxLines - 1] = ellipsizeCanvasLine(context, lines[maxLines - 1], maxWidth);
  const lineHeight = fontSize * 1.22;
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight, maxWidth));
  return y + lines.length * lineHeight;
}

async function createMaterialLabelPng(material: Material, size = selectedMaterialLabelSize(), qrDataUrl = qrMaterialDataUrl, unit: InventoryUnit | null = null) {
  if (!qrDataUrl) throw new Error('二维码仍在生成，请稍后重试');
  const pixelsPerMillimeter = 300 / 25.4;
  const px = (millimeters: number) => millimeters * pixelsPerMillimeter;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(px(size.width));
  canvas.height = Math.round(px(size.height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器无法生成标签 PNG');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const qrImage = await loadCanvasImage(qrDataUrl);
  const padding = px(size.padding);
  const qrSize = canvas.height - padding * 2;
  context.drawImage(qrImage, padding, padding, qrSize, qrSize);
  const textX = padding + qrSize + px(size.gap);
  const textWidth = canvas.width - padding - textX;
  let cursor = padding;
  cursor = drawCanvasLines(context, state?.settings.appName || 'OpenLabStock', textX, cursor, textWidth, px(size.brandSize), 1, '#004b3b', 700) + px(0.8);
  cursor = drawCanvasLines(context, unit ? unit.displayLabel : material.name, textX, cursor, textWidth, px(size.titleSize), 2, '#10251f', 700) + px(1.1);
  const metaBottom = canvas.height - padding - px(size.metaSize * 5.1);
  drawCanvasLines(context, unit ? material.name : `${material.category}${material.spec ? ` · ${material.spec}` : ''}`, textX, cursor, textWidth, px(size.metaSize), cursor < metaBottom ? 2 : 1, '#53645c', 400);
  const instructionY = canvas.height - padding - px(size.metaSize * 3.2);
  drawCanvasLines(context, '扫码登记入库或出库', textX, instructionY, textWidth, px(size.metaSize), 1, '#10251f', 700);
  const idY = canvas.height - padding - px(size.idSize * 1.3);
  context.font = `400 ${px(size.idSize)}px ui-monospace, Consolas, monospace`;
  context.fillStyle = '#53645c';
  context.textBaseline = 'top';
  context.fillText(`ID ${shortMaterialId(unit?.id ?? material.id)}`, textX, idY, textWidth);
  return canvas.toDataURL('image/png');
}

async function materialLabelDataUrl(material: Material, size: MaterialLabelSize) {
  const signature = materialLabelSignature(material, size);
  if (materialLabelPreviewDataUrl && materialLabelPreviewSignature === signature) return materialLabelPreviewDataUrl;
  const dataUrl = await createMaterialLabelPng(material, size, qrMaterialDataUrl, qrInventoryUnitTarget);
  materialLabelPreviewDataUrl = dataUrl;
  materialLabelPreviewSignature = signature;
  return dataUrl;
}

function createPrintImage(dataUrl: string, className: string) {
  const image = document.createElement('img');
  image.className = className;
  image.src = dataUrl;
  image.alt = '';
  return image;
}

function prepareA4MaterialPrintLabels(dataUrls: string[], size: MaterialLabelSize, cutLines: boolean) {
  const root = $<HTMLElement>('[data-material-label-print-root]');
  if (!root) throw new Error('打印标签区域不可用');
  const layout = a4MaterialLabelLayout(size);
  root.replaceChildren();
  root.dataset.printLayout = 'a4';
  root.dataset.cutLines = String(cutLines);
  root.style.setProperty('--print-label-width', `${size.width}mm`);
  root.style.setProperty('--print-label-height', `${size.height}mm`);
  root.style.setProperty('--print-sheet-columns', String(layout.columns));
  root.style.setProperty('--print-sheet-gap', `${layout.gap}mm`);
  const images: HTMLImageElement[] = [];
  for (let offset = 0; offset < dataUrls.length; offset += layout.perPage) {
    const sheet = document.createElement('section');
    sheet.className = 'print-material-sheet';
    dataUrls.slice(offset, offset + layout.perPage).forEach((dataUrl) => {
      const cell = document.createElement('div');
      cell.className = 'print-material-sheet-cell';
      const image = createPrintImage(dataUrl, 'print-material-sheet-label');
      images.push(image);
      cell.append(image);
      sheet.append(cell);
    });
    root.append(sheet);
  }
  const pageStyle = $<HTMLStyleElement>('[data-material-print-page-style]');
  if (pageStyle) pageStyle.textContent = '@page { size: A4 portrait; margin: 10mm; }';
  return images;
}

function prepareMaterialPrintLabel(dataUrl: string, size: MaterialLabelSize) {
  const root = $<HTMLElement>('[data-material-label-print-root]');
  if (!root) throw new Error('打印标签区域不可用');
  const pageStyle = $<HTMLStyleElement>('[data-material-print-page-style]');
  if (materialPrintLayout() === 'single') {
    root.replaceChildren();
    root.dataset.printLayout = 'single';
    root.dataset.cutLines = 'false';
    root.style.setProperty('--print-label-width', `${size.width}mm`);
    root.style.setProperty('--print-label-height', `${size.height}mm`);
    const image = createPrintImage(dataUrl, 'print-material-label-image');
    root.append(image);
    if (pageStyle) pageStyle.textContent = `@page { size: ${size.width}mm ${size.height}mm; margin: 0; }`;
    return [image];
  }
  const copies = selectedMaterialPrintCopies();
  const cutLines = $<HTMLInputElement>('[data-material-cut-lines]')?.checked ?? true;
  return prepareA4MaterialPrintLabels(Array.from({ length: copies }, () => dataUrl), size, cutLines);
}

function batchLabelMaterials() {
  return state?.materials
    .filter((material) => material.active)
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' })) ?? [];
}

function visibleBatchLabelMaterials() {
  const query = $<HTMLInputElement>('[data-batch-label-search]')?.value.trim().toLowerCase() ?? '';
  return batchLabelMaterials().filter((material) => !query || `${material.name} ${material.category} ${material.spec}`.toLowerCase().includes(query));
}

function selectedBatchLabelCopies() {
  const input = $<HTMLInputElement>('[data-batch-label-copies]');
  const copies = Number(input?.value);
  if (!input?.checkValidity() || !Number.isInteger(copies)) throw new Error('每种打印份数应为 1–10 的整数');
  return copies;
}

function syncBatchLabelControls() {
  const sizeSelect = $<HTMLSelectElement>('[data-batch-label-size]');
  $('[data-batch-custom-label-size]')?.toggleAttribute('hidden', sizeSelect?.value !== 'custom');
  const selectedCount = batchLabelSelectedIds.size;
  const selectedCountNode = $('[data-batch-label-selected-count]');
  if (selectedCountNode) selectedCountNode.textContent = `已选 ${selectedCount} 种`;
  const status = $('[data-batch-label-status]');
  const printButton = $<HTMLButtonElement>('[data-print-batch-labels]');
  let valid = selectedCount > 0;
  try {
    const size = selectedBatchLabelSize();
    const copies = selectedBatchLabelCopies();
    const total = selectedCount * copies;
    const layout = a4MaterialLabelLayout(size);
    const pages = total ? Math.ceil(total / layout.perPage) : 0;
    if (total > 100) throw new Error(`本次共 ${total} 张，超过 100 张上限；请减少耗材或每种份数`);
    if (status) status.textContent = selectedCount
      ? `共 ${total} 张，每页最多 ${layout.perPage} 张，预计使用 ${pages} 页 A4 纸。`
      : `每页最多 ${layout.perPage} 张；请选择至少一种耗材。`;
  } catch (failure) {
    valid = false;
    if (status) status.textContent = (failure as Error).message;
  }
  status?.classList.toggle('warning', !valid && selectedCount > 0);
  if (printButton) printButton.disabled = !valid;
  return valid;
}

function renderBatchLabelMaterials() {
  const list = $('[data-batch-label-list]');
  if (!list) return;
  const availableIds = new Set(batchLabelMaterials().map((material) => material.id));
  [...batchLabelSelectedIds].forEach((id) => {
    if (!availableIds.has(id)) batchLabelSelectedIds.delete(id);
  });
  const materials = visibleBatchLabelMaterials();
  const fragment = document.createDocumentFragment();
  materials.forEach((material) => {
    const row = document.createElement('label');
    row.className = 'batch-label-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = batchLabelSelectedIds.has(material.id);
    checkbox.dataset.batchLabelMaterial = material.id;
    checkbox.setAttribute('aria-label', `选择 ${material.name}`);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = material.name;
    const meta = document.createElement('small');
    meta.textContent = `${material.category}${material.spec ? ` · ${material.spec}` : ''} · ${materialStockLabel(material)}`;
    copy.append(name, meta);
    row.append(checkbox, copy);
    fragment.append(row);
  });
  if (!materials.length) {
    const empty = document.createElement('p');
    empty.className = 'batch-label-empty';
    empty.textContent = '没有符合条件的使用中耗材';
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  const visibleCount = $('[data-batch-label-visible-count]');
  if (visibleCount) visibleCount.textContent = `${materials.length} 种可选耗材`;
  syncBatchLabelControls();
}

function openBatchLabels() {
  batchLabelSelectedIds.clear();
  const search = $<HTMLInputElement>('[data-batch-label-search]');
  if (search) search.value = '';
  renderBatchLabelMaterials();
  const list = $('[data-batch-label-list]');
  if (list) list.scrollTop = 0;
  openModal(batchLabelModal);
}

async function printMaterialImages(images: HTMLImageElement[]) {
  await Promise.all(images.filter((image) => !image.complete).map((image) => image.decode()));
  document.body.classList.add('printing-material-label');
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-material-label'), { once: true });
  try {
    window.print();
  } finally {
    window.setTimeout(() => document.body.classList.remove('printing-material-label'), 0);
  }
}

function consumeInventoryLink() {
  if (!state) return;
  const url = new URL(window.location.href);
  const unitId = url.searchParams.get('unit') ?? '';
  const materialId = url.searchParams.get('material') ?? '';
  if (!materialId && !unitId) return;
  url.searchParams.delete('unit');
  url.searchParams.delete('material');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  if (unitId) {
    if (!inventoryUnitIdPattern.test(unitId)) {
      toast('二维码中的库存单元编号无效');
      return;
    }
    void openInventoryDetail('', unitId);
    return;
  }
  if (!materialIdPattern.test(materialId)) {
    toast('二维码中的耗材编号无效');
    return;
  }
  const material = state.materials.find((candidate) => candidate.id === materialId);
  if (!material) {
    toast('二维码对应的耗材不存在，可能已被删除');
    return;
  }
  openTransactionForMaterial(material, 'out');
  toast(`已通过二维码打开“${material.name}”`);
}

function transactionRows(records: Transaction[], recent = false) {
  if (!records.length) return `<tr><td colspan="${recent ? 6 : 7}" class="empty-note">暂无库存活动记录</td></tr>`;
  return records.map((record) => {
    const sign = record.type === 'in' ? '+' : '-';
    const chip = `<span class="type-chip ${record.type}">${record.type === 'in' ? '入库' : '领用'}</span>`;
    const userName = record.userName || '历史成员';
    const user = `<span class="record-user-name" title="${escapeHtml(userName)}">${escapeHtml(userName)}</span>`;
    const scope = record.accessScope === 'user' ? `自用 · ${record.ownerName || '历史成员'}` : record.accessScope === 'shared' ? '开放使用' : '';
    const inventoryDetail = [record.correctionOfId ? '更正记录' : record.operation === 'dispose' ? '处置' : '', record.inventoryUnitLabel, record.statusName, scope].filter(Boolean).join(' · ');
    const material = `<div class="record-material-wrap"><span class="record-material-copy"><strong>${escapeHtml(record.materialName)}</strong>${inventoryDetail ? `<small class="record-material-detail">${escapeHtml(inventoryDetail)}</small>` : ''}</span></div>`;
    if (recent) return `<tr class="record-row"><td class="record-time">${formatTime(record.occurredAt)}</td><td class="record-type">${chip}</td><td class="record-material">${material}</td><td class="record-quantity ${record.type}">${sign}${formatNumber(record.quantity)} ${escapeHtml(record.unit)}</td><td class="record-user">${user}</td><td class="record-note">${escapeHtml(record.note || '-')}</td></tr>`;
    const attributes = `data-record-type="${record.type}" data-occurred-at="${escapeHtml(record.occurredAt)}"`;
    const correctedQuantity = record.correctedQuantity;
    const corrected = correctedQuantity != null;
    const canCorrect = record.sourceType === 'manual' && !record.correctionOfId && !corrected && (record.userId === state?.user.id || state?.user.role === 'admin');
    const correctionIcon = document.querySelector('[data-correction-icon-template]')?.innerHTML ?? '';
    const action = canCorrect ? `<button class="text-button record-inline-action" type="button" data-correct-transaction="${escapeHtml(record.id)}">${correctionIcon}<span>更正</span></button>` : corrected ? `<span class="record-correction-state">已冲销 ${formatNumber(correctedQuantity)} ${escapeHtml(record.unit)}</span>` : '';
    return `<tr class="record-row" ${attributes}><td class="record-time">${formatTime(record.occurredAt)}</td><td class="record-type">${chip}</td><td class="record-material">${material}</td><td class="record-quantity ${record.type}">${sign}${formatNumber(record.quantity)} ${escapeHtml(record.unit)}</td><td class="record-user">${user}</td><td class="record-context"><span class="record-context-label">来源 / 去向：</span>${escapeHtml(record.counterparty || '-')}</td><td class="record-note"><div class="record-note-content"><span class="record-note-copy">${escapeHtml(record.note || '-')}</span>${action}</div></td></tr>`;
  }).join('');
}

function inventoryEventRows(events: InventoryEvent[]) {
  return events.map((event) => {
    const unit = state?.materials.find((material) => material.id === event.materialId)?.unit ?? '';
    const detail = [event.inventoryUnitLabel || '库存单元', event.fromStatusName].filter(Boolean).join(' · ');
    const material = `<div class="record-material-wrap"><span class="record-material-copy"><strong>${escapeHtml(event.materialName)}</strong><small class="record-material-detail">${escapeHtml(detail)}</small></span></div>`;
    const change = eventChangeLabel(event);
    const userName = event.userName || '历史成员';
    const user = `<span class="record-user-name" title="${escapeHtml(userName)}">${escapeHtml(userName)}</span>`;
    const canCorrect = event.eventType === 'use' && !event.corrected && (event.userId === state?.user.id || state?.user.role === 'admin');
    const correctionIcon = document.querySelector('[data-correction-icon-template]')?.innerHTML ?? '';
    const correctionAction = canCorrect
      ? `<button class="text-button record-inline-action" type="button" data-correct-inventory-event="${escapeHtml(event.id)}">${correctionIcon}<span>更正</span></button>`
      : event.corrected ? '<span class="record-correction-state">已更正</span>' : '';
    const detailAction = event.inventoryUnitId ? `<button class="text-button record-inline-action" type="button" data-open-record-unit="${escapeHtml(event.inventoryUnitId)}">${document.querySelector('[data-inventory-register-icon-template]')?.innerHTML ?? ''}<span>查看明细</span></button>` : '';
    const useEvent = event.eventType === 'use' || event.eventType === 'use_correction';
    const chipLabel = event.eventType === 'use' ? '使用' : event.eventType === 'use_correction' ? '更正' : '变更';
    const contextLabel = useEvent ? '使用位置 / 项目：' : '变更内容：';
    const context = useEvent ? event.counterparty || '-' : change;
    return `<tr class="record-row" data-record-type="${useEvent ? 'use' : 'inventory_event'}" data-occurred-at="${escapeHtml(event.occurredAt)}"><td class="record-time">${formatTime(event.occurredAt)}</td><td class="record-type"><span class="type-chip adjustment">${chipLabel}</span></td><td class="record-material">${material}</td><td class="record-quantity">${formatNumber(event.quantity)}${unit ? ` ${escapeHtml(unit)}` : ''}</td><td class="record-user">${user}</td><td class="record-context"><span class="record-context-label">${contextLabel}</span>${escapeHtml(context)}</td><td class="record-note"><div class="record-note-content"><span class="record-note-copy">${escapeHtml(event.note || '-')}</span>${correctionAction}${detailAction}</div></td></tr>`;
  }).join('');
}

function openTransactionCorrection(record: Transaction) {
  inventoryEventCorrectionTarget = null;
  correctionTarget = record;
  const positioned = Boolean(record.positionCode);
  const scope = record.accessScope === 'user' ? `成员自用 · ${record.ownerName || '历史成员'}` : record.accessScope === 'shared' ? '开放使用' : '';
  const details = [record.inventoryUnitLabel, record.statusName, scope, record.positionCode ? `位置 ${record.positionCode}` : ''].filter(Boolean).join(' · ');
  const summary = $('[data-correction-summary]');
  if (summary) summary.innerHTML = `<strong>${escapeHtml(record.type === 'in' ? '原入库' : '原领用 / 使用')} · ${escapeHtml(record.materialName)}</strong><span>${formatTime(record.occurredAt)} · ${escapeHtml(record.userName)} · ${formatNumber(record.quantity)} ${escapeHtml(record.unit)}${details ? `<br>${escapeHtml(details)}` : ''}</span>`;
  const quantity = $<HTMLInputElement>('#correction-quantity');
  if (quantity) {
    quantity.value = String(record.quantity);
    quantity.max = String(record.quantity);
    quantity.disabled = positioned;
  }
  const hint = $('[data-correction-quantity-hint]');
  if (hint) hint.textContent = positioned ? '按位置追踪的单件必须整笔冲销。' : `可冲销全部或部分数量，最多 ${formatNumber(record.quantity)} ${record.unit}。`;
  const impact = $('[data-correction-impact]');
  if (impact) impact.textContent = record.type === 'in'
    ? '确认后将扣减相同数量，原入库记录保留并标记为已更正。'
    : '确认后将补回相同数量，原领用 / 使用记录保留并标记为已更正。';
  const reason = $<HTMLTextAreaElement>('#correction-reason');
  if (reason) reason.value = '';
  openModal(correctionModal);
}

function openInventoryEventCorrection(event: InventoryEvent) {
  correctionTarget = null;
  inventoryEventCorrectionTarget = event;
  const summary = $('[data-correction-summary]');
  if (summary) summary.innerHTML = `<strong>原使用登记 · ${escapeHtml(event.materialName)}</strong><span>${formatTime(event.occurredAt)} · ${escapeHtml(event.userName)} · ${formatNumber(event.quantity)}${event.inventoryUnitLabel ? `<br>${escapeHtml(event.inventoryUnitLabel)}` : ''}</span>`;
  const quantity = $<HTMLInputElement>('#correction-quantity');
  if (quantity) {
    quantity.value = String(event.quantity);
    quantity.max = String(event.quantity);
    quantity.disabled = true;
  }
  const hint = $('[data-correction-quantity-hint]');
  if (hint) hint.textContent = '使用登记固定整笔冲销，不改变当前库存数量或状态。';
  const impact = $('[data-correction-impact]');
  if (impact) impact.textContent = '确认后追加一条使用更正记录；原记录保留，当前状态不会自动倒退。';
  const reason = $<HTMLTextAreaElement>('#correction-reason');
  if (reason) reason.value = '';
  openModal(correctionModal);
}

function renderTransactions() {
  if (!state) return;
  const recentBody = $('[data-recent-body]');
  const recordsBody = $('[data-records-body]');
  if (recentBody) recentBody.innerHTML = transactionRows(state.transactions.slice(0, 5), true);
  if (recordsBody) {
    recordsBody.innerHTML = recordTotal
      ? recordPageItems.map((entry) => entry.kind === 'transaction' ? transactionRows([entry.record]) : inventoryEventRows([entry.event])).join('')
      : '<tr><td colspan="7" class="empty-note">没有符合条件的记录</td></tr>';
    const paginationBar = $<HTMLElement>('[data-record-pagination]');
    const rangeLabel = $('[data-record-page-range]');
    const pageLabel = $('[data-record-page-label]');
    const previous = $<HTMLButtonElement>('[data-record-page-previous]');
    const next = $<HTMLButtonElement>('[data-record-page-next]');
    const from = recordTotal ? (recordPage - 1) * DEFAULT_RECORD_PAGE_SIZE + 1 : 0;
    const to = recordTotal ? from + recordPageItems.length - 1 : 0;
    const totalPages = Math.max(1, Math.ceil(recordTotal / DEFAULT_RECORD_PAGE_SIZE));
    if (paginationBar) paginationBar.hidden = recordTotal === 0;
    if (rangeLabel) rangeLabel.textContent = `第 ${from}–${to} 条，共 ${recordTotal} 条`;
    if (pageLabel) pageLabel.textContent = `第 ${recordPage} / ${totalPages} 页`;
    if (previous) previous.disabled = recordPage <= 1;
    if (next) next.disabled = !recordHasMore;
  }
}

function syncRecordScopeButtons() {
  $$<HTMLButtonElement>('[data-record-scope]').forEach((button) => {
    const active = button.dataset.recordScope === recordScope;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setTransactionLoadingState(status: 'idle' | 'loading' | 'slow' | 'error', message = '') {
  const loading = $<HTMLElement>('[data-records-loading]');
  const label = $('[data-records-loading-label]');
  const retry = $<HTMLButtonElement>('[data-retry-records]');
  const panel = $('.records-panel');
  if (!loading || !label || !retry) return;
  loading.hidden = status === 'idle';
  loading.classList.toggle('has-error', status === 'error');
  loading.classList.toggle('is-slow', status === 'slow');
  label.textContent = message || (status === 'slow' ? '连接时间较长，请检查网络后重试' : '正在读取库存活动');
  retry.hidden = status !== 'error' && status !== 'slow';
  panel?.setAttribute('aria-busy', String(status === 'loading' || status === 'slow'));
}

function releaseTransactionLoadButtons() {
  $$<HTMLButtonElement>('[data-transaction-load-busy="true"]').forEach((button) => {
    button.disabled = button.dataset.transactionLoadPreviousDisabled === 'true';
    delete button.dataset.transactionLoadBusy;
    delete button.dataset.transactionLoadPreviousDisabled;
  });
}

function cancelTransactionLoad() {
  transactionLoadSequence += 1;
  transactionLoadController?.abort();
  transactionLoadController = null;
  transactionLoadPromise = null;
  recordPageLoadSequence += 1;
  recordPageLoadController?.abort();
  recordPageLoadController = null;
  releaseTransactionLoadButtons();
  setTransactionLoadingState('idle');
}

function recordFilterFrom() {
  const range = $<HTMLSelectElement>('select[data-record-range]')?.value ?? '30';
  if (range === 'all') return '';
  const now = new Date();
  const start = new Date(now);
  if (range === '30' || range === '90') start.setDate(now.getDate() - Number(range));
  if (range === 'year') {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
  }
  return start.toISOString();
}

function currentRecordPageUrl({ cursor = recordCursorHistory[recordPage - 1] ?? '', pageSize = DEFAULT_RECORD_PAGE_SIZE, queryOverride, typeOverride, scopeOverride }: { cursor?: string; pageSize?: number; queryOverride?: string; typeOverride?: string; scopeOverride?: 'all' | 'mine' } = {}) {
  const parameters = new URLSearchParams({
    mode: 'page',
    pageSize: String(pageSize),
    type: typeOverride ?? $<HTMLSelectElement>('select[data-record-type]')?.value ?? 'all',
    scope: scopeOverride ?? recordScope,
  });
  const query = queryOverride ?? $<HTMLInputElement>('[data-filter="records"]')?.value.trim() ?? '';
  if (query) parameters.set('q', query);
  if (queryOverride === undefined && recordFrom) parameters.set('from', recordFrom);
  if (cursor) parameters.set('cursor', cursor);
  return `/api/transactions?${parameters}`;
}

async function loadRecordPage(force = false): Promise<boolean> {
  if (!state) return false;
  if (force) recordPageLoadController?.abort();
  const generation = bootstrapGeneration;
  const sequence = ++recordPageLoadSequence;
  const controller = new AbortController();
  recordPageLoadController?.abort();
  recordPageLoadController = controller;
  const revealTimer = window.setTimeout(() => setTransactionLoadingState('loading'), 150);
  const slowTimer = window.setTimeout(() => setTransactionLoadingState('slow'), 8000);
  try {
    const result = await api<RecordPageResponse>(currentRecordPageUrl(), { signal: controller.signal });
    if (!state || generation !== bootstrapGeneration || sequence !== recordPageLoadSequence) return false;
    recordPageItems = result.items;
    recordTotal = result.total;
    recordHasMore = result.hasMore;
    recordNextCursor = result.nextCursor;
    renderTransactions();
    setTransactionLoadingState('idle');
    return true;
  } catch (failure) {
    if (controller.signal.aborted || sequence !== recordPageLoadSequence) return false;
    const message = (failure as Error).message || '库存活动读取失败';
    setTransactionLoadingState('error', `${message}，请重试`);
    toast(message);
    return false;
  } finally {
    window.clearTimeout(revealTimer);
    window.clearTimeout(slowTimer);
    if (sequence === recordPageLoadSequence) recordPageLoadController = null;
  }
}

const auditActionLabel: Record<string, string> = {
  'settings.update': '修改实验室与品牌设置', 'group.create': '新增组织分组', 'group.update': '修改组织分组', 'group.delete': '删除组织分组',
  'tag.create': '新增成员标签', 'tag.update': '修改成员标签', 'tag.delete': '删除成员标签',
  'material.create': '新增耗材档案', 'material.update': '修改耗材档案', 'material.archive': '归档耗材档案', 'material.restore': '恢复耗材档案', 'material.delete': '永久删除耗材档案',
  'inventory_status.create': '新增库存状态', 'inventory_status.update': '修改库存状态', 'inventory_unit.create': '新增库存单元', 'inventory_unit.archive': '归档库存单元', 'inventory_unit.restore': '恢复库存单元',
  'inventory_anomaly.resolve': '修复库存位置异常', 'user.create': '新增成员账号', 'user.update': '修改成员账号', 'user.delete': '删除成员账号',
  'user.password_reset': '重置成员密码', 'user.enable': '启用成员账号', 'user.disable': '停用成员账号', 'user.group_change': '调整成员分组', 'user.profile_update': '修改管理员个人资料',
  'owner.transfer': '转移系统所有权', 'account.password_change': '修改自己的密码', 'database.backup_download': '下载数据库备份', 'database.restore_authorize': '授权数据库恢复', 'database.restore': '恢复主数据库',
  'stocktake.create': '创建盘点任务', 'stocktake.count_update': '登记盘点数量', 'stocktake.complete': '完成盘点任务', 'stocktake.cancel': '取消盘点任务',
};
const auditTypeLabel: Record<string, string> = { settings: '实验室设置', group: '组织分组', tag: '成员标签', user: '成员与权限', material: '耗材档案', inventory_status: '库存状态', inventory_unit: '库存单元', inventory_anomaly: '异常修复', stocktake: '盘点任务', database: '数据库' };
const auditRoleLabel: Record<string, string> = { owner: '系统所有者', admin: '系统管理员', inventory: '库存管理员', member: '普通成员', system: '系统' };

function auditRangeFrom() {
  const range = $<HTMLSelectElement>('[data-audit-range]')?.value ?? '30';
  if (range === 'all') return '';
  const now = new Date();
  const start = new Date(now);
  if (range === '30' || range === '90') start.setDate(now.getDate() - Number(range));
  if (range === 'year') { start.setMonth(0, 1); start.setHours(0, 0, 0, 0); }
  return start.toISOString();
}

function currentAuditPageUrl({ cursor = auditCursorHistory[auditPage - 1] ?? '', exportAll = false } = {}) {
  const parameters = new URLSearchParams({
    pageSize: String(DEFAULT_RECORD_PAGE_SIZE),
    type: $<HTMLSelectElement>('[data-audit-type]')?.value ?? 'all',
  });
  const query = $<HTMLInputElement>('[data-filter="audit"]')?.value.trim() ?? '';
  const actor = $<HTMLSelectElement>('[data-audit-actor]')?.value ?? 'all';
  const from = auditRangeFrom();
  if (query) parameters.set('q', query);
  if (actor !== 'all') parameters.set('actor', actor);
  if (from) parameters.set('from', from);
  if (cursor && !exportAll) parameters.set('cursor', cursor);
  if (exportAll) parameters.set('mode', 'export');
  return `/api/audit-logs?${parameters}`;
}

function setAuditLoadingState(status: 'idle' | 'loading' | 'error', message = '') {
  const loading = $<HTMLElement>('[data-audit-loading]');
  const label = $('[data-audit-loading-label]');
  const retry = $<HTMLButtonElement>('[data-retry-audit]');
  if (!loading || !label || !retry) return;
  loading.hidden = status === 'idle';
  loading.classList.toggle('has-error', status === 'error');
  label.textContent = message || '正在读取系统审计记录';
  retry.hidden = status !== 'error';
  $('.audit-panel')?.setAttribute('aria-busy', String(status === 'loading'));
}

function renderAuditLogs() {
  const body = $('[data-audit-body]');
  if (!body) return;
  const detailIcon = $('template[data-audit-detail-icon-template]')?.innerHTML ?? '›';
  body.innerHTML = auditPageItems.length ? auditPageItems.map((item) => `
    <tr class="audit-row">
      <td class="audit-cell-time">${escapeHtml(formatExportTime(item.occurredAt))}</td>
      <td class="audit-cell-actor"><span class="audit-primary">${escapeHtml(item.actorName)}</span><span class="audit-secondary">${escapeHtml(auditRoleLabel[item.actorRole] ?? item.actorRole)}</span></td>
      <td class="audit-cell-action"><span class="audit-primary">${escapeHtml(auditActionLabel[item.action] ?? item.action)}</span><span class="audit-secondary">${escapeHtml(item.summary)}</span></td>
      <td class="audit-cell-target"><span class="audit-primary">${escapeHtml(item.targetName || auditTypeLabel[item.targetType] || item.targetType)}</span><span class="audit-secondary">${escapeHtml(auditTypeLabel[item.targetType] ?? item.targetType)}</span></td>
      <td class="audit-cell-source"><span class="audit-primary">${escapeHtml(item.sourceIp || '-')}</span><span class="audit-secondary">${escapeHtml(item.requestId.slice(0, 8))}</span></td>
      <td class="audit-cell-detail"><button class="icon-button" type="button" title="查看审计详情" aria-label="查看审计详情" data-audit-detail="${escapeHtml(item.id)}">${detailIcon}</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty-note">没有符合条件的审计记录</td></tr>';
  const pagination = $<HTMLElement>('[data-audit-pagination]');
  const range = $('[data-audit-page-range]');
  const page = $('[data-audit-page-label]');
  const previous = $<HTMLButtonElement>('[data-audit-page-previous]');
  const next = $<HTMLButtonElement>('[data-audit-page-next]');
  const from = auditTotal ? (auditPage - 1) * DEFAULT_RECORD_PAGE_SIZE + 1 : 0;
  const to = auditTotal ? from + auditPageItems.length - 1 : 0;
  const totalPages = Math.max(1, Math.ceil(auditTotal / DEFAULT_RECORD_PAGE_SIZE));
  if (pagination) pagination.hidden = auditTotal === 0;
  if (range) range.textContent = `第 ${from}–${to} 条，共 ${auditTotal} 条`;
  if (page) page.textContent = `第 ${auditPage} / ${totalPages} 页`;
  if (previous) previous.disabled = auditPage <= 1;
  if (next) next.disabled = !auditHasMore;
}

async function loadAuditPage(force = false) {
  if (!state || state.user.role !== 'admin') return false;
  if (force) auditLoadController?.abort();
  const sequence = ++auditLoadSequence;
  const controller = new AbortController();
  auditLoadController?.abort();
  auditLoadController = controller;
  const revealTimer = window.setTimeout(() => setAuditLoadingState('loading'), 120);
  try {
    const result = await api<AuditPageResponse>(currentAuditPageUrl(), { signal: controller.signal });
    if (sequence !== auditLoadSequence) return false;
    auditPageItems = result.items;
    auditTotal = result.total;
    auditHasMore = result.hasMore;
    auditNextCursor = result.nextCursor;
    renderAuditLogs();
    setAuditLoadingState('idle');
    return true;
  } catch (failure) {
    if (controller.signal.aborted || sequence !== auditLoadSequence) return false;
    setAuditLoadingState('error', `${(failure as Error).message || '审计记录读取失败'}，请重试`);
    return false;
  } finally {
    window.clearTimeout(revealTimer);
    if (sequence === auditLoadSequence) auditLoadController = null;
  }
}

function auditSnapshotRows(snapshot: Record<string, unknown> | null) {
  if (!snapshot || !Object.keys(snapshot).length) return '<p class="empty-note">未保存内容快照</p>';
  const fieldLabels: Record<string, string> = {
    appName: '系统显示名称', labName: '实验室名称', customIcon: '自定义图标', name: '名称', username: '登录账号', note: '备注', role: '身份',
    groupId: '组织分组 ID', tagIds: '成员标签 ID', active: '启用状态', isOwner: '系统所有者', category: '分类', safetyStock: '安全库存', expiryWarningDays: '临期提醒提前天数', unit: '单位', spec: '规格 / 型号',
    trackingMode: '库存管理方式', positionCodeHelp: '格位填写说明', usageContextHelp: '用途填写说明', isDefault: '默认分组', materialId: '耗材 ID', code: '状态代码',
    usable: '可用', terminal: '终止不可用', sortOrder: '排序', unitType: '单元类型', label: '盒号 / 批次', positionCode: '位置编号', capacity: '容量',
    inventoryUnitId: '库存单元 ID', fromPositionCode: '原位置', toPositionCode: '新位置', resolved: '已修复', eventId: '库存事件 ID', schemaVersion: '数据库结构版本',
    users: '成员数量', materials: '耗材数量', transactions: '流水数量', status: '任务状态', category: '盘点范围', scope: '盘点范围', itemCount: '盘点项目数',
    itemId: '盘点明细 ID', expectedQuantity: '账面数量', countedQuantity: '实盘数量', reason: '差异原因', resolutionNote: '处理说明', differenceCount: '差异项目数', adjustmentTransactionIds: '调整流水 ID', cancellationReason: '取消原因',
  };
  const formatValue = (value: unknown) => Array.isArray(value) ? value.join('、') : typeof value === 'object' && value !== null ? JSON.stringify(value) : value === true ? '是' : value === false ? '否' : String(value ?? '-');
  return Object.entries(snapshot).map(([key, value]) => `<div class="audit-snapshot-row"><span>${escapeHtml(fieldLabels[key] ?? key)}</span><strong>${escapeHtml(formatValue(value))}</strong></div>`).join('');
}

function openAuditDetail(item: AuditLog) {
  const set = (selector: string, value: string) => { const node = $(selector); if (node) node.textContent = value; };
  set('[data-audit-detail-title]', auditActionLabel[item.action] ?? item.action);
  set('[data-audit-detail-time]', formatExportTime(item.occurredAt));
  set('[data-audit-detail-actor]', `${item.actorName} · ${auditRoleLabel[item.actorRole] ?? item.actorRole}`);
  set('[data-audit-detail-target]', `${auditTypeLabel[item.targetType] ?? item.targetType}${item.targetName ? ` · ${item.targetName}` : ''}`);
  set('[data-audit-detail-source]', item.sourceIp || '-');
  set('[data-audit-detail-summary]', item.summary);
  set('[data-audit-detail-request]', item.requestId);
  const before = $('[data-audit-detail-before]');
  const after = $('[data-audit-detail-after]');
  if (before) before.innerHTML = auditSnapshotRows(item.before);
  if (after) after.innerHTML = auditSnapshotRows(item.after);
  openModal(auditDetailModal);
}

const stocktakeStatusLabel: Record<StocktakeStatus, string> = { open: '未完成', completed: '已完成', cancelled: '已取消' };
const stocktakeStatusClass: Record<StocktakeStatus, string> = { open: 'ok', completed: 'ok', cancelled: 'archived' };
const stocktakeQuantitiesEqual = (left: number | null, right: number | null) => left !== null && right !== null && Math.abs(left - right) <= 1e-9;

function updateStocktakeSummary(detail: StocktakeDetail) {
  const summary: Stocktake = { ...detail };
  delete (summary as Partial<StocktakeDetail>).items;
  const index = stocktakes.findIndex((item) => item.id === detail.id);
  if (index >= 0) stocktakes[index] = summary;
  else stocktakes.unshift(summary);
}

function setStocktakeView(view: 'list' | 'detail') {
  const list = $<HTMLElement>('[data-stocktake-list-view]');
  const detail = $<HTMLElement>('[data-stocktake-detail-view]');
  const back = $<HTMLButtonElement>('[data-stocktake-back]');
  const title = $('[data-stocktake-title]');
  const subtitle = $('[data-stocktake-subtitle]');
  if (list) list.hidden = view !== 'list';
  if (detail) detail.hidden = view !== 'detail';
  if (back) back.hidden = view !== 'detail';
  if (view === 'list') {
    if (title) title.textContent = '盘点任务';
    if (subtitle) subtitle.textContent = '按批次复核账面库存与实盘数量';
  }
  stocktakeModal?.querySelector<HTMLElement>('.modal-body')?.scrollTo({ top: 0 });
}

function renderStocktakeList() {
  const list = $('[data-stocktake-list]');
  if (!list) return;
  $$<HTMLButtonElement>('[data-stocktake-filter]').forEach((button) => {
    const active = button.dataset.stocktakeFilter === stocktakeFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const visible = stocktakes.filter((item) => stocktakeFilter === 'all' || item.status === stocktakeFilter);
  const nextIcon = document.querySelector('[data-transaction-next-icon-template]')?.innerHTML ?? '';
  list.innerHTML = visible.length ? visible.map((item) => {
    const progress = item.itemCount ? Math.round((item.countedCount / item.itemCount) * 100) : 0;
    const completion = item.status === 'completed'
      ? `${item.completedByName || '管理员'}完成 · ${formatExportTime(item.completedAt)}`
      : item.status === 'cancelled'
        ? `${item.cancelledByName || '管理员'}取消 · ${formatExportTime(item.cancelledAt)}`
        : `${item.countedCount} / ${item.itemCount} 项已盘`;
    const difference = item.differenceCount ? ` · ${item.differenceCount} 项差异` : '';
    return `<button class="stocktake-batch-row" type="button" data-stocktake-open="${escapeHtml(item.id)}">
      <span class="stocktake-batch-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.createdByName)}创建 · ${escapeHtml(formatExportTime(item.createdAt))}</small></span>
      <span class="stocktake-batch-progress"><span class="stocktake-progress-track"><span style="width:${progress}%"></span></span><small>${escapeHtml(completion)}${escapeHtml(difference)}</small></span>
      <span class="status-chip ${stocktakeStatusClass[item.status]}">${stocktakeStatusLabel[item.status]}</span>
      <span class="icon-button" aria-hidden="true">${nextIcon}</span>
    </button>`;
  }).join('') : `<p class="stocktake-empty">${stocktakeFilter === 'open' ? '没有未完成的盘点任务' : '没有符合条件的盘点任务'}</p>`;
}

function stocktakeDetailBlockers(detail: StocktakeDetail) {
  if (detail.status !== 'open') return [];
  const uncounted = detail.items.filter((item) => item.countedQuantity === null);
  const trackedUnresolved = detail.items.filter((item) => item.scopeType === 'inventory_unit' && item.countedQuantity !== null && !stocktakeQuantitiesEqual(item.currentQuantity, item.countedQuantity));
  const staleOrdinary = detail.items.filter((item) => item.scopeType === 'material' && !stocktakeQuantitiesEqual(item.currentQuantity, item.expectedQuantity));
  const missingTrackedNotes = detail.items.filter((item) => item.scopeType === 'inventory_unit' && item.countedQuantity !== null && !stocktakeQuantitiesEqual(item.countedQuantity, item.expectedQuantity) && !item.resolutionNote);
  const blockers = [];
  if (uncounted.length) blockers.push(`还有 ${uncounted.length} 项未登记实盘数量`);
  if (trackedUnresolved.length) blockers.push(`还有 ${trackedUnresolved.length} 个库存单元需先在库存明细中修正`);
  if (missingTrackedNotes.length) blockers.push(`还有 ${missingTrackedNotes.length} 个差异库存单元未填写处理说明`);
  if (staleOrdinary.length) blockers.push(`${staleOrdinary.length} 项普通耗材在盘点期间发生了库存变化，需取消后重建任务`);
  return blockers;
}

function renderStocktakeDetail() {
  if (!stocktakeDetail) return;
  const detail = stocktakeDetail;
  const setText = (selector: string, value: string) => { const node = $(selector); if (node) node.textContent = value; };
  const title = $('[data-stocktake-title]');
  const subtitle = $('[data-stocktake-subtitle]');
  if (title) title.textContent = detail.title;
  if (subtitle) subtitle.textContent = detail.status === 'cancelled' && detail.cancellationReason
    ? `已取消：${detail.cancellationReason}`
    : detail.status === 'completed'
      ? `${detail.completedByName}于 ${formatExportTime(detail.completedAt)} 完成`
      : '逐项登记现场实盘结果，完成后固化差异处理记录';
  setText('[data-stocktake-detail-status]', stocktakeStatusLabel[detail.status]);
  setText('[data-stocktake-detail-progress]', `${detail.countedCount} / ${detail.itemCount} 项`);
  setText('[data-stocktake-detail-differences]', `${detail.differenceCount} 项${detail.adjustmentCount ? ` · ${detail.adjustmentCount} 笔调整` : ''}`);
  setText('[data-stocktake-detail-created]', `${detail.createdByName} · ${formatExportTime(detail.createdAt)}`);

  const search = $<HTMLInputElement>('[data-stocktake-item-search]')?.value.trim().toLowerCase() ?? '';
  const filter = $<HTMLSelectElement>('[data-stocktake-item-filter]')?.value ?? 'all';
  const items = detail.items.filter((item) => {
    const difference = item.countedQuantity !== null && !stocktakeQuantitiesEqual(item.countedQuantity, item.expectedQuantity);
    if (filter === 'pending' && item.countedQuantity !== null) return false;
    if (filter === 'difference' && !difference) return false;
    if (filter === 'tracked' && item.scopeType !== 'inventory_unit') return false;
    return !search || `${item.materialName} ${item.inventoryUnitLabel}`.toLowerCase().includes(search);
  });
  const itemList = $('[data-stocktake-item-list]');
  const countIcon = document.querySelector('[data-stocktake-count-icon-template]')?.innerHTML ?? document.querySelector('[data-inventory-save-icon-template]')?.innerHTML ?? '';
  const inventoryIcon = document.querySelector('[data-inventory-register-icon-template]')?.innerHTML ?? '';
  if (itemList) itemList.innerHTML = items.length ? items.map((item) => {
    const counted = item.countedQuantity;
    const difference = counted !== null && !stocktakeQuantitiesEqual(counted, item.expectedQuantity);
    const variance = counted === null ? null : counted - item.expectedQuantity;
    const unitName = item.inventoryUnitLabel || (item.scopeType === 'material' ? '普通数量库存' : '库存单元');
    const notes = [];
    if (counted === null) notes.push('尚未登记实盘数量');
    if (item.reason) notes.push(`原因：${item.reason}`);
    if (item.resolutionNote) notes.push(`处理：${item.resolutionNote}`);
    if (item.scopeType === 'inventory_unit' && counted !== null && !stocktakeQuantitiesEqual(item.currentQuantity, counted)) notes.push(`当前系统仍为 ${formatNumber(item.currentQuantity ?? 0)} ${item.materialUnit}，需逐根修正`);
    if (item.adjustmentTransactionId) notes.push(`已生成库存调整流水 ${item.adjustmentTransactionId.slice(0, 8)}`);
    const action = detail.status === 'open'
      ? `<div class="stocktake-item-action"><button class="icon-button" type="button" title="登记实盘数量" aria-label="登记 ${escapeHtml(item.materialName)} 的实盘数量" data-stocktake-count-item="${escapeHtml(item.id)}">${countIcon}</button>${item.scopeType === 'inventory_unit' ? `<button class="icon-button" type="button" title="打开库存明细" aria-label="打开 ${escapeHtml(item.materialName)} ${escapeHtml(item.inventoryUnitLabel)} 的库存明细" data-stocktake-open-unit="${escapeHtml(item.inventoryUnitId)}">${inventoryIcon}</button>` : ''}</div>`
      : '<span class="stocktake-item-action"></span>';
    return `<div class="stocktake-item-row${counted === null ? ' is-pending' : difference ? ' is-difference' : ''}">
      <div class="stocktake-item-identity"><strong>${escapeHtml(item.materialName)}</strong><small>${escapeHtml(unitName)}</small></div>
      <div class="stocktake-item-metric expected"><span>账面</span><strong>${formatNumber(item.expectedQuantity)} ${escapeHtml(item.materialUnit)}</strong></div>
      <div class="stocktake-item-metric counted"><span>实盘</span><strong>${counted === null ? '未盘' : `${formatNumber(counted)} ${escapeHtml(item.materialUnit)}`}</strong></div>
      <div class="stocktake-item-metric variance"><span>差异</span><strong class="${difference ? 'difference' : ''}">${variance === null ? '-' : variance === 0 ? '一致' : `${variance > 0 ? '+' : ''}${formatNumber(variance)}`}</strong></div>
      ${action}<div class="stocktake-item-note">${escapeHtml(notes.join('；') || '账实一致')}</div>
    </div>`;
  }).join('') : '<p class="stocktake-empty">没有符合筛选条件的盘点明细</p>';

  const blockers = stocktakeDetailBlockers(detail);
  const differences = detail.items.filter((item) => item.countedQuantity !== null && !stocktakeQuantitiesEqual(item.countedQuantity, item.expectedQuantity));
  const ordinaryDifferenceCount = differences.filter((item) => item.scopeType === 'material').length;
  const trackedDifferenceCount = differences.filter((item) => item.scopeType === 'inventory_unit').length;
  const readyMessage = ordinaryDifferenceCount && trackedDifferenceCount
    ? '所有追踪库存差异已逐单元修正；完成后，普通耗材差异会生成不可变调整流水。'
    : trackedDifferenceCount
      ? '所有追踪库存差异已逐单元修正，可以完成盘点。'
      : ordinaryDifferenceCount
        ? '所有项目已复核；完成后，普通耗材差异会生成不可变调整流水。'
        : '所有项目账实一致，可以完成盘点。';
  const readiness = $('[data-stocktake-readiness]');
  if (readiness) {
    readiness.classList.toggle('warning', blockers.length > 0);
    const label = $('span', readiness);
    if (label) label.textContent = detail.status === 'completed'
      ? `盘点已完成${detail.adjustmentCount ? `，生成 ${detail.adjustmentCount} 笔库存调整流水` : trackedDifferenceCount ? '，追踪库存差异已逐单元修正' : '，账实一致'}`
      : detail.status === 'cancelled'
        ? `任务已取消：${detail.cancellationReason}`
        : blockers.length ? blockers.join('；') : readyMessage;
  }
  const cancel = $<HTMLButtonElement>('[data-stocktake-cancel]');
  const complete = $<HTMLButtonElement>('[data-stocktake-complete]');
  if (cancel) cancel.hidden = detail.status !== 'open';
  if (complete) {
    complete.hidden = detail.status !== 'open';
    complete.disabled = blockers.length > 0;
  }
}

async function loadStocktakes() {
  const list = $('[data-stocktake-list]');
  if (list) list.innerHTML = '<p class="stocktake-empty">正在读取盘点任务</p>';
  try {
    const result = await api<{ stocktakes: Stocktake[] }>('/api/stocktakes');
    stocktakes = result.stocktakes;
    renderStocktakeList();
  } catch (failure) {
    if (list) list.innerHTML = `<p class="stocktake-empty">${escapeHtml((failure as Error).message || '盘点任务读取失败')}</p>`;
    toast((failure as Error).message || '盘点任务读取失败');
  }
}

async function openStocktakeDetail(stocktakeId: string) {
  const search = $<HTMLInputElement>('[data-stocktake-item-search]');
  const filter = $<HTMLSelectElement>('[data-stocktake-item-filter]');
  if (search) search.value = '';
  if (filter) {
    filter.value = 'all';
    refreshM3Select(filter);
  }
  setStocktakeView('detail');
  stocktakeDetail = null;
  const itemList = $('[data-stocktake-item-list]');
  if (itemList) itemList.innerHTML = '<p class="stocktake-empty">正在读取盘点明细</p>';
  try {
    const result = await api<{ stocktake: StocktakeDetail }>(`/api/stocktakes/${encodeURIComponent(stocktakeId)}`);
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    renderStocktakeDetail();
  } catch (failure) {
    toast((failure as Error).message || '盘点明细读取失败');
    setStocktakeView('list');
    renderStocktakeList();
  }
}

function openStocktakeSubdialog(modal: Element | null) {
  closeM3Menus();
  bringModalToFront(modal);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => modal?.querySelector<HTMLElement>('input, textarea, .m3-select-trigger, button')?.focus());
}

function closeStocktakeSubdialog(modal?: Element | null) {
  hideModal(modal ?? $('.stocktake-subdialog.open'));
  closeM3Menus();
  document.body.classList.toggle('modal-open', Boolean($('.modal-backdrop.open')));
}

function stocktakeEligibleMaterials() {
  if (!state) return [];
  return state.materials.filter((material) => material.active && (
    material.trackingMode === 'quantity'
    || (state?.inventorySummaries.find((summary) => summary.materialId === material.id)?.activeUnitCount ?? 0) > 0
  ));
}

function currentStocktakeScopeMode(): StocktakeScopeMode {
  return ($<HTMLButtonElement>('[data-stocktake-scope-mode].active')?.dataset.stocktakeScopeMode as StocktakeScopeMode) ?? 'all';
}

function setStocktakeScopeMode(mode: StocktakeScopeMode) {
  $$<HTMLButtonElement>('[data-stocktake-scope-mode]').forEach((button) => {
    const active = button.dataset.stocktakeScopeMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const categoryField = $<HTMLElement>('[data-stocktake-category-field]');
  const materialField = $<HTMLElement>('[data-stocktake-material-field]');
  const category = $<HTMLSelectElement>('[data-stocktake-create-category]');
  const material = $<HTMLInputElement>('#stocktake-create-material');
  if (categoryField) categoryField.hidden = mode !== 'category';
  if (materialField) materialField.hidden = mode !== 'material';
  if (category) {
    category.disabled = mode !== 'category';
    category.required = mode === 'category';
    refreshM3Select(category);
  }
  if (material) {
    material.disabled = mode !== 'material';
    material.required = mode === 'material';
    material.setCustomValidity('');
  }
  closeM3Menus();
}

function syncStocktakeCreateOptions() {
  const select = $<HTMLSelectElement>('[data-stocktake-create-category]');
  const datalist = $<HTMLDataListElement>('[data-stocktake-create-material-options]');
  if (!select || !datalist || !state) return;
  const materials = stocktakeEligibleMaterials()
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true }));
  const categories = [...new Set(materials.filter((material) => material.category).map((material) => material.category))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
  select.innerHTML = `<option value="">请选择分类</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')}`;
  select.value = '';
  refreshM3Select(select);
  datalist.innerHTML = materials.map((material) => {
    const meta = [material.category || '未分类', material.spec].filter(Boolean).join(' · ');
    return `<option value="${escapeHtml(material.name)}" label="${escapeHtml(meta)}"></option>`;
  }).join('');
}

function openStocktakeCreate() {
  const form = $<HTMLFormElement>('[data-stocktake-create-form]');
  form?.reset();
  const name = $<HTMLInputElement>('#stocktake-create-name');
  if (name) name.value = `${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date())}盘点`;
  syncStocktakeCreateOptions();
  setStocktakeScopeMode('all');
  openStocktakeSubdialog(stocktakeCreateModal);
}

function syncStocktakeCountDifference() {
  if (!stocktakeCountTarget) return;
  const input = $<HTMLInputElement>('#stocktake-counted-quantity');
  const reasonField = $<HTMLElement>('[data-stocktake-reason-field]');
  const reason = $<HTMLTextAreaElement>('#stocktake-difference-reason');
  const resolution = $<HTMLTextAreaElement>('#stocktake-resolution-note');
  const resolutionLabel = $('[data-stocktake-resolution-label]');
  const guidance = $<HTMLElement>('[data-stocktake-tracked-guidance]');
  const inventoryButton = $<HTMLButtonElement>('[data-stocktake-open-inventory-detail]');
  const value = input?.value.trim() ?? '';
  const counted = value === '' ? null : Number(value);
  const difference = counted !== null && Number.isFinite(counted) && !stocktakeQuantitiesEqual(counted, stocktakeCountTarget.expectedQuantity);
  const trackedDifference = stocktakeCountTarget.scopeType === 'inventory_unit' && difference;
  if (reasonField) reasonField.hidden = !difference;
  if (reason) reason.required = difference;
  if (resolution) resolution.required = trackedDifference;
  if (resolutionLabel) resolutionLabel.textContent = trackedDifference ? '处理说明' : '处理说明（选填）';
  if (guidance) guidance.hidden = !trackedDifference;
  if (inventoryButton) inventoryButton.hidden = stocktakeCountTarget.scopeType !== 'inventory_unit';
}

function openStocktakeCount(itemId: string) {
  const item = stocktakeDetail?.items.find((candidate) => candidate.id === itemId);
  if (!item || stocktakeDetail?.status !== 'open') return;
  stocktakeCountTarget = item;
  const setText = (selector: string, value: string) => { const node = $(selector); if (node) node.textContent = value; };
  setText('[data-stocktake-count-title]', item.materialName);
  setText('[data-stocktake-count-subtitle]', item.inventoryUnitLabel || '登记普通数量库存实盘结果');
  setText('[data-stocktake-count-expected]', `${formatNumber(item.expectedQuantity)} ${item.materialUnit}`);
  setText('[data-stocktake-count-current]', item.currentQuantity === null ? '不可用' : `${formatNumber(item.currentQuantity)} ${item.materialUnit}`);
  setText('[data-stocktake-count-scope]', item.scopeType === 'inventory_unit' ? '库存单元 / 盒' : '普通数量');
  const counted = $<HTMLInputElement>('#stocktake-counted-quantity');
  const reason = $<HTMLTextAreaElement>('#stocktake-difference-reason');
  const resolution = $<HTMLTextAreaElement>('#stocktake-resolution-note');
  if (counted) counted.value = item.countedQuantity === null ? '' : String(item.countedQuantity);
  if (reason) reason.value = item.reason;
  if (resolution) resolution.value = item.resolutionNote;
  syncStocktakeCountDifference();
  openStocktakeSubdialog(stocktakeCountModal);
}

async function refreshOpenStocktakeDetail() {
  if (!stocktakeDetail) return;
  await openStocktakeDetail(stocktakeDetail.id);
}

async function ensureExportRecordsLoaded(force = false): Promise<boolean> {
  if (!state) return false;
  if (!force && exportSnapshot) return true;
  if (transactionLoadPromise && !force) return transactionLoadPromise;
  if (force) transactionLoadController?.abort();
  const generation = bootstrapGeneration;
  const sequence = ++transactionLoadSequence;
  const controller = new AbortController();
  transactionLoadController = controller;
  let revealTimer = window.setTimeout(() => setTransactionLoadingState('loading'), 200);
  let slowTimer = window.setTimeout(() => setTransactionLoadingState('slow'), 8000);
  const downloadButtons = $$<HTMLButtonElement>('[data-download-records], [data-download-inventory]');
  downloadButtons.forEach((button) => {
    if (button.dataset.transactionLoadBusy !== 'true') {
      button.dataset.transactionLoadBusy = 'true';
      button.dataset.transactionLoadPreviousDisabled = String(button.disabled);
    }
    button.disabled = true;
  });
  const loadPromise = (async () => {
    try {
      const result = await api<ExportSnapshot>('/api/transactions?mode=export', { signal: controller.signal });
      if (!state || generation !== bootstrapGeneration || sequence !== transactionLoadSequence) return false;
      exportSnapshot = result;
      setTransactionLoadingState('idle');
      return true;
    } catch (failure) {
      if (controller.signal.aborted || sequence !== transactionLoadSequence) return false;
      const message = (failure as Error).message || '完整流水加载失败';
      setTransactionLoadingState('error', `${message}，请重试`);
      toast(message);
      return false;
    } finally {
      window.clearTimeout(revealTimer);
      window.clearTimeout(slowTimer);
      revealTimer = 0;
      slowTimer = 0;
      if (sequence === transactionLoadSequence) {
        releaseTransactionLoadButtons();
        transactionLoadController = null;
        transactionLoadPromise = null;
      }
    }
  })();
  transactionLoadPromise = loadPromise;
  return loadPromise;
}

function renderNotifications() {
  const lowMaterials = lowStockMaterials();
  const expiryAlerts = state?.expiryAlerts ?? [];
  const warningMaterialIds = new Set([...lowMaterials.map((material) => material.id), ...expiryAlerts.map((alert) => alert.materialId)]);
  $('[data-notification-dot]')?.classList.toggle('is-hidden', warningMaterialIds.size === 0);
  const count = $('[data-low-stock-count]');
  if (count) count.textContent = String(state?.stats.warningCount ?? warningMaterialIds.size);
  const notice = $('[data-low-stock-notice]');
  if (notice) notice.textContent = warningMaterialIds.size ? `${warningMaterialIds.size} 个品类需要关注库存或有效期。` : '当前没有库存或有效期预警。';
  const sidebarNote = $('[data-sidebar-stock-note]');
  if (sidebarNote) sidebarNote.textContent = warningMaterialIds.size ? `${warningMaterialIds.size} 个品类需要关注库存或有效期。` : '库存与有效期均无预警。';
  const list = $('[data-notification-list]');
  if (!list) return;
  const lowItems = lowMaterials.map((material) => {
    const out = material.availableQuantity === 0;
    return `<div class="notification-item"><span>${escapeHtml(initial(material.name))}</span><div><strong>${escapeHtml(material.name)}</strong><small>${out ? '开放库存已耗尽' : `低于安全库存 ${formatNumber(material.safetyStock)} ${escapeHtml(material.unit)}`}</small></div><b>${out ? '缺货' : `${formatNumber(material.availableQuantity)} ${escapeHtml(material.unit)}`}</b></div>`;
  });
  const expiryItems = expiryAlerts.map((alert) => `<div class="notification-item expiry-${escapeHtml(alert.status)}"><span>${escapeHtml(initial(alert.materialName))}</span><div><strong>${escapeHtml(alert.materialName)} · ${escapeHtml(alert.inventoryUnitLabel)}</strong><small>${escapeHtml(alert.status === 'expired' ? '已过期，不能领用；请登记处置' : `即将到期 · ${alert.expiryDate}（剩 ${alert.daysRemaining} 天）`)}</small></div><b>${formatNumber(alert.quantity)} ${escapeHtml(alert.unit)}</b></div>`);
  list.innerHTML = [...expiryItems, ...lowItems].join('') || '<div class="empty-note">当前没有库存或有效期预警</div>';
}

function renderDashboard() {
  if (!state) return;
  $('[data-stat-items]')!.textContent = formatNumber(state.stats.items);
  $('[data-stat-low]')!.textContent = formatNumber(state.stats.lowStock);
  $('[data-stat-in]')!.textContent = formatNumber(state.stats.monthInRecords);
  $('[data-stat-out]')!.textContent = formatNumber(state.stats.monthOutRecords);
  $('[data-stat-items-meta]')!.textContent = `${formatNumber(state.stats.categories)} 个分类`;
  $('[data-stat-low-meta]')!.textContent = `${formatNumber(state.stats.normalStock)} 种库存正常`;
  $('[data-stat-in-meta]')!.textContent = `涉及 ${formatNumber(state.stats.monthInMaterials)} 种耗材`;
  $('[data-stat-out-meta]')!.textContent = `涉及 ${formatNumber(state.stats.monthOutMaterials)} 种耗材`;
  const greeting = $('[data-dashboard-greeting]');
  const hour = new Date().getHours();
  const greetingText = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  if (greeting) greeting.textContent = `${greetingText}，${state.user.name}。这里是${state.settings.labName}的实时库存情况。`;
  const bars = $('[data-trend-bars]');
  if (!bars) return;
  const maximum = Math.max(1, ...state.trend.flatMap((point) => [point.in, point.out]));
  bars.innerHTML = state.trend.map((point) => {
    const inHeight = point.in ? Math.max(4, Math.round(point.in / maximum * 100)) : 1;
    const outHeight = point.out ? Math.max(4, Math.round(point.out / maximum * 100)) : 1;
    return `<div class="bar-group"><span class="bar${point.in ? '' : ' zero'}" style="height:${inHeight}%" title="${escapeHtml(point.label)}入库 ${formatNumber(point.in)} 笔"><span class="sr-only">${escapeHtml(point.label)}入库 ${formatNumber(point.in)} 笔</span></span><span class="bar out${point.out ? '' : ' zero'}" style="height:${outHeight}%" title="${escapeHtml(point.label)}出库 ${formatNumber(point.out)} 笔"><span class="sr-only">${escapeHtml(point.label)}出库 ${formatNumber(point.out)} 笔</span></span><small class="bar-label">${escapeHtml(point.label)}</small></div>`;
  }).join('');
}

function renderGroups() {
  if (!state) return;
  ensureOrganizationSettingsTabs();
  const settingsCount = $('[data-groups-settings-count]');
  if (settingsCount) settingsCount.textContent = String(state.groups.length);
  const settingsTab = $<HTMLButtonElement>('[data-organization-settings-tab="groups"]');
  settingsTab?.setAttribute('aria-label', `组织分组，${state.groups.length} 项`);
  const defaultGroup = state.groups.find((group) => group.isDefault) ?? state.groups[0];
  const selects = $$<HTMLSelectElement>('[data-group-select]');
  selects.forEach((select) => {
    const currentValue = select.value;
    select.innerHTML = state!.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}${group.isDefault ? '（默认）' : ''}</option>`).join('');
    select.value = state!.groups.some((group) => group.id === currentValue) ? currentValue : defaultGroup?.id ?? '';
    refreshM3Select(select);
  });
  const groupFilter = $<HTMLSelectElement>('[data-member-group-filter]');
  if (groupFilter) {
    const currentValue = groupFilter.value;
    groupFilter.innerHTML = `<option value="all">全部分组</option>${state.groups.map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(group.name)}</option>`).join('')}`;
    groupFilter.value = state.groups.some((group) => group.id === currentValue) ? currentValue : 'all';
    refreshM3Select(groupFilter);
  }
  const list = $('[data-groups-settings-list]');
  const template = $<HTMLTemplateElement>('[data-group-row-template]');
  if (!list || !template) return;
  const fragment = document.createDocumentFragment();
  state.groups.forEach((group) => {
    const row = template.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
    if (!row) return;
    row.dataset.groupId = group.id;
    const name = $<HTMLInputElement>('[data-group-name]', row)!;
    name.value = group.name;
    const memberCount = state!.members.filter((member) => member.groupId === group.id).length;
    $('[data-group-meta]', row)!.textContent = `${memberCount} 位成员${group.isDefault ? ' · 默认组' : ''}`;
    const defaultChip = $('[data-group-default-chip]', row);
    defaultChip?.classList.toggle('is-hidden', !group.isDefault);
    const defaultButton = $<HTMLButtonElement>('[data-set-default-group]', row)!;
    defaultButton.disabled = group.isDefault;
    defaultButton.title = group.isDefault ? '当前默认组' : '设为默认组';
    const deleteButton = $<HTMLButtonElement>('[data-delete-group]', row)!;
    deleteButton.disabled = state!.groups.length <= 1 || memberCount > 0;
    deleteButton.title = state!.groups.length <= 1 ? '至少需要保留一个分组' : memberCount > 0 ? '请先将成员移动到其他分组' : '删除分组';
    fragment.append(row);
  });
  list.replaceChildren(fragment);
}

function renderTagPicker(name: 'member' | 'member-action' | 'profile', selectedIds: string[] = []) {
  const root = $<HTMLElement>(`[data-tag-picker="${name}"]`);
  if (!root || !state) return;
  const selected = new Set(selectedIds);
  root.innerHTML = state.tags.length
    ? state.tags.map((tag) => `<label class="tag-choice"><input type="checkbox" value="${escapeHtml(tag.id)}" ${selected.has(tag.id) ? 'checked' : ''} /><span>${escapeHtml(tag.name)}</span></label>`).join('')
    : '<span class="tag-picker-empty">尚未创建成员标签</span>';
}

function selectedTagIds(name: 'member' | 'member-action' | 'profile') {
  return $$<HTMLInputElement>(`[data-tag-picker="${name}"] input:checked`).map((input) => input.value);
}

function renderTags() {
  if (!state) return;
  ensureOrganizationSettingsTabs();
  const settingsCount = $('[data-tags-settings-count]');
  if (settingsCount) settingsCount.textContent = String(state.tags.length);
  const settingsTab = $<HTMLButtonElement>('[data-organization-settings-tab="tags"]');
  settingsTab?.setAttribute('aria-label', `成员标签，${state.tags.length} 项`);
  const tagFilter = $<HTMLSelectElement>('[data-member-tag-filter]');
  if (tagFilter) {
    const currentValue = tagFilter.value;
    tagFilter.innerHTML = `<option value="all">全部标签</option>${state.tags.map((tag) => `<option value="${escapeHtml(tag.id)}">${escapeHtml(tag.name)}</option>`).join('')}`;
    tagFilter.value = state.tags.some((tag) => tag.id === currentValue) ? currentValue : 'all';
    refreshM3Select(tagFilter);
  }

  const list = $('[data-tags-settings-list]');
  const template = $<HTMLTemplateElement>('[data-tag-row-template]');
  if (list && template) {
    const fragment = document.createDocumentFragment();
    state.tags.forEach((tag) => {
      const row = template.content.firstElementChild?.cloneNode(true) as HTMLElement | undefined;
      if (!row) return;
      row.dataset.tagId = tag.id;
      const name = $<HTMLInputElement>('[data-tag-name]', row)!;
      name.value = tag.name;
      const memberCount = state!.members.filter((member) => member.tagIds.includes(tag.id)).length;
      $('[data-tag-meta]', row)!.textContent = `${memberCount} 位成员`;
      fragment.append(row);
    });
    list.replaceChildren(fragment);
  }

  renderTagPicker('profile', state.user.tagIds);
  renderTagPicker('member');
  const actionMember = state.members.find((member) => member.id === memberActionTargetId);
  renderTagPicker('member-action', actionMember?.tagIds ?? []);
}

function renderDirectory() {
  if (!state) return;
  const body = $('[data-directory-body]');
  if (!body) return;
  const isAdminDirectory = canManageMembers(state.user);
  const members = isAdminDirectory ? state.members : state.directory;
  const memberActionIcon = $<HTMLTemplateElement>('[data-member-action-icon-template]')?.innerHTML ?? '';
  const description = $('[data-directory-description]');
  if (description) description.textContent = isAdminDirectory
    ? '公开备注、账号状态与管理操作集中在同一份目录中。'
    : '所有启用中的成员都可以查看负责范围和联系方式。';
  const count = $('[data-directory-count]');
  if (count) {
    const activeCount = members.filter((member) => 'active' in member && member.active).length;
    count.textContent = isAdminDirectory
      ? mobileDrawerMedia.matches ? `${activeCount} / ${members.length} 位` : `${activeCount} 位可登录 · 共 ${members.length} 位`
      : `共 ${members.length} 位`;
    count.title = isAdminDirectory ? `${activeCount} 位可登录，共 ${members.length} 位成员` : `共 ${members.length} 位成员`;
  }
  body.innerHTML = members.length ? members.map((member) => {
    const roleClass = member.isOwner ? 'owner' : member.role === 'admin' ? 'admin' : member.role === 'inventory' ? 'inventory' : 'member';
    const groupName = state!.groups.find((group) => group.id === member.groupId)?.name ?? '默认组';
    const memberTags = state!.tags.filter((tag) => member.tagIds.includes(tag.id));
    const account = 'username' in member ? member : null;
    const canManage = account ? state!.user.isOwner || member.role !== 'admin' : false;
    const status = account && !account.active ? '<span class="status-chip low">停用</span>' : '';
    const action = account ? `<button class="icon-button member-action-button" type="button" data-member-action="${escapeHtml(member.id)}" aria-label="管理成员 ${escapeHtml(member.name)}" title="${canManage ? '管理成员' : '系统管理员不能管理系统所有者或其他系统管理员'}" ${canManage ? '' : 'disabled'}>${memberActionIcon}</button>` : '';
    const adminMeta = account ? `<div class="directory-person-admin-meta"><span>账号 ${escapeHtml(account.username)}</span><span>最近登录 ${escapeHtml(formatTime(account.lastLoginAt))}</span></div>` : '';
    const tags = memberTags.length ? `<div class="directory-tags" aria-label="成员标签">${memberTags.map((tag) => `<span class="member-tag">${escapeHtml(tag.name)}</span>`).join('')}</div>` : '';
    const search = `${member.name} ${account?.username ?? ''} ${member.note} ${groupName} ${memberTags.map((tag) => tag.name).join(' ')} ${roleLabel(member)}`.toLowerCase();
    return `<article class="directory-person${account && !account.active ? ' disabled' : ''}" data-directory-row data-role="${escapeHtml(member.role)}" data-group-id="${escapeHtml(member.groupId)}" data-tag-ids="${escapeHtml(member.tagIds.join(' '))}" data-search="${escapeHtml(search)}"><div class="directory-person-top"><span class="avatar">${escapeHtml(initial(member.name))}</span><div class="directory-person-name"><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(groupName)}</span></div><div class="directory-person-actions"><span class="status-chip role-chip ${roleClass}">${roleLabel(member)}</span>${status}${action}</div></div>${adminMeta}${tags}<p>${member.note ? escapeHtml(member.note) : '暂未填写负责范围或联系方式'}</p></article>`;
  }).join('') : '';
  applyMemberFilters();
}

function applyMemberFilters() {
  const query = $<HTMLInputElement>('[data-filter="members"]')?.value.trim().toLowerCase() ?? '';
  const role = $<HTMLSelectElement>('[data-member-role-filter]')?.value ?? 'all';
  const groupId = $<HTMLSelectElement>('[data-member-group-filter]')?.value ?? 'all';
  const tagId = $<HTMLSelectElement>('[data-member-tag-filter]')?.value ?? 'all';
  const matches = (row: HTMLElement) => {
    const haystack = row.dataset.search ?? row.textContent?.toLowerCase() ?? '';
    const matchesSearch = !query || haystack.includes(query);
    const matchesRole = role === 'all' || row.dataset.role === role;
    const matchesGroup = groupId === 'all' || row.dataset.groupId === groupId;
    const matchesTag = tagId === 'all' || (row.dataset.tagIds ?? '').split(' ').includes(tagId);
    row.hidden = !(matchesSearch && matchesRole && matchesGroup && matchesTag);
    return !row.hidden;
  };
  const directoryRows = $$<HTMLElement>('[data-directory-row]');
  const visibleDirectory = directoryRows.reduce((count, row) => count + (matches(row) ? 1 : 0), 0);
  $('[data-directory-empty]')?.classList.toggle('is-hidden', visibleDirectory > 0);
  const filterCount = $('[data-member-filter-count]');
  if (filterCount) filterCount.textContent = `${visibleDirectory} / ${state.directory.length} 位`;
}

function openMemberAction(memberId: string) {
  const member = state?.members.find((candidate) => candidate.id === memberId);
  if (!member || !state || !canManageMembers(state.user)) return;
  if (!state.user.isOwner && member.role === 'admin') return;
  memberActionTargetId = member.id;
  const avatar = $('[data-member-action-avatar]');
  const name = $('[data-member-action-name]');
  const username = $('[data-member-action-username]');
  const toggleLabel = $('[data-toggle-member-status-label]');
  const toggleButton = $<HTMLButtonElement>('[data-toggle-member-status]');
  const deleteButton = $<HTMLButtonElement>('[data-delete-member]');
  const resetInput = $<HTMLInputElement>('#member-reset-password');
  const resetButton = $<HTMLButtonElement>('[data-reset-member-password] button[type="submit"]');
  const memberUsernameInput = $<HTMLInputElement>('#member-action-login');
  const memberNameInput = $<HTMLInputElement>('#member-action-name');
  const memberNoteInput = $<HTMLTextAreaElement>('#member-action-note');
  const roleSelect = $<HTMLSelectElement>('#member-action-role');
  const groupSelect = $<HTMLSelectElement>('#member-action-group');
  const isCurrentUser = member.id === state.user.id;
  if (avatar) avatar.textContent = initial(member.name);
  if (name) name.textContent = member.name;
  if (username) username.textContent = `账号 ${member.username} · ${roleLabel(member)}`;
  if (toggleLabel) toggleLabel.textContent = member.active ? '停用账号' : '启用账号';
  $('[data-status-icon="disable"]')?.classList.toggle('is-hidden', !member.active);
  $('[data-status-icon="enable"]')?.classList.toggle('is-hidden', member.active);
  if (toggleButton) {
    toggleButton.classList.toggle('tonal', !member.active);
    toggleButton.disabled = isCurrentUser || member.isOwner;
    toggleButton.title = member.isOwner ? '系统所有者账号不能停用' : isCurrentUser ? '当前登录账号不能停用' : '';
  }
  if (deleteButton) {
    deleteButton.disabled = isCurrentUser || member.isOwner;
    deleteButton.title = member.isOwner ? '系统所有者账号不能删除' : isCurrentUser ? '当前登录账号不能删除' : '';
  }
  if (resetInput && resetButton) {
    resetInput.disabled = isCurrentUser || member.isOwner;
    resetButton.disabled = isCurrentUser || member.isOwner;
    resetButton.title = member.isOwner ? '系统所有者密码只能由本人修改' : isCurrentUser ? '请在系统设置中修改当前账号密码' : '';
  }
  if (memberUsernameInput) memberUsernameInput.value = member.username;
  if (memberNameInput) memberNameInput.value = member.name;
  if (memberNoteInput) memberNoteInput.value = member.note;
  if (roleSelect) {
    roleSelect.value = member.role;
    roleSelect.disabled = isCurrentUser || member.isOwner;
    roleSelect.title = member.isOwner ? '请先转移所有权，再修改角色' : isCurrentUser ? '当前登录账号不能修改角色' : '';
    const adminOption = [...roleSelect.options].find((option) => option.value === 'admin');
    if (adminOption) adminOption.disabled = !state.user.isOwner && member.role !== 'admin';
    refreshM3Select(roleSelect);
  }
  if (groupSelect) {
    groupSelect.value = member.groupId;
    refreshM3Select(groupSelect);
  }
  renderTagPicker('member-action', member.tagIds);
  const transferSection = $<HTMLElement>('[data-owner-transfer-section]');
  if (transferSection) transferSection.hidden = !(state.user.isOwner && member.role === 'admin' && !member.isOwner);
  $<HTMLFormElement>('[data-owner-transfer-form]')?.reset();
  $<HTMLFormElement>('[data-reset-member-password]')?.reset();
  openModal(memberActionModal);
}

function openMaterialAction(materialId: string) {
  const material = state?.materials.find((candidate) => candidate.id === materialId);
  if (!material || !state || !canManageInventory(state.user)) return;
  materialActionTargetId = material.id;
  const fields: Array<[string, string]> = [
    ['#edit-material-name', material.name],
    ['#edit-material-category', material.category],
    ['#edit-material-spec', material.spec],
    ['#edit-material-unit', material.unit],
    ['#edit-material-safety-stock', String(material.safetyStock)],
    ['#edit-material-expiry-warning-days', String(material.expiryWarningDays ?? 30)],
    ['#edit-material-position-help', material.positionCodeHelp],
    ['#edit-material-usage-help', material.usageContextHelp],
  ];
  fields.forEach(([selector, value]) => {
    const input = $<HTMLInputElement>(selector);
    if (input) input.value = value;
  });
  const trackingMode = $<HTMLSelectElement>('#edit-material-tracking-mode');
  if (trackingMode) {
    trackingMode.value = material.trackingMode;
    refreshM3Select(trackingMode);
  }
  $$<HTMLElement>('[data-material-registration-guidance]').forEach((field) => { field.hidden = material.trackingMode !== 'tracked'; });
  syncMaterialTrackingGuidance(material.trackingMode, material);
  const currentStock = $('[data-edit-material-current-stock]');
  if (currentStock) currentStock.textContent = material.trackingMode === 'quantity'
    ? `${formatNumber(material.quantity)} ${material.unit}`
    : `开放可用 ${formatNumber(material.availableQuantity)} / 总数 ${formatNumber(material.quantity)} ${material.unit}`;
  const title = $('[data-material-action-title]');
  const subtitle = $('[data-material-action-subtitle]');
  const stockLabel = $('[data-material-stock-label]');
  const submitLabel = $('[data-material-submit-label]');
  if (title) title.textContent = '管理耗材';
  if (subtitle) subtitle.textContent = '维护基础信息与安全库存线';
  if (stockLabel) stockLabel.textContent = '当前库存只能通过出入库记录变更';
  if (submitLabel) submitLabel.textContent = '保存耗材信息';
  $('[data-material-action-qr-section]')?.toggleAttribute('hidden', false);
  syncMaterialLifecycle(material);
  openModal(materialActionModal);
}

function syncMaterialLifecycle(material?: Material) {
  const lifecycle = $<HTMLElement>('[data-material-lifecycle]');
  if (lifecycle) lifecycle.hidden = !material;
  $$<HTMLInputElement>('[data-material-fields] input').forEach((input) => { input.disabled = false; });
  const save = $<HTMLButtonElement>('[data-save-material]');
  if (save) save.hidden = false;
  if (!material || !state) return;

  const toggle = $<HTMLButtonElement>('[data-toggle-material-status]');
  const toggleLabel = $('[data-toggle-material-status-label]');
  const remove = $<HTMLButtonElement>('[data-delete-material]');
  const removeLabel = $('[data-delete-material-label]');
  const restore = $<HTMLButtonElement>('[data-restore-material]');
  const hint = $('[data-material-lifecycle-hint]');
  const hasStock = material.quantity !== 0;
  if (toggle) {
    toggle.hidden = !material.active;
    toggle.disabled = hasStock;
    toggle.title = toggle.disabled ? '请先通过出库或库存调整将当前库存归零' : '';
  }
  if (toggleLabel) toggleLabel.textContent = '归档耗材';
  if (restore) restore.hidden = material.active;
  if (remove) {
    remove.hidden = state.user.role !== 'admin';
    remove.disabled = hasStock;
    remove.title = remove.disabled ? '请先通过出库或库存调整将当前库存归零' : '';
  }
  if (removeLabel) removeLabel.textContent = '永久删除';
  if (hint) {
    if (hasStock) hint.textContent = `当前仍有 ${formatNumber(material.quantity)} ${material.unit}，归零后才能归档或永久删除，避免库存无流水消失。`;
    else if (!material.active) hint.textContent = state.user.role === 'admin'
      ? '已从日常库存隐藏，可恢复使用；永久删除后档案不可恢复，但历史流水仍会保留。'
      : '已从日常库存隐藏，可随时恢复使用；永久删除仅限系统管理员。';
    else hint.textContent = state.user.role === 'admin'
      ? '可归档以便以后恢复，也可永久删除；两种操作都不会改变历史流水。'
      : '归档后默认隐藏且不参与日常库存，可随时恢复。';
  }
}

function openNewMaterialAction() {
  if (!state || !canManageInventory(state.user)) return;
  materialActionTargetId = '';
  const form = $<HTMLFormElement>('[data-material-action-form]');
  form?.reset();
  const safetyStock = $<HTMLInputElement>('#edit-material-safety-stock');
  const unit = $<HTMLInputElement>('#edit-material-unit');
  if (safetyStock) safetyStock.value = '0';
  const expiryWarningDays = $<HTMLInputElement>('#edit-material-expiry-warning-days');
  if (expiryWarningDays) expiryWarningDays.value = '30';
  if (unit) unit.value = '件';
  const trackingMode = $<HTMLSelectElement>('#edit-material-tracking-mode');
  if (trackingMode) {
    trackingMode.value = 'quantity';
    refreshM3Select(trackingMode);
  }
  $$<HTMLElement>('[data-material-registration-guidance]').forEach((field) => { field.hidden = true; });
  syncMaterialTrackingGuidance('quantity');
  const title = $('[data-material-action-title]');
  const subtitle = $('[data-material-action-subtitle]');
  const stockLabel = $('[data-material-stock-label]');
  const currentStock = $('[data-edit-material-current-stock]');
  const submitLabel = $('[data-material-submit-label]');
  if (title) title.textContent = '新增耗材';
  if (subtitle) subtitle.textContent = '先建立耗材档案，库存从 0 开始';
  if (stockLabel) stockLabel.textContent = '初始库存';
  if (currentStock) currentStock.textContent = '0 件';
  if (submitLabel) submitLabel.textContent = '新增耗材';
  $('[data-material-action-qr-section]')?.toggleAttribute('hidden', true);
  syncMaterialLifecycle();
  openModal(materialActionModal);
}

function renderBranding(settings: LabSettings) {
  $$('[data-app-name]').forEach((node) => {
    node.textContent = settings.appName;
    node.setAttribute('title', settings.appName);
  });
  $$('[data-lab-name]').forEach((node) => {
    node.textContent = settings.labName;
    node.setAttribute('title', settings.labName);
  });
  $$<HTMLImageElement>('[data-brand-icon]').forEach((image) => {
    image.hidden = !settings.brandIcon;
    if (settings.brandIcon) image.src = settings.brandIcon;
    else image.removeAttribute('src');
  });
  $$('[data-default-brand-icon]').forEach((icon) => icon.classList.toggle('is-hidden', Boolean(settings.brandIcon)));
  document.title = `${settings.appName} · 耗材出入库管理`;
}

function renderVersion(version: string) {
  $$('[data-app-version]').forEach((node) => {
    node.textContent = version || '未知';
  });
}

function renderApp() {
  if (!state) return;
  $$('[data-current-avatar]').forEach((node) => { node.textContent = initial(state!.user.name); });
  $$('[data-current-name]').forEach((node) => { node.textContent = state!.user.name; });
  $$('[data-current-role]').forEach((node) => { node.textContent = `${roleLabel(state!.user)} · 在线`; });
  $$('[data-open-import], [data-download-template], [data-inventory-admin-only]').forEach((node) => node.classList.toggle('is-hidden', !canManageInventory(state!.user)));
  $$<HTMLOptionElement>('[data-material-admin-filter]').forEach((option) => { option.hidden = !canManageInventory(state!.user); });
  const stockFilter = $<HTMLSelectElement>('[data-filter-select="stock"]');
  if (stockFilter) {
    if (!canManageInventory(state.user) && stockFilter.value === 'archived') stockFilter.value = 'active';
    refreshM3Select(stockFilter);
  }
  $('[data-add-member]')?.classList.toggle('is-hidden', !canManageMembers(state!.user));
  $$('[data-system-admin-only]').forEach((node) => node.classList.toggle('is-hidden', !canManageMembers(state!.user)));
  $('.mobile-nav')?.classList.remove('without-members');
  renderBranding(state.settings);
  renderVersion(state.version);
  const membersPageTitle = $('[data-members-page-title]');
  const membersPageDescription = $('[data-members-page-description]');
  if (membersPageTitle) membersPageTitle.textContent = canManageMembers(state.user) ? '成员管理' : '成员目录';
  if (membersPageDescription) membersPageDescription.textContent = canManageMembers(state.user)
    ? '查看成员目录并管理账号、身份、组织分组和职责标签。'
    : '查找同学负责的耗材范围和联系方式。';
  $$('[data-settings-tab="lab"], [data-settings-tab="groups"]').forEach((node) => node.classList.toggle('is-hidden', !canManageMembers(state!.user)));
  $('.settings-tabs')?.classList.toggle('member-only', !canManageMembers(state.user));
  const settingsSubtitle = $('[data-settings-subtitle]');
  if (settingsSubtitle) settingsSubtitle.textContent = canManageMembers(state.user) ? '管理实验室、组织、标签与当前账号资料' : '管理当前账号资料与登录密码';
  syncDatabaseBackupPanel();
  const recentHeading = $('[data-recent-heading]');
  const recentDescription = $('[data-recent-description]');
  const allRecordsLabel = $('[data-all-records-label]');
  const recordsDescription = $('[data-records-description]');
  if (recentHeading) recentHeading.textContent = '最近动态';
  if (recentDescription) recentDescription.textContent = '团队成员最近的库存活动';
  if (allRecordsLabel) allRecordsLabel.textContent = '全部记录';
  if (recordsDescription) recordsDescription.textContent = '查看全部或仅自己的流水；普通耗材记录领用去向，探针等库存单元记录使用状态。';
  renderGroups();
  renderTags();
  renderMaterials();
  renderTransactions();
  renderDirectory();
  renderNotifications();
  renderDashboard();
  const actorSelect = $<HTMLSelectElement>('[data-audit-actor]');
  if (actorSelect && canManageMembers(state.user)) {
    const selected = actorSelect.value;
    actorSelect.innerHTML = `<option value="all">全部操作者</option>${state.members.map((member) => `<option value="${escapeHtml(member.id)}">${escapeHtml(member.name)}</option>`).join('')}`;
    actorSelect.value = state.members.some((member) => member.id === selected) ? selected : 'all';
    refreshM3Select(actorSelect);
  }
}

function showLogin(message = '') {
  setMobileDrawer(false);
  state = null;
  recordScope = 'all';
  syncRecordScopeButtons();
  const memberSearch = $<HTMLInputElement>('[data-filter="members"]');
  if (memberSearch) memberSearch.value = '';
  const memberRoleFilter = $<HTMLSelectElement>('[data-member-role-filter]');
  if (memberRoleFilter) {
    memberRoleFilter.value = 'all';
    refreshM3Select(memberRoleFilter);
  }
  $$<HTMLSelectElement>('[data-member-group-filter], [data-member-tag-filter]').forEach((select) => {
    select.value = 'all';
    refreshM3Select(select);
  });
  finishWorkspaceLoading();
  document.body.className = 'auth-login';
  const error = $('[data-login-error]');
  if (error) error.textContent = message;
  $<HTMLInputElement>('#login-username')?.focus();
}

async function loadBootstrap() {
  cancelTransactionLoad();
  const generation = ++bootstrapGeneration;
  const nextState = await api<Bootstrap>('/api/bootstrap');
  if (generation !== bootstrapGeneration) return;
  state = nextState;
  recordPageItems = [];
  recordTotal = 0;
  recordHasMore = false;
  recordNextCursor = '';
  recordCursorHistory = [''];
  recordFrom = recordFilterFrom();
  exportSnapshot = null;
  recordPage = 1;
  auditPageItems = [];
  auditTotal = 0;
  auditHasMore = false;
  auditNextCursor = '';
  auditCursorHistory = [''];
  auditPage = 1;
  renderApp();
  document.body.className = 'auth-ready';
  finishWorkspaceLoading();
  consumeInventoryLink();
  if ($<HTMLElement>('[data-view="transactions"]')?.classList.contains('active')) void loadRecordPage();
  if ($<HTMLElement>('[data-view="audit"]')?.classList.contains('active')) void loadAuditPage();
}

async function initialize() {
  // Fetch the lightweight public branding and authenticated workspace in
  // parallel. This removes one full database read from the critical path on
  // refresh while still allowing the login screen to show the lab identity.
  const settingsRequest = api<{ settings: LabSettings; version: string }>('/api/public-settings')
    .then((result) => {
      renderBranding(result.settings);
      renderVersion(result.version);
    })
    .catch(() => undefined);
  try {
    await loadBootstrap();
  } catch (error) {
    await settingsRequest;
    showLogin((error as { status?: number }).status && (error as { status?: number }).status !== 401 ? (error as Error).message : '');
  }
}

navItems.forEach((item) => item.addEventListener('click', () => switchView(item.dataset.viewTarget)));
navItems.forEach((item) => item.addEventListener('click', () => setMobileDrawer(false)));
menuToggle?.addEventListener('click', () => setMobileDrawer(!sidebar?.classList.contains('mobile-open')));
drawerScrim?.addEventListener('click', () => setMobileDrawer(false));
inventoryMoreButton?.addEventListener('click', (event) => {
  setInventoryMoreOpen(!inventoryOverflow?.classList.contains('open'), false, event.detail === 0);
});
inventoryMoreButton?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    setInventoryMoreOpen(true, false, true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    setInventoryMoreOpen(true);
    requestAnimationFrame(() => {
      const items = inventoryCommandItems();
      items[event.key === 'ArrowDown' ? 0 : items.length - 1]?.focus();
    });
  } else if (event.key === 'Escape' && inventoryOverflow?.classList.contains('open')) {
    event.preventDefault();
    setInventoryMoreOpen(false, true);
  }
});
$<HTMLButtonElement>('[data-inventory-more-scrim]')?.addEventListener('click', () => setInventoryMoreOpen(false, true));
inventoryCommandMenu?.addEventListener('keydown', (event) => {
  const items = inventoryCommandItems();
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  if (event.key === 'Escape') {
    event.preventDefault();
    setInventoryMoreOpen(false, true);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    items[(current + offset + items.length) % items.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
  }
});
inventoryCommandMenu?.addEventListener('click', (event) => {
  const item = (event.target as Element).closest<HTMLButtonElement>('[data-inventory-action]');
  if (!item || item.classList.contains('is-hidden')) return;
  if (item.dataset.inventoryAction === 'stocktake') {
    setInventoryMoreOpen(false);
    if (!state || !canManageInventory(state.user)) return;
    stocktakeFilter = 'open';
    setStocktakeView('list');
    renderStocktakeList();
    openModal(stocktakeModal);
    void loadStocktakes();
    return;
  }
  const sourceSelectors: Record<string, string> = {
    batch: '.inventory-action-proxies [data-open-batch-labels]',
    add: '.inventory-action-proxies [data-add-material]',
    import: '.inventory-action-proxies [data-open-import]',
    template: '.inventory-action-proxies [data-download-template]',
    export: '.inventory-action-proxies [data-download-inventory]',
  };
  const selector = sourceSelectors[item.dataset.inventoryAction ?? ''];
  setInventoryMoreOpen(false, true);
  if (selector) $<HTMLButtonElement>(selector)?.click();
});
$$<HTMLButtonElement>('[data-go-view]').forEach((item) => item.addEventListener('click', () => switchView(item.dataset.goView)));
$<HTMLButtonElement>('[data-go-all-records]')?.addEventListener('click', () => {
  recordScope = 'all';
  syncRecordScopeButtons();
  switchView('transactions');
  applyRecordFilters();
});
$<HTMLButtonElement>('[data-go-my-records]')?.addEventListener('click', () => {
  recordScope = 'mine';
  syncRecordScopeButtons();
  switchView('transactions');
  applyRecordFilters();
});
$$<HTMLButtonElement>('[data-open-permissions]').forEach((button) => button.addEventListener('click', () => openModal(permissionsModal)));
$$<HTMLButtonElement>('[data-open-material-guide]').forEach((button) => button.addEventListener('click', () => openModal(materialGuideModal)));
$$<HTMLButtonElement>('[data-open-scanner]').forEach((button) => button.addEventListener('click', () => openScanner(false)));
$<HTMLButtonElement>('[data-open-scanner-from-transaction]')?.addEventListener('click', () => openScanner(true));
$$<HTMLButtonElement>('[data-scan-transaction-type]').forEach((button) => button.addEventListener('click', () => setScanTransactionType(button.dataset.scanTransactionType === 'in' ? 'in' : 'out')));
$<HTMLButtonElement>('[data-start-scanner]')?.addEventListener('click', () => void startCameraScanner());
$$<HTMLButtonElement>('[data-close-scanner]').forEach((button) => button.addEventListener('click', () => closeScanner()));
$<HTMLInputElement>('[data-scanner-image]')?.addEventListener('change', (event) => {
  const file = event.currentTarget.files?.[0];
  if (file) void decodeScannerImage(file);
});
$$<HTMLButtonElement>('[data-close-modal]').forEach((button) => button.addEventListener('click', () => {
  if (button.closest('[data-modal="inventory-detail"]')) void closeInventoryDetail();
  else if (button.closest('[data-modal="inventory-unit-edit"]')) closeInventoryUnitEdit();
  else closeModals();
}));
$$<HTMLButtonElement>('[data-close-stocktake-subdialog]').forEach((button) => button.addEventListener('click', () => closeStocktakeSubdialog(button.closest('.stocktake-subdialog'))));
$$<HTMLElement>('.modal-backdrop').forEach((backdrop) => backdrop.addEventListener('click', (event) => {
  if (event.target !== backdrop) return;
  if (backdrop === confirmModal) finishConfirmation(false);
  else if (backdrop === scannerModal) closeScanner();
  else if (backdrop === inventoryDetailModal) void closeInventoryDetail();
  else if (backdrop === inventoryUnitEditModal) closeInventoryUnitEdit();
  else if (backdrop.classList.contains('stocktake-subdialog')) closeStocktakeSubdialog(backdrop);
  else closeModals();
}));
$<HTMLButtonElement>('[data-confirm-submit]')?.addEventListener('click', () => finishConfirmation(true));
$$<HTMLButtonElement>('[data-confirm-cancel]').forEach((button) => button.addEventListener('click', () => finishConfirmation(false)));

$$<HTMLButtonElement>('[data-stocktake-filter]').forEach((button) => button.addEventListener('click', () => {
  stocktakeFilter = (button.dataset.stocktakeFilter as StocktakeStatus | 'all') ?? 'open';
  renderStocktakeList();
}));
$<HTMLButtonElement>('[data-stocktake-back]')?.addEventListener('click', () => {
  setStocktakeView('list');
  renderStocktakeList();
});
$<HTMLButtonElement>('[data-stocktake-create-open]')?.addEventListener('click', openStocktakeCreate);
$$<HTMLButtonElement>('[data-stocktake-scope-mode]').forEach((button) => button.addEventListener('click', () => {
  setStocktakeScopeMode((button.dataset.stocktakeScopeMode as StocktakeScopeMode) ?? 'all');
}));
$<HTMLInputElement>('#stocktake-create-material')?.addEventListener('input', (event) => {
  (event.currentTarget as HTMLInputElement).setCustomValidity('');
});
$<HTMLInputElement>('[data-stocktake-item-search]')?.addEventListener('input', renderStocktakeDetail);
$<HTMLSelectElement>('[data-stocktake-item-filter]')?.addEventListener('change', renderStocktakeDetail);
$<HTMLInputElement>('#stocktake-counted-quantity')?.addEventListener('input', syncStocktakeCountDifference);
$<HTMLButtonElement>('[data-stocktake-refresh]')?.addEventListener('click', () => void refreshOpenStocktakeDetail());
$<HTMLButtonElement>('[data-stocktake-cancel]')?.addEventListener('click', () => {
  const reason = $<HTMLTextAreaElement>('#stocktake-cancel-reason');
  if (reason) reason.value = '';
  openStocktakeSubdialog(stocktakeCancelModal);
});
stocktakeModal?.addEventListener('click', (event) => {
  const openBatch = (event.target as Element).closest<HTMLElement>('[data-stocktake-open]');
  if (openBatch?.dataset.stocktakeOpen) {
    void openStocktakeDetail(openBatch.dataset.stocktakeOpen);
    return;
  }
  const countItem = (event.target as Element).closest<HTMLElement>('[data-stocktake-count-item]');
  if (countItem?.dataset.stocktakeCountItem) {
    openStocktakeCount(countItem.dataset.stocktakeCountItem);
    return;
  }
  const openUnit = (event.target as Element).closest<HTMLElement>('[data-stocktake-open-unit]');
  if (openUnit?.dataset.stocktakeOpenUnit) {
    openStocktakeInventoryDetail(openUnit.dataset.stocktakeOpenUnit, false);
  }
});

$<HTMLFormElement>('[data-stocktake-create-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state || !canManageInventory(state.user)) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (!form.reportValidity()) return;
  const scopeMode = currentStocktakeScopeMode();
  const materialInput = $<HTMLInputElement>('#stocktake-create-material');
  const selectedMaterial = scopeMode === 'material'
    ? stocktakeEligibleMaterials().find((material) => material.name === materialInput?.value.trim())
    : undefined;
  if (scopeMode === 'material' && !selectedMaterial) {
    materialInput?.setCustomValidity('请从候选列表选择一种可盘点耗材');
    materialInput?.reportValidity();
    return;
  }
  if (submit) submit.disabled = true;
  submit?.classList.add('is-loading');
  try {
    const result = await api<{ stocktake: StocktakeDetail }>('/api/stocktakes', {
      method: 'POST',
      body: JSON.stringify({
        title: $<HTMLInputElement>('#stocktake-create-name')?.value.trim(),
        category: scopeMode === 'category' ? $<HTMLSelectElement>('[data-stocktake-create-category]')?.value ?? '' : '',
        materialId: selectedMaterial?.id ?? '',
      }),
    });
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    closeStocktakeSubdialog(stocktakeCreateModal);
    setStocktakeView('detail');
    renderStocktakeDetail();
    toast('盘点任务已创建');
  } catch (failure) {
    toast((failure as Error).message || '盘点任务创建失败');
  } finally {
    if (submit) submit.disabled = false;
    submit?.classList.remove('is-loading');
  }
});

$<HTMLFormElement>('[data-stocktake-count-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!stocktakeDetail || !stocktakeCountTarget) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  syncStocktakeCountDifference();
  if (!form.reportValidity()) return;
  if (submit) submit.disabled = true;
  submit?.classList.add('is-loading');
  try {
    const result = await api<{ stocktake: StocktakeDetail }>(`/api/stocktakes/${encodeURIComponent(stocktakeDetail.id)}/items/${encodeURIComponent(stocktakeCountTarget.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        countedQuantity: $<HTMLInputElement>('#stocktake-counted-quantity')?.value,
        reason: $<HTMLTextAreaElement>('#stocktake-difference-reason')?.value.trim() ?? '',
        resolutionNote: $<HTMLTextAreaElement>('#stocktake-resolution-note')?.value.trim() ?? '',
      }),
    });
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    stocktakeCountTarget = null;
    closeStocktakeSubdialog(stocktakeCountModal);
    renderStocktakeDetail();
    toast('实盘数量已保存');
  } catch (failure) {
    toast((failure as Error).message || '实盘数量保存失败');
  } finally {
    if (submit) submit.disabled = false;
    submit?.classList.remove('is-loading');
  }
});

$<HTMLButtonElement>('[data-stocktake-open-inventory-detail]')?.addEventListener('click', () => {
  const unitId = stocktakeCountTarget?.inventoryUnitId;
  if (!unitId) return;
  openStocktakeInventoryDetail(unitId, true);
});

$<HTMLFormElement>('[data-stocktake-cancel-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!stocktakeDetail) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (!form.reportValidity()) return;
  if (submit) submit.disabled = true;
  submit?.classList.add('is-loading');
  try {
    const result = await api<{ stocktake: StocktakeDetail }>(`/api/stocktakes/${encodeURIComponent(stocktakeDetail.id)}/cancel`, {
      method: 'POST', body: JSON.stringify({ reason: $<HTMLTextAreaElement>('#stocktake-cancel-reason')?.value.trim() }),
    });
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    closeStocktakeSubdialog(stocktakeCancelModal);
    renderStocktakeDetail();
    toast('盘点任务已取消');
  } catch (failure) {
    toast((failure as Error).message || '盘点任务取消失败');
  } finally {
    if (submit) submit.disabled = false;
    submit?.classList.remove('is-loading');
  }
});

$<HTMLButtonElement>('[data-stocktake-complete]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (!stocktakeDetail || stocktakeDetail.status !== 'open') return;
  const blockers = stocktakeDetailBlockers(stocktakeDetail);
  if (blockers.length) {
    toast(blockers[0]);
    return;
  }
  const ordinaryDifferences = stocktakeDetail.items.filter((item) => item.scopeType === 'material' && item.countedQuantity !== null && !stocktakeQuantitiesEqual(item.countedQuantity, item.expectedQuantity)).length;
  const confirmed = await askConfirmation({
    title: '完成本次盘点？',
    message: ordinaryDifferences
      ? `将锁定全部实盘结果，并为 ${ordinaryDifferences} 项普通耗材生成不可变库存调整流水。`
      : '将锁定全部实盘结果。完成后不能继续修改本批次。',
    confirmLabel: '完成盘点',
  });
  if (!confirmed || !stocktakeDetail) return;
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const result = await api<{ stocktake: StocktakeDetail }>(`/api/stocktakes/${encodeURIComponent(stocktakeDetail.id)}/complete`, { method: 'POST' });
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    closeModals();
    await loadBootstrap();
    stocktakeDetail = result.stocktake;
    updateStocktakeSummary(result.stocktake);
    setStocktakeView('detail');
    renderStocktakeDetail();
    openModal(stocktakeModal);
    toast('盘点已完成，库存与审计记录已更新');
  } catch (failure) {
    toast((failure as Error).message || '盘点任务完成失败');
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
});

$<HTMLFormElement>('[data-login-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  const error = $('[data-login-error]');
  if (error) error.textContent = '';
  if (submit) submit.disabled = true;
  submit?.classList.add('is-loading');
  beginWorkspaceLoading();
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $<HTMLInputElement>('#login-username')?.value, password: $<HTMLInputElement>('#login-password')?.value }) });
    form.reset();
    await loadBootstrap();
  } catch (failure) {
    finishWorkspaceLoading();
    if (error) error.textContent = (failure as Error).message;
  } finally {
    if (submit) submit.disabled = false;
    submit?.classList.remove('is-loading');
  }
});

const accountPanel = $('[data-settings-panel="account"]');
if (accountPanel && !accountPanel.querySelector('[data-settings-session]')) {
  const sessionSection = document.createElement('section');
  sessionSection.className = 'settings-session';
  sessionSection.dataset.settingsSession = '';
  const sessionCopy = document.createElement('div');
  const sessionHeading = document.createElement('h3');
  sessionHeading.textContent = '当前登录会话';
  const sessionDescription = document.createElement('p');
  sessionDescription.textContent = '退出后，本设备需要重新输入账号和密码。';
  sessionCopy.append(sessionHeading, sessionDescription);
  const sessionLogout = document.createElement('button');
  sessionLogout.className = 'button';
  sessionLogout.type = 'button';
  sessionLogout.dataset.logout = '';
  const logoutIcon = $<SVGElement>('.user-card [data-logout] svg')?.cloneNode(true);
  if (logoutIcon) sessionLogout.append(logoutIcon);
  sessionLogout.append(document.createTextNode('退出当前账号'));
  sessionSection.append(sessionCopy, sessionLogout);
  accountPanel.append(sessionSection);
}

async function logoutCurrentSession(button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
  }
  try { await api('/api/logout', { method: 'POST' }); } catch {}
  closeModals();
  switchView('dashboard');
  setMobileDrawer(false);
  showLogin();
  if (button) {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
}

$$<HTMLButtonElement>('[data-logout]').forEach((button) => button.addEventListener('click', () => { void logoutCurrentSession(button); }));

function setTransactionType(type: 'in' | 'out') {
  $$<HTMLButtonElement>('[data-transaction-type]').forEach((item) => {
    const active = item.dataset.transactionType === type;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  const title = $('#transaction-title');
  const subtitle = $('[data-transaction-subtitle]');
  const person = $('[data-person-label]');
  const input = $<HTMLInputElement>('#material-person');
  const hint = $('[data-person-hint]');
  if (title) title.textContent = '库存登记';
  if (subtitle) subtitle.textContent = type === 'out'
    ? '普通耗材登记数量，探针等耗材进入具体盒子或位置'
    : '登记采购、归还或调拨入库';
  if (person) person.textContent = type === 'out' ? '去向（房间号 / 领用人 / 项目）' : '来源（供应商）';
  if (input) input.placeholder = type === 'out' ? '填写房间号、领用人或项目' : '填写供应商名称';
  if (hint) hint.textContent = type === 'out' ? '记录耗材实际流向，房间号、领用人或项目可任选其一填写。' : '记录采购或补货来源，通常填写供应商名称。';
  renderMaterialOptions(type);
  updateMaterialSelection();
}

$$<HTMLButtonElement>('[data-open-modal]').forEach((button) => button.addEventListener('click', () => {
  $<HTMLFormElement>('[data-transaction-form]')?.reset();
  setTransactionType(button.dataset.openModal === 'out' ? 'out' : 'in');
  const date = $<HTMLInputElement>('#material-date');
  if (date && !date.value) date.value = localDateTimeValue();
  openModal(transactionModal);
}));
$$<HTMLButtonElement>('[data-transaction-type]').forEach((button) => button.addEventListener('click', () => setTransactionType(button.dataset.transactionType === 'out' ? 'out' : 'in')));

$<HTMLInputElement>('#material-name')?.addEventListener('input', updateMaterialSelection);
$<HTMLInputElement>('#material-name')?.addEventListener('change', () => {
  updateMaterialSelection();
  routeTrackedMaterialSelection();
});
$<HTMLSelectElement>('#material-tracking-mode')?.addEventListener('change', () => updateMaterialSelection());

$<HTMLFormElement>('[data-transaction-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    const type = currentTransactionType();
    const material = materialFromInput();
    const materialName = $<HTMLInputElement>('#material-name')?.value.trim() ?? '';
    const isNewInbound = !material && type === 'in' && Boolean(materialName);
    const selectedTrackingMode = isNewInbound ? newMaterialTrackingMode() : 'quantity';
    if (!material && (type === 'out' || !materialName)) {
      toast(type === 'out' ? '领用 / 使用必须从候选项选择已有耗材' : '请填写耗材名称');
      $<HTMLInputElement>('#material-name')?.focus();
      return;
    }
    if (material && material.trackingMode !== 'quantity') {
      closeModals();
      await openInventoryDetail(material.id);
      toast('请在库存明细中选择状态、使用范围和库存单元');
      return;
    }
    const result = await api<{ material: Material; createdMaterial?: boolean }>('/api/transactions', { method: 'POST', body: JSON.stringify({
      type,
      materialId: material?.id,
      materialName,
      quantity: selectedTrackingMode === 'quantity' ? Number($<HTMLInputElement>('#material-quantity')?.value) : undefined,
      unit: $<HTMLInputElement>('#material-unit')?.value,
      category: $<HTMLInputElement>('#material-category')?.value,
      spec: $<HTMLInputElement>('#material-spec')?.value,
      safetyStock: Number($<HTMLInputElement>('#material-safety-stock')?.value),
      trackingMode: isNewInbound ? selectedTrackingMode : undefined,
      counterparty: $<HTMLInputElement>('#material-person')?.value,
      occurredAt: $<HTMLInputElement>('#material-date')?.value,
      note: $<HTMLTextAreaElement>('#material-note')?.value,
    }) });
    form.reset();
    updateMaterialSelection();
    closeModals();
    await loadBootstrap();
    if (result.createdMaterial && result.material.trackingMode !== 'quantity') {
      toast(result.material.trackingMode === 'tracked'
        ? '耗材档案已创建，下一步请建立首个批次 / 单件并入库'
        : '耗材档案已创建，下一步请在库存明细中选择状态并入库');
      await openInventoryDetail(result.material.id);
    } else {
      toast(`${type === 'out' ? '领用 / 使用' : '入库'}记录已保存`);
    }
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$$<HTMLButtonElement>('[data-open-import]').forEach((button) => button.addEventListener('click', () => openModal(importModal)));
const importFile = $<HTMLInputElement>('[data-import-file]');
const importConfirm = $<HTMLButtonElement>('[data-confirm-import]');
const updateImportFileState = () => {
  const file = importFile?.files?.[0];
  if (importConfirm) importConfirm.disabled = !file;
  const fileName = $('[data-import-file-name]');
  if (fileName) fileName.textContent = file?.name ?? '尚未选择文件';
};
$<HTMLButtonElement>('[data-choose-import-file]')?.addEventListener('click', () => importFile?.click());
importFile?.addEventListener('change', updateImportFileState);
importConfirm?.addEventListener('click', async () => {
  const file = importFile?.files?.[0];
  if (!file) return;
  importConfirm.disabled = true;
  try {
    const XLSX = await loadXlsx();
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const sheetName = ['可导入库存', '逐耗材统计'].find((name) => workbook.SheetNames.includes(name)) ?? workbook.SheetNames[0];
    if (!sheetName) throw new Error('文件中没有可读取的工作表');
    const sheet = workbook.Sheets[sheetName];
    const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const rows = sourceRows.map((row) => ({
      name: row['耗材名称'] ?? row['名称'] ?? row.name,
      category: row['分类'] ?? row.category,
      quantity: row['当前库存'] ?? row['数量'] ?? row.quantity,
      safetyStock: row['安全库存'] ?? row.safetyStock,
      unit: row['单位'] ?? row.unit,
      spec: row['规格'] ?? row.spec,
    })).filter((row) => Object.values(row).some((value) => String(value ?? '').trim()));
    if (!rows.length) throw new Error(`工作表“${sheetName}”中没有可导入的数据`);
    if (!await askConfirmation({
      title: '确认回导当前库存？',
      message: `已从工作表“${sheetName}”识别 ${rows.length} 行。系统会把每行“当前库存”作为目标数量并生成差额流水，请确认继续。`,
      confirmLabel: `导入 ${rows.length} 行`,
    })) return;
    const result = await api<{ imported: number; adjustments: number }>('/api/import', { method: 'POST', body: JSON.stringify({ rows }) });
    closeModals();
    importFile.value = '';
    updateImportFileState();
    await loadBootstrap();
    toast(`成功导入 ${result.imported} 条数据，生成 ${result.adjustments} 笔库存流水`);
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    importConfirm.disabled = !importFile?.files?.length;
  }
});

$$<HTMLButtonElement>('[data-add-member]').forEach((button) => button.addEventListener('click', () => {
  $<HTMLFormElement>('[data-member-form]')?.reset();
  const roleSelect = $<HTMLSelectElement>('#member-role');
  const adminOption = roleSelect ? [...roleSelect.options].find((option) => option.value === 'admin') : null;
  if (adminOption) adminOption.disabled = !state?.user.isOwner;
  if (roleSelect) {
    roleSelect.value = 'member';
    refreshM3Select(roleSelect);
  }
  renderTagPicker('member');
  openModal(memberModal);
}));
$<HTMLButtonElement>('[data-add-material]')?.addEventListener('click', openNewMaterialAction);
$<HTMLButtonElement>('[data-open-batch-labels]')?.addEventListener('click', openBatchLabels);
$<HTMLInputElement>('[data-batch-label-search]')?.addEventListener('input', renderBatchLabelMaterials);
$<HTMLElement>('[data-batch-label-list]')?.addEventListener('change', (event) => {
  const checkbox = (event.target as Element).closest<HTMLInputElement>('[data-batch-label-material]');
  const materialId = checkbox?.dataset.batchLabelMaterial;
  if (!checkbox || !materialId) return;
  if (checkbox.checked) batchLabelSelectedIds.add(materialId);
  else batchLabelSelectedIds.delete(materialId);
  syncBatchLabelControls();
});
$<HTMLButtonElement>('[data-batch-select-visible]')?.addEventListener('click', () => {
  visibleBatchLabelMaterials().forEach((material) => batchLabelSelectedIds.add(material.id));
  renderBatchLabelMaterials();
});
$<HTMLButtonElement>('[data-batch-clear-labels]')?.addEventListener('click', () => {
  batchLabelSelectedIds.clear();
  renderBatchLabelMaterials();
});
$<HTMLSelectElement>('[data-batch-label-size]')?.addEventListener('change', syncBatchLabelControls);
$$<HTMLInputElement>('[data-batch-label-width], [data-batch-label-height], [data-batch-label-copies]').forEach((input) => input.addEventListener('input', syncBatchLabelControls));
$<HTMLButtonElement>('[data-print-batch-labels]')?.addEventListener('click', async (event) => {
  if (!state || !syncBatchLabelControls()) return;
  const button = event.currentTarget;
  const buttonText = $('[data-print-batch-labels-text]', button);
  const selectedMaterials = [...batchLabelSelectedIds]
    .map((id) => state?.materials.find((material) => material.id === id && material.active))
    .filter((material): material is Material => Boolean(material));
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const size = selectedBatchLabelSize();
    const copies = selectedBatchLabelCopies();
    const dataUrls: string[] = [];
    for (let index = 0; index < selectedMaterials.length; index += 1) {
      const material = selectedMaterials[index];
      if (buttonText) buttonText.textContent = `正在生成 ${index + 1} / ${selectedMaterials.length}`;
      const qrDataUrl = await createMaterialQrDataUrl(material.id);
      const labelDataUrl = await createMaterialLabelPng(material, size, qrDataUrl);
      for (let copy = 0; copy < copies; copy += 1) dataUrls.push(labelDataUrl);
    }
    const cutLines = $<HTMLInputElement>('[data-batch-cut-lines]')?.checked ?? true;
    await printMaterialImages(prepareA4MaterialPrintLabels(dataUrls, size, cutLines));
  } catch (failure) {
    document.body.classList.remove('printing-material-label');
    toast((failure as Error).message || '无法生成批量标签');
  } finally {
    button.classList.remove('is-loading');
    if (buttonText) buttonText.textContent = '打印所选标签';
    syncBatchLabelControls();
  }
});
$<HTMLElement>('[data-directory-body]')?.addEventListener('click', (event) => {
  const target = event.target as Element;
  const button = target.closest<HTMLButtonElement>('[data-member-action]');
  if (button?.dataset.memberAction) openMemberAction(button.dataset.memberAction);
});
$<HTMLButtonElement>('[data-inventory-body]')?.addEventListener('click', (event) => {
  const infoButton = (event.target as Element).closest<HTMLButtonElement>('[data-material-info]');
  if (infoButton?.dataset.materialInfo) {
    openMaterialInfo(infoButton.dataset.materialInfo);
    return;
  }
  const detailButton = (event.target as Element).closest<HTMLButtonElement>('[data-inventory-detail]');
  if (detailButton?.dataset.inventoryDetail) {
    void openInventoryDetail(detailButton.dataset.inventoryDetail);
    return;
  }
  const qrButton = (event.target as Element).closest<HTMLButtonElement>('[data-material-qr]');
  if (qrButton?.dataset.materialQr) {
    void openMaterialQr(qrButton.dataset.materialQr);
    return;
  }
  const actionButton = (event.target as Element).closest<HTMLButtonElement>('[data-material-action]');
  if (actionButton?.dataset.materialAction) openMaterialAction(actionButton.dataset.materialAction);
});
$<HTMLButtonElement>('[data-material-info-detail]')?.addEventListener('click', () => {
  if (!materialInfoTargetId) return;
  const materialId = materialInfoTargetId;
  const returnFocus = modalReturnFocus;
  hideModal(materialInfoModal);
  const opening = openInventoryDetail(materialId);
  modalReturnFocus = returnFocus;
  void opening;
});
$<HTMLButtonElement>('[data-material-info-qr]')?.addEventListener('click', () => {
  if (!materialInfoTargetId) return;
  const materialId = materialInfoTargetId;
  const returnFocus = modalReturnFocus;
  hideModal(materialInfoModal);
  const opening = openMaterialQr(materialId);
  modalReturnFocus = returnFocus;
  void opening;
});
$<HTMLButtonElement>('[data-material-info-manage]')?.addEventListener('click', () => {
  if (!materialInfoTargetId) return;
  const materialId = materialInfoTargetId;
  const returnFocus = modalReturnFocus;
  hideModal(materialInfoModal);
  openMaterialAction(materialId);
  modalReturnFocus = returnFocus;
});
$<HTMLButtonElement>('[data-material-action-qr]')?.addEventListener('click', () => {
  if (!materialActionTargetId) return;
  const materialId = materialActionTargetId;
  const returnFocus = modalReturnFocus;
  hideModal(materialActionModal);
  const opening = openMaterialQr(materialId);
  modalReturnFocus = returnFocus;
  void opening;
});
$<HTMLButtonElement>('[data-material-action-detail]')?.addEventListener('click', () => {
  if (!materialActionTargetId) return;
  const materialId = materialActionTargetId;
  const returnFocus = modalReturnFocus;
  hideModal(materialActionModal);
  const opening = openInventoryDetail(materialId);
  modalReturnFocus = returnFocus;
  void opening;
});
$$<HTMLButtonElement>('[data-tracking-tab]').forEach((button) => button.addEventListener('click', () => selectTrackingTab((button.dataset.trackingTab ?? 'units') as 'units' | 'statuses' | 'events')));
$<HTMLInputElement>('[data-tracking-search]')?.addEventListener('input', renderInventoryUnits);
$<HTMLButtonElement>('[data-show-unit-create]')?.addEventListener('click', () => {
  const form = $<HTMLFormElement>('[data-unit-create-form]');
  form?.reset();
  if (form) form.hidden = false;
  const date = $<HTMLInputElement>('#unit-date');
  if (date) date.value = localDateTimeValue();
  unitQuantityFollowsCapacity = true;
  const capacity = $<HTMLInputElement>('#unit-capacity');
  const quantity = $<HTMLInputElement>('#unit-quantity');
  const unitType = $<HTMLSelectElement>('#unit-type');
  if (unitType) unitType.value = 'lot';
  if (capacity) capacity.value = '0';
  if (quantity) quantity.value = '1';
  if (state) setInventoryOwnerFieldValue('#unit-owner', state.user.id);
  const access = $<HTMLSelectElement>('#unit-access');
  if (access) access.value = 'shared';
  $('[data-unit-owner-field]')?.toggleAttribute('hidden', true);
  syncInventoryUnitTypeForm();
  $$<HTMLSelectElement>('#unit-type, #unit-status, #unit-access, #unit-owner').forEach(refreshM3Select);
  syncInventoryDetailFormOptions();
  requestAnimationFrame(() => $<HTMLInputElement>('#unit-label')?.focus());
});
$<HTMLSelectElement>('#unit-type')?.addEventListener('change', () => syncInventoryUnitTypeForm());
$<HTMLInputElement>('#unit-capacity')?.addEventListener('input', (event) => {
  const quantity = $<HTMLInputElement>('#unit-quantity');
  if (quantity && unitQuantityFollowsCapacity) quantity.value = Number(event.currentTarget.value) > 0 ? event.currentTarget.value : '1';
});
$<HTMLInputElement>('#unit-quantity')?.addEventListener('input', () => {
  const capacity = $<HTMLInputElement>('#unit-capacity');
  const quantity = $<HTMLInputElement>('#unit-quantity');
  unitQuantityFollowsCapacity = Boolean(capacity && quantity && capacity.value === quantity.value);
});
$<HTMLButtonElement>('[data-hide-unit-create]')?.addEventListener('click', () => $<HTMLFormElement>('[data-unit-create-form]')?.toggleAttribute('hidden', true));
$<HTMLSelectElement>('#unit-access')?.addEventListener('change', (event) => {
  const selfUse = event.currentTarget.value === 'user';
  $('[data-unit-owner-field]')?.toggleAttribute('hidden', !selfUse);
  const ownerSearch = $<HTMLInputElement>('#unit-owner-search');
  if (ownerSearch) ownerSearch.required = selfUse;
  if (selfUse && state) setInventoryOwnerFieldValue('#unit-owner', state.user.id);
});
$<HTMLSelectElement>('#inventory-operation-type')?.addEventListener('change', syncInventoryOperationForm);
$<HTMLSelectElement>('#inventory-operation-access')?.addEventListener('change', syncInventoryOperationForm);
$<HTMLSelectElement>('#edit-material-tracking-mode')?.addEventListener('change', (event) => {
  const showGuidance = event.currentTarget.value === 'tracked';
  $$<HTMLElement>('[data-material-registration-guidance]').forEach((field) => { field.hidden = !showGuidance; });
  const material = materialActionTargetId ? state?.materials.find((candidate) => candidate.id === materialActionTargetId) : undefined;
  syncMaterialTrackingGuidance(event.currentTarget.value, material);
});
$$<HTMLButtonElement>('[data-close-inventory-operation]').forEach((button) => button.addEventListener('click', closeInventoryOperation));
materialQrModal?.addEventListener('click', (event) => {
  if (!(event.target as Element).closest('[data-close-modal]')) return;
  event.preventDefault();
  event.stopPropagation();
  closeMaterialQr();
}, { capture: true });

$<HTMLElement>('[data-modal="inventory-detail"]')?.addEventListener('click', async (event) => {
  const target = event.target as Element;
  const anomalyButton = target.closest<HTMLButtonElement>('[data-inventory-anomaly-fix]');
  if (anomalyButton?.dataset.anomalyId) {
    const anomaly = inventoryAnomalies.find((candidate) => candidate.id === anomalyButton.dataset.anomalyId);
    const entryIndex = Number(anomalyButton.dataset.anomalyEntry);
    if (anomaly) openInventoryAnomalyFix(anomaly, anomaly.entries[entryIndex]);
    return;
  }
  const unitEditButton = target.closest<HTMLButtonElement>('[data-unit-edit]');
  if (unitEditButton?.dataset.unitId && inventoryDetailData) {
    const unit = inventoryDetailData.units.find((candidate) => candidate.id === unitEditButton.dataset.unitId);
    if (unit) openInventoryUnitEdit(unit);
    return;
  }
  const unitToggle = target.closest<HTMLButtonElement>('[data-unit-toggle]');
  if (unitToggle?.dataset.unitId) {
    if (expandedInventoryUnitIds.has(unitToggle.dataset.unitId)) expandedInventoryUnitIds.delete(unitToggle.dataset.unitId);
    else expandedInventoryUnitIds.add(unitToggle.dataset.unitId);
    renderInventoryUnits();
    requestAnimationFrame(() => inventoryDetailModal?.querySelector<HTMLButtonElement>(`[data-unit-toggle][data-unit-id="${CSS.escape(unitToggle.dataset.unitId ?? '')}"]`)?.focus());
    return;
  }
  const balanceButton = target.closest<HTMLButtonElement>('[data-unit-balance-use], [data-unit-balance-manage]');
  if (balanceButton?.dataset.unitId && balanceButton.dataset.balanceKey && inventoryDetailData) {
    const unit = inventoryDetailData.units.find((candidate) => candidate.id === balanceButton.dataset.unitId);
    const balance = unit ? inventoryBalanceByKey(unit, balanceButton.dataset.balanceKey) : null;
    if (unit && balance) openInventoryOperation(unit, balance, balanceButton.dataset.preferredOperation || (balanceButton.hasAttribute('data-unit-balance-use') ? 'use' : balance.terminal ? 'dispose' : 'state_change'));
    return;
  }
  const inboundButton = target.closest<HTMLButtonElement>('[data-unit-in]');
  if (inboundButton?.dataset.unitId && inventoryDetailData) {
    const unit = inventoryDetailData.units.find((candidate) => candidate.id === inboundButton.dataset.unitId);
    if (unit) openInventoryOperation(unit, null, 'in');
    return;
  }
  const qrButton = target.closest<HTMLButtonElement>('[data-unit-qr]');
  if (qrButton?.dataset.unitId && inventoryDetailData) {
    const unit = inventoryDetailData.units.find((candidate) => candidate.id === qrButton.dataset.unitId);
    if (!unit) return;
    await openInventoryUnitQr(unit);
    return;
  }
  const statusButton = target.closest<HTMLButtonElement>('[data-unit-status]');
  if (statusButton?.dataset.unitId && statusButton.dataset.unitStatus && inventoryDetailData) {
    const unit = inventoryDetailData.units.find((candidate) => candidate.id === statusButton.dataset.unitId);
    if (!unit) return;
    const archiving = statusButton.dataset.unitStatus === 'archived';
    if (archiving && !await askConfirmation({ title: '归档库存单元？', message: `“${unit.displayLabel}”归档后仍可通过二维码查看，但不能继续登记；需要时可由库存管理员恢复。`, confirmLabel: '归档库存单元' })) return;
    try {
      await api(`/api/inventory-units/${encodeURIComponent(unit.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: statusButton.dataset.unitStatus }) });
      await reloadInventoryDetail();
      toast(archiving ? '库存单元已归档' : '库存单元已恢复');
    } catch (failure) {
      toast((failure as Error).message);
    }
    return;
  }
  const saveStatus = target.closest<HTMLButtonElement>('[data-save-inventory-status]');
  if (saveStatus) {
    const row = saveStatus.closest<HTMLElement>('[data-status-id]');
    if (!row?.dataset.statusId) return;
    const kind = $<HTMLSelectElement>('[data-status-kind]', row)?.value ?? 'usable';
    saveStatus.disabled = true;
    try {
      await api(`/api/inventory-statuses/${encodeURIComponent(row.dataset.statusId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: $<HTMLInputElement>('[data-status-name]', row)?.value,
          usable: kind === 'usable',
          terminal: kind === 'terminal',
        }),
      });
      await loadBootstrap();
      await reloadInventoryDetail();
      toast('库存状态已保存');
    } catch (failure) {
      toast((failure as Error).message);
    } finally {
      saveStatus.disabled = false;
    }
  }
});

$<HTMLFormElement>('[data-unit-create-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!inventoryDetailData) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  const positionCodes = [...new Set(($<HTMLTextAreaElement>('#unit-position-codes')?.value ?? '').split(/[\n,，;；]+/).map((value) => value.trim()).filter(Boolean))];
  const quantity = Number($<HTMLInputElement>('#unit-quantity')?.value);
  const statusId = $<HTMLSelectElement>('#unit-status')?.value ?? '';
  const accessScope = $<HTMLSelectElement>('#unit-access')?.value === 'user' ? 'user' : 'shared';
  const ownerSearch = $<HTMLInputElement>('#unit-owner-search');
  if (accessScope === 'user' && ownerSearch && !ownerSearch.checkValidity()) return ownerSearch.reportValidity();
  const ownerUserId = accessScope === 'user' ? $<HTMLSelectElement>('#unit-owner')?.value : '';
  if (submit) submit.disabled = true;
  try {
    await api('/api/inventory-units', {
      method: 'POST',
      body: JSON.stringify({
        materialId: inventoryDetailData.material.id,
        unitType: $<HTMLSelectElement>('#unit-type')?.value,
        label: $<HTMLInputElement>('#unit-label')?.value,
        capacity: Number($<HTMLInputElement>('#unit-capacity')?.value),
        expiryDate: $<HTMLInputElement>('#unit-expiry-date')?.value,
        counterparty: $<HTMLInputElement>('#unit-counterparty')?.value,
        occurredAt: $<HTMLInputElement>('#unit-date')?.value,
        note: $<HTMLTextAreaElement>('#unit-note')?.value,
        balances: positionCodes.length
          ? positionCodes.map((positionCode) => ({ statusId, accessScope, ownerUserId, positionCode, quantity: 1 }))
          : [{ statusId, accessScope, ownerUserId, quantity }],
      }),
    });
    form.reset();
    form.hidden = true;
    await loadBootstrap();
    await reloadInventoryDetail();
    toast(`库存单元已创建并入库 ${positionCodes.length || quantity} ${inventoryDetailData.material.unit}`);
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$<HTMLFormElement>('[data-inventory-unit-edit-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const unit = inventoryUnitEditTarget;
  if (!unit || !inventoryDetailData) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api(`/api/inventory-units/${encodeURIComponent(unit.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        label: $<HTMLInputElement>('#edit-inventory-unit-label')?.value,
        capacity: Number($<HTMLInputElement>('#edit-inventory-unit-capacity')?.value),
        expiryDate: $<HTMLInputElement>('#edit-inventory-unit-expiry-date')?.value,
        note: $<HTMLTextAreaElement>('#edit-inventory-unit-note')?.value,
      }),
    });
    closeInventoryUnitEdit();
    await loadBootstrap();
    await reloadInventoryDetail();
    toast(unit.label === '历史库存（未分批）' ? '历史库存资料已补录' : '库存单元资料已保存');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$<HTMLFormElement>('[data-status-create-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!inventoryDetailData) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  const kind = $<HTMLSelectElement>('#new-inventory-status-kind')?.value ?? 'usable';
  if (submit) submit.disabled = true;
  try {
    await api('/api/inventory-statuses', {
      method: 'POST',
      body: JSON.stringify({ materialId: inventoryDetailData.material.id, name: $<HTMLInputElement>('#new-inventory-status')?.value, usable: kind === 'usable', terminal: kind === 'terminal' }),
    });
    form.reset();
    refreshM3Select($<HTMLSelectElement>('#new-inventory-status-kind')!);
    await reloadInventoryDetail();
    toast('库存状态已添加');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$<HTMLFormElement>('[data-inventory-operation-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!inventoryOperationUnit || !inventoryDetailData) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  const operation = $<HTMLSelectElement>('#inventory-operation-type')?.value ?? 'use';
  if (operation !== 'in' && !inventoryOperationBalance) return toast('请先选择一条库存明细');
  const accessScope = $<HTMLSelectElement>('#inventory-operation-access')?.value === 'user' ? 'user' : 'shared';
  const ownerNeeded = accessScope === 'user' && (operation === 'in' || operation === 'access_change');
  const ownerSearch = $<HTMLInputElement>('#inventory-operation-owner-search');
  if (ownerNeeded && ownerSearch && !ownerSearch.checkValidity()) return ownerSearch.reportValidity();
  const payload: Record<string, unknown> = {
    operation,
    quantity: Number($<HTMLInputElement>('#inventory-operation-quantity')?.value),
    counterparty: $<HTMLInputElement>('#inventory-operation-counterparty')?.value,
    occurredAt: $<HTMLInputElement>('#inventory-operation-date')?.value,
    note: $<HTMLTextAreaElement>('#inventory-operation-note')?.value,
  };
  if (operation === 'in') {
    Object.assign(payload, {
      toStatusId: $<HTMLSelectElement>('#inventory-operation-status')?.value,
      toAccessScope: accessScope,
      toOwnerUserId: accessScope === 'user' ? $<HTMLSelectElement>('#inventory-operation-owner')?.value : '',
      toPositionCode: $<HTMLInputElement>('#inventory-operation-position')?.value,
    });
  } else if (inventoryOperationBalance) {
    Object.assign(payload, {
      fromStatusId: inventoryOperationBalance.statusId,
      fromAccessScope: inventoryOperationBalance.accessScope,
      fromOwnerUserId: inventoryOperationBalance.ownerUserId,
      fromPositionCode: inventoryOperationBalance.positionCode,
    });
    if (operation === 'state_change') payload.toStatusId = $<HTMLSelectElement>('#inventory-operation-status')?.value;
    if (operation === 'access_change') {
      payload.toAccessScope = accessScope;
      payload.toOwnerUserId = accessScope === 'user' ? $<HTMLSelectElement>('#inventory-operation-owner')?.value : '';
    }
    if (operation === 'position_change' || (!inventoryOperationBalance.positionCode && ['state_change', 'access_change'].includes(operation))) {
      payload.toPositionCode = $<HTMLInputElement>('#inventory-operation-position')?.value;
    }
    if (operation === 'use' && inventoryOperationUnit.unitType === 'container' && !inventoryOperationBalance.positionCode) {
      payload.toPositionCode = $<HTMLInputElement>('#inventory-operation-position')?.value;
    }
  }
  const targetStatus = operation === 'state_change'
    ? inventoryDetailData.statuses.find((status) => status.id === payload.toStatusId)
    : null;
  const terminalConfirmation = terminalStateConfirmation(operation, targetStatus, inventoryOperationBalance);
  if (terminalConfirmation && !await askConfirmation(terminalConfirmation)) return;
  if (submit) submit.disabled = true;
  try {
    const result = await api<{ inventoryEvent: InventoryEvent | null }>(`/api/inventory-units/${encodeURIComponent(inventoryOperationUnit.id)}/operation`, { method: 'POST', body: JSON.stringify(payload) });
    closeInventoryOperation();
    inventoryEventsLoaded = false;
    await loadBootstrap();
    await reloadInventoryDetail();
    const statusChanged = operation === 'use' && result.inventoryEvent && result.inventoryEvent.fromStatusId !== result.inventoryEvent.toStatusId;
    toast(statusChanged ? `使用登记已保存，状态已更新为“${result.inventoryEvent?.toStatusName}”` : operation === 'use' ? '使用登记已保存' : '库存明细已更新');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

$<HTMLElement>('[data-records-body]')?.addEventListener('click', (event) => {
  const target = event.target as Element;
  const correctionButton = target.closest<HTMLButtonElement>('[data-correct-transaction]');
  if (correctionButton?.dataset.correctTransaction) {
    const record = recordPageItems.find((candidate) => candidate.kind === 'transaction' && candidate.record.id === correctionButton.dataset.correctTransaction)?.record;
    if (record) openTransactionCorrection(record);
    return;
  }
  const inventoryEventCorrectionButton = target.closest<HTMLButtonElement>('[data-correct-inventory-event]');
  if (inventoryEventCorrectionButton?.dataset.correctInventoryEvent) {
    const inventoryEvent = recordPageItems.find((candidate) => candidate.kind === 'event' && candidate.event.id === inventoryEventCorrectionButton.dataset.correctInventoryEvent)?.event;
    if (inventoryEvent) openInventoryEventCorrection(inventoryEvent);
    return;
  }
  const unitButton = target.closest<HTMLButtonElement>('[data-open-record-unit]');
  if (unitButton?.dataset.openRecordUnit) void openInventoryDetail('', unitButton.dataset.openRecordUnit);
});

$<HTMLFormElement>('[data-correction-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const record = correctionTarget;
  const inventoryEvent = inventoryEventCorrectionTarget;
  if (!record && !inventoryEvent) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) {
    submit.disabled = true;
    submit.classList.add('is-loading');
  }
  try {
    const reason = $<HTMLTextAreaElement>('#correction-reason')?.value;
    if (record) {
      await api(`/api/transactions/${encodeURIComponent(record.id)}/correction`, {
        method: 'POST',
        body: JSON.stringify({ quantity: Number($<HTMLInputElement>('#correction-quantity')?.value), reason }),
      });
    } else if (inventoryEvent) {
      await api(`/api/inventory-events/${encodeURIComponent(inventoryEvent.id)}/correction`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
    }
    closeModals();
    await loadBootstrap();
    await loadRecordPage(true);
    toast('更正已记录，原记录保持不变');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.classList.remove('is-loading');
    }
  }
});
$<HTMLButtonElement>('[data-download-material-qr]')?.addEventListener('click', () => {
  const material = state?.materials.find((candidate) => candidate.id === qrMaterialTargetId);
  if (!material || !qrMaterialDataUrl) return toast('二维码仍在生成，请稍后重试');
  const unitSuffix = qrInventoryUnitTarget ? `-${safeMaterialFilename(qrInventoryUnitTarget.displayLabel)}` : '';
  downloadDataUrl(qrMaterialDataUrl, `${safeMaterialFilename(material.name)}${unitSuffix}-二维码.png`);
});
$<HTMLButtonElement>('[data-download-material-label]')?.addEventListener('click', async (event) => {
  const material = state?.materials.find((candidate) => candidate.id === qrMaterialTargetId);
  if (!material || !qrMaterialDataUrl) return toast('二维码仍在生成，请稍后重试');
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const size = selectedMaterialLabelSize();
    const unitSuffix = qrInventoryUnitTarget ? `-${safeMaterialFilename(qrInventoryUnitTarget.displayLabel)}` : '';
    downloadDataUrl(await materialLabelDataUrl(material, size), `${safeMaterialFilename(material.name)}${unitSuffix}-标签-${size.key}mm.png`);
  } catch (failure) {
    toast((failure as Error).message || '标签 PNG 生成失败');
  } finally {
    button.disabled = false;
  }
});
$<HTMLSelectElement>('[data-material-label-size]')?.addEventListener('change', () => {
  materialLabelPreviewDataUrl = '';
  materialLabelPreviewSignature = '';
  syncMaterialLabelControls();
  scheduleMaterialLabelPreview();
});
$$<HTMLInputElement>('[data-custom-label-width], [data-custom-label-height]').forEach((input) => input.addEventListener('input', () => {
  materialLabelPreviewDataUrl = '';
  materialLabelPreviewSignature = '';
  syncMaterialLabelControls();
  scheduleMaterialLabelPreview();
}));
$<HTMLSelectElement>('[data-material-print-layout]')?.addEventListener('change', () => syncMaterialLabelControls());
$<HTMLInputElement>('[data-material-print-copies]')?.addEventListener('input', () => syncMaterialLabelControls());
$<HTMLButtonElement>('[data-print-material-qr]')?.addEventListener('click', async () => {
  const material = state?.materials.find((candidate) => candidate.id === qrMaterialTargetId);
  if (!material || !qrMaterialDataUrl) return toast('二维码仍在生成，请稍后重试');
  try {
    const size = selectedMaterialLabelSize();
    const images = prepareMaterialPrintLabel(await materialLabelDataUrl(material, size), size);
    await printMaterialImages(images);
  } catch (failure) {
    document.body.classList.remove('printing-material-label');
    toast((failure as Error).message || '无法打开打印选项');
  }
});
$<HTMLFormElement>('[data-member-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ name: $<HTMLInputElement>('#member-name')?.value, username: $<HTMLInputElement>('#member-username')?.value, password: $<HTMLInputElement>('#member-password')?.value, role: $<HTMLSelectElement>('#member-role')?.value, groupId: $<HTMLSelectElement>('#member-group')?.value, tagIds: selectedTagIds('member'), note: $<HTMLTextAreaElement>('#member-note')?.value }) });
    form.reset();
    closeModals();
    await loadBootstrap();
    toast('成员账号已创建');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

type OrganizationSettingsView = 'groups' | 'tags';
let organizationSettingsView: OrganizationSettingsView = 'groups';

function ensureOrganizationSettingsTabs() {
  const panel = $('[data-settings-panel="groups"]');
  if (!panel || $('[data-organization-settings-tabs]', panel)) return;
  const sections = $$<HTMLElement>('.organization-settings-section', panel);
  if (sections.length !== 2) return;

  const tabs = document.createElement('div');
  tabs.className = 'segmented organization-settings-tabs';
  tabs.dataset.organizationSettingsTabs = '';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '组织与标签设置');
  tabs.innerHTML = '<button id="organization-settings-groups-tab" class="segment active" type="button" role="tab" aria-selected="true" aria-controls="organization-settings-groups" data-organization-settings-tab="groups">组织分组<span class="organization-settings-tab-count" data-groups-settings-count>0</span></button><button id="organization-settings-tags-tab" class="segment" type="button" role="tab" aria-selected="false" aria-controls="organization-settings-tags" data-organization-settings-tab="tags">成员标签<span class="organization-settings-tab-count" data-tags-settings-count>0</span></button>';

  const [groupsSection, tagsSection] = sections;
  groupsSection.id = 'organization-settings-groups';
  groupsSection.dataset.organizationSettingsPanel = 'groups';
  groupsSection.setAttribute('role', 'tabpanel');
  groupsSection.setAttribute('aria-labelledby', 'organization-settings-groups-tab');
  tagsSection.id = 'organization-settings-tags';
  tagsSection.dataset.organizationSettingsPanel = 'tags';
  tagsSection.setAttribute('role', 'tabpanel');
  tagsSection.setAttribute('aria-labelledby', 'organization-settings-tags-tab');
  panel.querySelector('.settings-section-heading')?.insertAdjacentElement('afterend', tabs);

  const groupsList = $('[data-groups-settings-list]', groupsSection);
  groupsList?.classList.add('settings-list-scroll');
  groupsList?.setAttribute('tabindex', '0');
  groupsList?.setAttribute('aria-label', '组织分组列表');
  const tagsList = $('[data-tags-settings-list]', tagsSection);
  tagsList?.classList.add('settings-list-scroll');
  tagsList?.setAttribute('tabindex', '0');
  tagsList?.setAttribute('aria-label', '成员标签列表');

  $$<HTMLButtonElement>('[data-organization-settings-tab]', tabs).forEach((button) => {
    button.addEventListener('click', () => selectOrganizationSettingsPanel(button.dataset.organizationSettingsTab === 'tags' ? 'tags' : 'groups'));
  });
  selectOrganizationSettingsPanel(organizationSettingsView);
}

function selectOrganizationSettingsPanel(view: OrganizationSettingsView) {
  organizationSettingsView = view;
  ensureOrganizationSettingsTabs();
  $$<HTMLButtonElement>('[data-organization-settings-tab]').forEach((button) => {
    const active = button.dataset.organizationSettingsTab === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  $$<HTMLElement>('[data-organization-settings-panel]').forEach((content) => {
    content.hidden = content.dataset.organizationSettingsPanel !== view;
  });
}

const selectSettingsPanel = (panel: 'lab' | 'groups' | 'account' | 'data') => {
  $$<HTMLButtonElement>('[data-settings-tab]').forEach((button) => {
    const active = button.dataset.settingsTab === panel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$<HTMLElement>('[data-settings-panel]').forEach((content) => { content.hidden = content.dataset.settingsPanel !== panel; });
  if (panel === 'groups') selectOrganizationSettingsPanel(organizationSettingsView);
};

let databaseRestoreToken = '';
let databaseBackupPanel: HTMLElement | null = null;
let databaseSettingsPanel: HTMLElement | null = null;

function cloneButtonIcon(sourceSelector: string) {
  const icon = document.querySelector<SVGElement>(`${sourceSelector} svg`);
  return icon?.cloneNode(true) as SVGElement | null;
}

function ensureDatabaseBackupPanel() {
  const accountPanel = $('[data-settings-panel="account"]');
  const settingsTabs = $('.settings-tabs');
  if (!accountPanel || !settingsTabs || databaseBackupPanel) return;
  databaseSettingsPanel = $('[data-settings-panel="data"]');
  if (!databaseSettingsPanel) {
    const dataTab = document.createElement('button');
    dataTab.className = 'segment';
    dataTab.type = 'button';
    dataTab.setAttribute('role', 'tab');
    dataTab.setAttribute('aria-selected', 'false');
    dataTab.dataset.settingsTab = 'data';
    dataTab.textContent = '数据管理';
    const dataTabIcon = cloneButtonIcon('[data-download-records]');
    if (dataTabIcon) dataTab.prepend(dataTabIcon);
    settingsTabs.append(dataTab);
    databaseSettingsPanel = document.createElement('div');
    databaseSettingsPanel.dataset.settingsPanel = 'data';
    databaseSettingsPanel.hidden = true;
    accountPanel.before(databaseSettingsPanel);
    dataTab.addEventListener('click', () => {
      if (!state?.user.isOwner) return;
      selectSettingsPanel('data');
    });
  }
  const section = document.createElement('section');
  section.className = 'database-backup-panel';
  section.innerHTML = '<div class="settings-section-heading"><span class="settings-section-icon" aria-hidden="true"></span><div><h3>数据备份与恢复</h3><p>仅系统所有者可以下载完整数据库，或从可信的 SQLite 备份恢复。</p></div></div><div class="import-warning"><span aria-hidden="true">!</span><span>恢复会替换当前库存、流水、账号和设置，并让所有成员重新登录。恢复前系统会自动保留一份 pre-restore 快照。</span></div><div class="database-backup-actions"><button class="button" type="button" data-download-database><span>下载数据库备份</span></button><div class="database-restore-form"><div class="field"><label for="database-restore-file">SQLite 备份文件</label><input id="database-restore-file" type="file" accept=".sqlite,.db,application/vnd.sqlite3" /></div><div class="field"><label for="database-restore-password">当前所有者密码</label><input id="database-restore-password" type="password" autocomplete="current-password" /></div><div class="database-restore-buttons"><button class="button tonal" type="button" data-authorize-database-restore><span>验证密码并授权</span></button><button class="button danger-filled" type="button" data-restore-database disabled><span>确认恢复数据库</span></button></div><span class="field-hint" data-database-restore-status>选择文件并验证密码后，授权有效 5 分钟。</span></div></div>';
  const downloadButton = $<HTMLButtonElement>('[data-download-database]', section)!;
  const downloadIcon = cloneButtonIcon('[data-download-records]');
  if (downloadIcon) $('.settings-section-icon', section)?.append(downloadIcon.cloneNode(true));
  if (downloadIcon) downloadButton.prepend(downloadIcon);
  const authorizeButton = $<HTMLButtonElement>('[data-authorize-database-restore]', section)!;
  const authorizeIcon = cloneButtonIcon('[data-open-import]');
  if (authorizeIcon) authorizeButton.prepend(authorizeIcon);
  const restoreButton = $<HTMLButtonElement>('[data-restore-database]', section)!;
  const fileInput = $<HTMLInputElement>('#database-restore-file', section)!;
  const passwordInput = $<HTMLInputElement>('#database-restore-password', section)!;
  const status = $('[data-database-restore-status]', section)!;
  const syncRestoreButton = () => { restoreButton.disabled = !databaseRestoreToken || !fileInput.files?.length; };
  fileInput.addEventListener('change', () => { databaseRestoreToken = ''; status.textContent = '文件已选择，请输入当前所有者密码并验证。'; syncRestoreButton(); });
  downloadButton.addEventListener('click', async () => {
    downloadButton.disabled = true;
    try {
      const response = await fetch('/api/admin/database-backup');
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? '数据库备份下载失败');
      }
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'OpenLabStock-database.sqlite';
      link.click();
      URL.revokeObjectURL(link.href);
      toast('数据库备份已下载');
    } catch (failure) { toast((failure as Error).message); }
    finally { downloadButton.disabled = false; }
  });
  authorizeButton.addEventListener('click', async () => {
    if (!state?.user.isOwner) return;
    authorizeButton.disabled = true;
    try {
      const result = await api<{ token: string }>('/api/admin/database-restore/authorize', { method: 'POST', body: JSON.stringify({ currentPassword: passwordInput.value }) });
      databaseRestoreToken = result.token;
      status.textContent = '密码验证通过。授权有效 5 分钟，请确认文件无误后恢复。';
      syncRestoreButton();
    } catch (failure) { databaseRestoreToken = ''; syncRestoreButton(); toast((failure as Error).message); }
    finally { authorizeButton.disabled = false; }
  });
  restoreButton.addEventListener('click', async () => {
    const file = fileInput.files?.[0];
    if (!file || !databaseRestoreToken) return;
    if (!await askConfirmation({ title: '确认替换数据库？', message: '这会覆盖当前库存、流水、成员和系统设置，所有成员需要重新登录。系统会先自动保存 pre-restore 快照。', confirmLabel: '替换并恢复' })) return;
    restoreButton.disabled = true;
    try {
      const response = await fetch('/api/admin/database-restore', { method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3', 'X-OpenLabStock-Restore-Token': databaseRestoreToken }, body: file });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? '数据库恢复失败');
      databaseRestoreToken = '';
      closeModals();
      showLogin('数据库已恢复，请使用备份中的账号重新登录');
    } catch (failure) { toast((failure as Error).message); syncRestoreButton(); }
  });
  databaseSettingsPanel.append(section);
  databaseBackupPanel = section;
}

function syncDatabaseBackupPanel() {
  ensureDatabaseBackupPanel();
  const isOwner = Boolean(state?.user.isOwner);
  databaseBackupPanel?.toggleAttribute('hidden', !isOwner);
  if (!isOwner && databaseSettingsPanel) databaseSettingsPanel.hidden = true;
  $('[data-settings-tab="data"]')?.classList.toggle('is-hidden', !isOwner);
  $('.settings-tabs')?.classList.toggle('owner-view', isOwner);
}

function openSettings(preferredPanel: 'default' | 'account' = 'default') {
  if (!state) return;
  setMobileDrawer(false);
  const appName = $<HTMLInputElement>('#settings-app-name');
  const labName = $<HTMLInputElement>('#settings-lab-name');
  if (appName) appName.value = state.settings.appName;
  if (labName) labName.value = state.settings.labName;
  brandIconDraft = state.settings.brandIcon;
  updateBrandPreview();
  const accountName = $('[data-settings-account-name]');
  const accountMeta = $('[data-settings-account-meta]');
  const accountAvatar = $('[data-settings-account-avatar]');
  if (accountName) accountName.textContent = state.user.name;
  if (accountMeta) accountMeta.textContent = `${state.user.username} · ${roleLabel(state.user)}`;
  if (accountAvatar) accountAvatar.textContent = initial(state.user.name);
  const profileName = $<HTMLInputElement>('#profile-name');
  const profileGroup = $<HTMLSelectElement>('#profile-group');
  const profileGroupField = $('[data-profile-group-field]');
  const profileNote = $<HTMLTextAreaElement>('#profile-note');
  if (profileName) profileName.value = state.user.name;
  profileGroupField?.toggleAttribute('hidden', state.user.role !== 'admin');
  if (profileGroup) {
    profileGroup.value = state.user.groupId;
    refreshM3Select(profileGroup);
  }
  if (profileNote) profileNote.value = state.user.note;
  renderTagPicker('profile', state.user.tagIds);
  $<HTMLFormElement>('[data-password-form]')?.reset();
  selectSettingsPanel(preferredPanel === 'account' ? 'account' : canManageMembers(state.user) ? 'lab' : 'account');
  openModal(settingsModal);
}

$<HTMLButtonElement>('[data-open-settings]')?.addEventListener('click', () => openSettings());
$$<HTMLButtonElement>('[data-open-account-settings]').forEach((button) => button.addEventListener('click', () => openSettings('account')));

$$<HTMLButtonElement>('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => {
  const panel = button.dataset.settingsTab;
  if ((panel === 'lab' || panel === 'groups') && (!state || !canManageMembers(state.user))) return;
  if (panel === 'data' && !state?.user.isOwner) return;
  selectSettingsPanel(panel === 'lab' || panel === 'groups' || panel === 'data' ? panel : 'account');
}));

function updateBrandPreview() {
  const image = $<HTMLImageElement>('[data-brand-preview-image]');
  const fallback = $('[data-brand-preview-default]');
  if (image) {
    image.hidden = !brandIconDraft;
    if (brandIconDraft) image.src = brandIconDraft;
    else image.removeAttribute('src');
  }
  fallback?.classList.toggle('is-hidden', Boolean(brandIconDraft));
  const remove = $<HTMLButtonElement>('[data-remove-brand]');
  if (remove) remove.disabled = !brandIconDraft;
}

$<HTMLInputElement>('#settings-brand-file')?.addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    toast('图标仅支持 PNG、JPG 或 WebP 图片');
    input.value = '';
    return;
  }
  if (file.size > 512 * 1024) {
    toast('图标大小不能超过 512 KB');
    input.value = '';
    return;
  }
  brandIconDraft = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('图标读取失败'));
    reader.readAsDataURL(file);
  });
  updateBrandPreview();
});

$<HTMLButtonElement>('[data-remove-brand]')?.addEventListener('click', () => {
  brandIconDraft = '';
  const input = $<HTMLInputElement>('#settings-brand-file');
  if (input) input.value = '';
  updateBrandPreview();
});

$<HTMLFormElement>('[data-lab-settings-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    const result = await api<{ settings: LabSettings }>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify({ appName: $<HTMLInputElement>('#settings-app-name')?.value, labName: $<HTMLInputElement>('#settings-lab-name')?.value, brandIcon: brandIconDraft }),
    });
    if (state) state.settings = result.settings;
    renderApp();
    toast('实验室信息已保存');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLFormElement>('[data-add-group-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api('/api/groups', { method: 'POST', body: JSON.stringify({ name: $<HTMLInputElement>('#new-group-name')?.value }) });
    form.reset();
    await loadBootstrap();
    selectSettingsPanel('groups');
    selectOrganizationSettingsPanel('groups');
    toast('分组已添加');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLElement>('[data-groups-settings-list]')?.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  const row = button?.closest<HTMLElement>('[data-group-id]');
  if (!button || !row?.dataset.groupId) return;
  const group = state?.groups.find((candidate) => candidate.id === row.dataset.groupId);
  if (!group) return;
  try {
    if (button.matches('[data-save-group]')) {
      await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $<HTMLInputElement>('[data-group-name]', row)?.value }) });
      toast('分组名称已保存');
    } else if (button.matches('[data-set-default-group]')) {
      await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
      toast('默认分组已更新');
    } else if (button.matches('[data-delete-group]')) {
      if (!await askConfirmation({ title: '删除分组？', message: `分组“${group.name}”将从系统中移除，此操作无法撤销。`, confirmLabel: '删除分组' })) return;
      await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: 'DELETE' });
      toast('分组已删除');
    } else return;
    await loadBootstrap();
    selectSettingsPanel('groups');
    selectOrganizationSettingsPanel('groups');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLFormElement>('[data-add-tag-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api('/api/tags', { method: 'POST', body: JSON.stringify({ name: $<HTMLInputElement>('#new-tag-name')?.value }) });
    form.reset();
    await loadBootstrap();
    selectSettingsPanel('groups');
    selectOrganizationSettingsPanel('tags');
    toast('成员标签已添加');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLElement>('[data-tags-settings-list]')?.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  const row = button?.closest<HTMLElement>('[data-tag-id]');
  if (!button || !row?.dataset.tagId) return;
  const tag = state?.tags.find((candidate) => candidate.id === row.dataset.tagId);
  if (!tag) return;
  try {
    if (button.matches('[data-save-tag]')) {
      await api(`/api/tags/${encodeURIComponent(tag.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $<HTMLInputElement>('[data-tag-name]', row)?.value }) });
      toast('标签名称已保存');
    } else if (button.matches('[data-delete-tag]')) {
      const memberCount = state?.members.filter((member) => member.tagIds.includes(tag.id)).length ?? 0;
      const detail = memberCount ? `当前有 ${memberCount} 位成员使用“${tag.name}”。删除后只会移除成员关联，不影响历史流水或分组消耗。` : `标签“${tag.name}”将从成员目录中移除。`;
      if (!await askConfirmation({ title: '删除成员标签？', message: detail, confirmLabel: '删除标签' })) return;
      await api(`/api/tags/${encodeURIComponent(tag.id)}`, { method: 'DELETE' });
      toast('成员标签已删除');
    } else return;
    await loadBootstrap();
    selectSettingsPanel('groups');
    selectOrganizationSettingsPanel('tags');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLFormElement>('[data-reset-member-password]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!memberActionTargetId) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api(`/api/users/${encodeURIComponent(memberActionTargetId)}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword: $<HTMLInputElement>('#member-reset-password')?.value }) });
    closeModals();
    toast('成员密码已重置');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLFormElement>('[data-owner-transfer-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const target = state?.members.find((candidate) => candidate.id === memberActionTargetId);
  if (!target || !state?.user.isOwner) return;
  if (!await askConfirmation({
    title: '转移系统所有权？',
    message: `“${target.name}”将成为唯一系统所有者。你会保留系统管理员身份，但之后不能再任命系统管理员或转移所有权。`,
    confirmLabel: '确认转移',
  })) return;
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api('/api/owner/transfer', {
      method: 'POST',
      body: JSON.stringify({ targetUserId: target.id, currentPassword: $<HTMLInputElement>('#owner-transfer-password')?.value }),
    });
    closeModals();
    await loadBootstrap();
    toast(`系统所有权已转移给 ${target.name}`);
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLFormElement>('[data-member-info-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!memberActionTargetId) return;
  const submit = $<HTMLButtonElement>('[data-save-member-info]');
  if (submit) submit.disabled = true;
  try {
    await api(`/api/users/${encodeURIComponent(memberActionTargetId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        username: $<HTMLInputElement>('#member-action-login')?.value,
        name: $<HTMLInputElement>('#member-action-name')?.value,
        role: $<HTMLSelectElement>('#member-action-role')?.value,
        groupId: $<HTMLSelectElement>('#member-action-group')?.value,
        tagIds: selectedTagIds('member-action'),
        note: $<HTMLTextAreaElement>('#member-action-note')?.value,
      }),
    });
    closeModals();
    await loadBootstrap();
    toast('成员信息已保存');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLFormElement>('[data-profile-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    const result = await api<{ user: User }>('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({
        name: $<HTMLInputElement>('#profile-name')?.value,
        groupId: state?.user.role === 'admin' ? $<HTMLSelectElement>('#profile-group')?.value : undefined,
        note: $<HTMLTextAreaElement>('#profile-note')?.value,
        tagIds: selectedTagIds('profile'),
      }),
    });
    if (state) state.user = result.user;
    await loadBootstrap();
    selectSettingsPanel('account');
    toast('个人资料已保存');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLFormElement>('[data-material-action-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    const creating = !materialActionTargetId;
    const previousMaterial = creating ? undefined : state?.materials.find((material) => material.id === materialActionTargetId);
    const previousTrackingMode = previousMaterial?.trackingMode ?? 'quantity';
    const selectedTrackingMode = $<HTMLSelectElement>('#edit-material-tracking-mode')?.value ?? 'quantity';
    const migrateQuantity = !creating && selectedTrackingMode === 'tracked' && previousTrackingMode !== 'tracked' && Boolean(previousMaterial && previousMaterial.quantity > 0);
    if (migrateQuantity && previousMaterial) {
      const sourceLabel = previousTrackingMode === 'stateful' ? '状态化' : '普通数量';
      const preservation = previousTrackingMode === 'stateful' ? '现有状态和使用范围也会保留' : '现有数量和流水会保持连续';
      const confirmed = await askConfirmation({
        title: '转为按批次 / 单件管理？',
        message: `当前还有 ${formatNumber(previousMaterial.quantity)} ${previousMaterial.unit} ${sourceLabel}库存。确认后系统会先将其保留在“历史库存（未分批）”批次，${preservation}；再进入库存明细补录真实批次和有效期。`,
        confirmLabel: '保留库存并继续',
      });
      if (!confirmed) return;
    }
    const result = await api<{ material: Material }>(creating ? '/api/materials' : `/api/materials/${encodeURIComponent(materialActionTargetId)}`, {
      method: creating ? 'POST' : 'PATCH',
      body: JSON.stringify({
        name: $<HTMLInputElement>('#edit-material-name')?.value,
        category: $<HTMLInputElement>('#edit-material-category')?.value,
        spec: $<HTMLInputElement>('#edit-material-spec')?.value,
        unit: $<HTMLInputElement>('#edit-material-unit')?.value,
        safetyStock: $<HTMLInputElement>('#edit-material-safety-stock')?.value,
        expiryWarningDays: $<HTMLInputElement>('#edit-material-expiry-warning-days')?.value,
        trackingMode: selectedTrackingMode,
        migrateQuantity,
        positionCodeHelp: $<HTMLTextAreaElement>('#edit-material-position-help')?.value,
        usageContextHelp: $<HTMLTextAreaElement>('#edit-material-usage-help')?.value,
      }),
    });
    closeModals();
    await loadBootstrap();
    const enteredDetailMode = result.material.trackingMode !== 'quantity' && (creating || previousTrackingMode !== result.material.trackingMode);
    if (enteredDetailMode) {
      toast(result.material.trackingMode === 'tracked'
        ? '耗材已保存，接下来请建立批次 / 单件并完成入库'
        : '耗材已保存，接下来请在库存明细中选择状态并入库');
      await openInventoryDetail(result.material.id);
    } else {
      toast(creating ? '耗材已新增，当前库存为 0' : '耗材信息已更新');
    }
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});
$<HTMLButtonElement>('[data-toggle-material-status]')?.addEventListener('click', async () => {
  const material = state?.materials.find((candidate) => candidate.id === materialActionTargetId);
  if (!material || !material.active) return;
  if (!await askConfirmation({
    title: '归档耗材？',
    message: `“${material.name}”将从日常库存、预警和出入库候选中隐藏，可随时从“已归档”筛选中恢复。`,
    confirmLabel: '归档耗材',
  })) return;
  try {
    await api(`/api/materials/${encodeURIComponent(material.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
    closeModals();
    await loadBootstrap();
    toast('耗材已归档');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLButtonElement>('[data-restore-material]')?.addEventListener('click', async () => {
  const material = state?.materials.find((candidate) => candidate.id === materialActionTargetId);
  if (!material || material.active) return;
  try {
    await api(`/api/materials/${encodeURIComponent(material.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
    closeModals();
    await loadBootstrap();
    toast('耗材已恢复使用');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLButtonElement>('[data-delete-material]')?.addEventListener('click', async () => {
  const material = state?.materials.find((candidate) => candidate.id === materialActionTargetId);
  if (!material || state?.user.role !== 'admin') return;
  if (!await askConfirmation({
    title: '永久删除耗材？',
    message: `“${material.name}”的耗材档案将不可恢复。已有出入库流水仍会保留，并继续显示当时记录的名称与单位。`,
    confirmLabel: '永久删除',
  })) return;
  try {
    await api(`/api/materials/${encodeURIComponent(material.id)}`, { method: 'DELETE' });
    closeModals();
    await loadBootstrap();
    toast('耗材档案已永久删除，历史流水已保留');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLButtonElement>('[data-toggle-member-status]')?.addEventListener('click', async () => {
  const member = state?.members.find((candidate) => candidate.id === memberActionTargetId);
  if (!member) return;
  try {
    await api(`/api/users/${encodeURIComponent(member.id)}/status`, { method: 'PATCH', body: JSON.stringify({ active: !member.active }) });
    closeModals();
    await loadBootstrap();
    toast(member.active ? '成员账号已停用' : '成员账号已启用');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLButtonElement>('[data-delete-member]')?.addEventListener('click', async () => {
  const member = state?.members.find((candidate) => candidate.id === memberActionTargetId);
  if (!member || !await askConfirmation({ title: '删除成员账号？', message: `成员“${member.name}”将无法登录，已有出入库流水会继续保留。`, confirmLabel: '删除账号' })) return;
  try {
    await api(`/api/users/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    closeModals();
    await loadBootstrap();
    toast('成员账号已删除');
  } catch (failure) {
    toast((failure as Error).message);
  }
});
$<HTMLFormElement>('[data-password-form]')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $<HTMLButtonElement>('button[type="submit"]', form);
  if (submit) submit.disabled = true;
  try {
    await api('/api/password', { method: 'POST', body: JSON.stringify({ currentPassword: $<HTMLInputElement>('#current-password')?.value, newPassword: $<HTMLInputElement>('#new-password')?.value }) });
    form.reset();
    closeModals();
    toast('密码已更新');
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    if (submit) submit.disabled = false;
  }
});

const applyInventoryFilters = () => {
  const query = $<HTMLInputElement>('[data-filter="inventory"]')?.value.trim().toLowerCase() ?? '';
  const status = $<HTMLSelectElement>('[data-filter-select="stock"]')?.value ?? 'active';
  $$<HTMLTableRowElement>('[data-inventory-body] tr').forEach((row) => {
    const matchesStatus = status === 'active'
      ? ['out', 'low', 'ok'].includes(row.dataset.stockStatus ?? '')
      : status === 'expired' || status === 'expiring'
        ? row.dataset[status] === 'true'
        : status === 'low'
          ? row.dataset.stockStatus === 'out' || row.dataset.stockStatus === 'low'
          : row.dataset.stockStatus === status;
    row.hidden = (query.length > 0 && !row.textContent?.toLowerCase().includes(query)) || !matchesStatus;
  });
};

const applyRecordFilters = () => {
  recordPage = 1;
  recordCursorHistory = [''];
  recordNextCursor = '';
  recordFrom = recordFilterFrom();
  void loadRecordPage(true);
};

$<HTMLInputElement>('[data-filter="inventory"]')?.addEventListener('input', applyInventoryFilters);
$<HTMLSelectElement>('[data-filter-select="stock"]')?.addEventListener('change', applyInventoryFilters);
$<HTMLInputElement>('[data-filter="records"]')?.addEventListener('input', () => {
  window.clearTimeout(recordSearchTimer);
  recordSearchTimer = window.setTimeout(applyRecordFilters, 250);
});
$<HTMLSelectElement>('select[data-record-type]')?.addEventListener('change', applyRecordFilters);
$<HTMLSelectElement>('select[data-record-range]')?.addEventListener('change', applyRecordFilters);
$$<HTMLButtonElement>('[data-record-scope]').forEach((button) => button.addEventListener('click', () => {
  recordScope = button.dataset.recordScope === 'mine' ? 'mine' : 'all';
  syncRecordScopeButtons();
  applyRecordFilters();
}));
const scrollToRecordPageStart = () => {
  $('.records-panel')?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
};
$<HTMLButtonElement>('[data-record-page-previous]')?.addEventListener('click', () => {
  if (recordPage <= 1) return;
  recordPage -= 1;
  void loadRecordPage(true);
  scrollToRecordPageStart();
});
$<HTMLButtonElement>('[data-record-page-next]')?.addEventListener('click', () => {
  if (!recordHasMore || !recordNextCursor) return;
  recordCursorHistory[recordPage] = recordNextCursor;
  recordPage += 1;
  void loadRecordPage(true);
  scrollToRecordPageStart();
});
$<HTMLInputElement>('[data-filter="members"]')?.addEventListener('input', applyMemberFilters);
$<HTMLSelectElement>('[data-member-role-filter]')?.addEventListener('change', applyMemberFilters);
$<HTMLSelectElement>('[data-member-group-filter]')?.addEventListener('change', applyMemberFilters);
$<HTMLSelectElement>('[data-member-tag-filter]')?.addEventListener('change', applyMemberFilters);

$<HTMLInputElement>('[data-global-search]')?.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  const query = event.currentTarget.value.trim().toLowerCase();
  if (!query || !state) return;
  const materialMatch = state.materials.find((material) => `${material.name} ${material.category} ${material.spec}`.toLowerCase().includes(query));
  if (materialMatch) {
    switchView('inventory');
    const filter = $<HTMLSelectElement>('[data-filter-select="stock"]');
    if (filter && !materialMatch.active && canManageInventory(state.user)) { filter.value = 'archived'; refreshM3Select(filter); }
    const search = $<HTMLInputElement>('[data-filter="inventory"]');
    if (search) { search.value = query; applyInventoryFilters(); }
    return;
  }
  try {
    const inventoryMatch = await api<{ units: InventoryUnit[] }>(`/api/inventory-units?q=${encodeURIComponent(query)}`);
    if (inventoryMatch.units.length) {
      switchView('inventory');
      await openInventoryDetail('', inventoryMatch.units[0].id);
      const trackingSearch = $<HTMLInputElement>('[data-tracking-search]');
      if (trackingSearch) {
        trackingSearch.value = query;
        renderInventoryUnits();
      }
      if (inventoryMatch.units.length > 1) toast(`找到 ${inventoryMatch.units.length} 个库存单元，已打开首个结果`);
      return;
    }
  } catch (failure) {
    console.warn('Inventory unit search failed', failure);
  }
  try {
    const recordMatch = await api<RecordPageResponse>(currentRecordPageUrl({ pageSize: 1, queryOverride: query, typeOverride: 'all', scopeOverride: 'all' }));
    if (recordMatch.total) {
      switchView('transactions');
      const search = $<HTMLInputElement>('[data-filter="records"]');
      if (search) { search.value = query; applyRecordFilters(); }
      return;
    }
  } catch (failure) {
    console.warn('Record search failed', failure);
  }
  toast('没有找到匹配的库存或记录');
});

$<HTMLButtonElement>('[data-open-notifications]')?.addEventListener('click', () => openModal(notificationsModal));
const showLowStockInventory = () => {
  closeModals();
  switchView('inventory');
  const search = $<HTMLInputElement>('[data-filter="inventory"]');
  if (search) search.value = '';
  const filter = $<HTMLSelectElement>('[data-filter-select="stock"]');
  if (filter) {
    filter.value = 'low';
    refreshM3Select(filter);
  }
  applyInventoryFilters();
};
const showExpiryInventory = (status: 'expired' | 'expiring') => {
  closeModals();
  switchView('inventory');
  const search = $<HTMLInputElement>('[data-filter="inventory"]');
  if (search) search.value = '';
  const filter = $<HTMLSelectElement>('[data-filter-select="stock"]');
  if (filter) {
    filter.value = status;
    refreshM3Select(filter);
  }
  applyInventoryFilters();
};
$<HTMLButtonElement>('[data-notifications-inventory]')?.addEventListener('click', showLowStockInventory);
$<HTMLButtonElement>('[data-show-low-stock]')?.addEventListener('click', showLowStockInventory);
$$<HTMLButtonElement>('[data-show-expiry]').forEach((button) => button.addEventListener('click', () => {
  showExpiryInventory(button.dataset.showExpiry === 'expired' ? 'expired' : 'expiring');
}));
$<HTMLButtonElement>('[data-retry-records]')?.addEventListener('click', () => { void loadRecordPage(true); });

const applyAuditFilters = () => {
  auditPage = 1;
  auditCursorHistory = [''];
  auditNextCursor = '';
  void loadAuditPage(true);
};
$<HTMLInputElement>('[data-filter="audit"]')?.addEventListener('input', () => {
  window.clearTimeout(auditSearchTimer);
  auditSearchTimer = window.setTimeout(applyAuditFilters, 250);
});
$$<HTMLSelectElement>('[data-audit-type], [data-audit-range], [data-audit-actor]').forEach((select) => select.addEventListener('change', applyAuditFilters));
$<HTMLButtonElement>('[data-retry-audit]')?.addEventListener('click', () => { void loadAuditPage(true); });
$<HTMLButtonElement>('[data-audit-page-previous]')?.addEventListener('click', () => {
  if (auditPage <= 1) return;
  auditPage -= 1;
  void loadAuditPage(true);
  $('.audit-panel')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
$<HTMLButtonElement>('[data-audit-page-next]')?.addEventListener('click', () => {
  if (!auditHasMore || !auditNextCursor) return;
  auditCursorHistory[auditPage] = auditNextCursor;
  auditPage += 1;
  void loadAuditPage(true);
  $('.audit-panel')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
$<HTMLElement>('[data-audit-body]')?.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-audit-detail]');
  const item = button ? auditPageItems.find((candidate) => candidate.id === button.dataset.auditDetail) : null;
  if (item) openAuditDetail(item);
});
$<HTMLButtonElement>('[data-download-audit]')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.classList.add('is-loading');
  try {
    const result = await api<AuditPageResponse>(currentAuditPageUrl({ exportAll: true }));
    downloadCsv(`${exportPrefix()}-系统审计-${new Date().toISOString().slice(0, 10)}.csv`, [
      ['时间', '操作者', '操作者身份', '操作', '对象类型', '对象名称', '摘要', '来源 IP', '请求编号', '变更前', '变更后'],
      ...result.items.map((item) => [item.occurredAt, item.actorName, auditRoleLabel[item.actorRole] ?? item.actorRole, auditActionLabel[item.action] ?? item.action, auditTypeLabel[item.targetType] ?? item.targetType, item.targetName, item.summary, item.sourceIp, item.requestId, item.before ? JSON.stringify(item.before) : '', item.after ? JSON.stringify(item.after) : '']),
    ]);
  } catch (failure) {
    toast((failure as Error).message);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
  }
});

function downloadCsv(filename: string, rows: Array<Array<unknown>>) {
  const serializeCell = (cell: unknown) => {
    const raw = String(cell ?? '');
    const safe = /^[\t\r\n ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const content = `\ufeff${rows.map((row) => row.map(serializeCell).join(',')).join('\n')}\n`;
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

$$<HTMLButtonElement>('[data-download-template]').forEach((button) => button.addEventListener('click', () => {
  downloadCsv(`${exportPrefix()}-导入模板.csv`, [['耗材名称', '分类', '当前库存', '安全库存', '单位', '规格'], ['示例耗材', '塑料耗材', 20, 10, '盒', '100只/盒']]);
  toast('模板已下载');
}));
$<HTMLButtonElement>('[data-download-inventory]')?.addEventListener('click', async (event) => {
  if (!state) return;
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  try {
    if (!await ensureExportRecordsLoaded()) return;
    const currentSnapshot = exportSnapshot;
    if (!currentSnapshot) return;
    const XLSX = await loadXlsx();
    const operationalMaterials = currentSnapshot.materials.filter((material) => material.active);
    const lowStock = operationalMaterials.filter((material) => material.availableQuantity <= material.safetyStock);
    const importableMaterials = operationalMaterials.filter((material) => material.trackingMode === 'quantity');
    const categories = [...new Set(operationalMaterials.map((material) => material.category))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const statsByMaterial = new Map(currentSnapshot.materialStats.map((item) => [item.materialId, item]));
    const summariesByMaterial = new Map(currentSnapshot.inventorySummaries.map((item) => [item.materialId, item]));
    const allTransactions = currentSnapshot.transactions;
    const manualOutbound = effectiveManualOutboundTransactions(allTransactions);
    const groupedConsumption = groupConsumptionRows(allTransactions, currentSnapshot.materials);
    const expiryAlerts = currentSnapshot.expiryAlerts ?? [];
    const expiredMaterialCount = new Set(expiryAlerts.filter((alert) => alert.status === 'expired').map((alert) => alert.materialId)).size;
    const expiringMaterialCount = new Set(expiryAlerts.filter((alert) => alert.status === 'expiring').map((alert) => alert.materialId)).size;
    const exportedAt = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(currentSnapshot.exportedAt));
    const overview = XLSX.utils.aoa_to_sheet([
      ['库存统计'],
      ['实验室', currentSnapshot.settings.labName],
      ['导出时间', exportedAt],
      ['耗材品类', operationalMaterials.length],
      ['耗材分类', categories.length],
      ['库存预警', lowStock.length],
      ['库存正常', operationalMaterials.length - lowStock.length],
      ['过期批次品类', expiredMaterialCount],
      ['临期批次品类', expiringMaterialCount],
      ['已归档档案', currentSnapshot.materials.length - operationalMaterials.length],
      ['统计口径', '概览、分类和可导入库存仅统计使用中耗材；逐耗材统计同时保留已归档档案'],
      ['分组消耗口径', '只统计网页手工登记的出库；按流水发生时的唯一组织分组归属，不含 Excel 库存调整'],
      ['标签口径', '成员标签可多选，仅用于职责说明与筛选，不参与消耗汇总，避免重复计算'],
    ]);
    overview['!cols'] = [{ wch: 14 }, { wch: 48 }];
    const categoryStats = XLSX.utils.aoa_to_sheet([
      ['分类', '耗材品类', '库存预警'],
      ...categories.map((category) => {
        const materials = operationalMaterials.filter((material) => material.category === category);
        return [category, materials.length, materials.filter((material) => material.availableQuantity <= material.safetyStock).length];
      }),
    ]);
    categoryStats['!cols'] = [{ wch: 24 }, { wch: 12 }, { wch: 12 }];
    const groupOverview = XLSX.utils.aoa_to_sheet([
      ['组织分组', '启用成员', '手工出库记录', '涉及耗材', '最近出库'],
      ...currentSnapshot.groups.map((group) => {
        const records = manualOutbound.filter((record) => record.groupId === group.id);
        return [
          group.name,
          currentSnapshot.directory.filter((member) => member.groupId === group.id).length,
          records.length,
          new Set(records.map((record) => record.materialId)).size,
          formatExportTime(records.reduce<string | null>((latest, record) => !latest || record.occurredAt > latest ? record.occurredAt : latest, null)),
        ];
      }),
    ]);
    groupOverview['!cols'] = [{ wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 20 }];
    const groupConsumption = XLSX.utils.aoa_to_sheet([
      ['组织分组', '耗材名称', '分类', '规格', '累计出库', '单位', '出库记录', '操作成员', '最近出库'],
      ...groupedConsumption.map((item) => [
        item.groupName,
        item.materialName,
        item.category,
        item.spec,
        item.quantity,
        item.unit,
        item.records,
        [...item.members].sort((a, b) => a.localeCompare(b, 'zh-CN-u-co-pinyin')).join('、'),
        formatExportTime(item.lastOutAt),
      ]),
    ]);
    groupConsumption['!cols'] = [
      { wch: 22 }, { wch: 28 }, { wch: 18 }, { wch: 24 }, { wch: 12 },
      { wch: 10 }, { wch: 12 }, { wch: 28 }, { wch: 20 },
    ];
    const inventory = XLSX.utils.aoa_to_sheet([
      ['耗材名称', '分类', '规格', '开放可用库存', '库存总数', '单位', '安全库存', '管理方式', '档案状态', '库存状态', '有效期状态', '过期数量', '临期数量', '累计入库', '累计出库', '入库记录', '出库记录', '最近入库', '最近出库', '历史其他单位', '最近更新'],
      ...currentSnapshot.materials.map((material) => {
        const materialStats = statsByMaterial.get(material.id);
        const summary = summariesByMaterial.get(material.id);
        const unitStats = materialStats?.currentUnit ?? { totalIn: 0, totalOut: 0, inRecords: 0, outRecords: 0 };
        const otherUnits = materialStats?.otherUnits.map((item) => (
          `${item.unit}：入库 ${formatNumber(item.totalIn)}，出库 ${formatNumber(item.totalOut)}`
        )).join('；') || '-';
        return [
          material.name,
          material.category,
          material.spec,
          material.availableQuantity,
          material.quantity,
          material.unit,
          material.safetyStock,
          material.trackingMode === 'quantity' ? '普通数量' : material.trackingMode === 'stateful' ? '按状态统计' : '按批次 / 单件管理',
          material.active ? '使用中' : '已归档',
          material.active ? (material.availableQuantity <= material.safetyStock ? '库存预警' : '库存正常') : '不参与日常库存',
          material.trackingMode === 'quantity' ? '未启用批次有效期' : summary?.expired ? '有过期批次' : summary?.expiring ? '有临期批次' : '无临期或过期库存',
          summary?.expired ?? 0,
          summary?.expiring ?? 0,
          unitStats.totalIn,
          unitStats.totalOut,
          unitStats.inRecords,
          unitStats.outRecords,
          formatExportTime(materialStats?.lastInAt ?? null),
          formatExportTime(materialStats?.lastOutAt ?? null),
          otherUnits,
          formatExportTime(material.updatedAt),
        ];
      }),
    ]);
    inventory['!cols'] = [
      { wch: 28 }, { wch: 18 }, { wch: 24 }, { wch: 14 }, { wch: 12 },
      { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 12 }, { wch: 14 },
      { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 11 }, { wch: 11 }, { wch: 19 }, { wch: 19 }, { wch: 34 }, { wch: 19 },
    ];
    const expiryRows = [
      ['耗材名称', '分类', '规格', '库存单元', '单元类型', '库存数量', '可用数量', '有效期', '有效期状态', '剩余天数', '档案状态'],
      ...currentSnapshot.inventoryUnits
        .filter((unit) => currentSnapshot.materials.some((material) => material.id === unit.materialId) && unit.expiry.status !== 'none')
        .map((unit) => {
          const material = currentSnapshot.materials.find((candidate) => candidate.id === unit.materialId)!;
          const available = unit.balances.filter((balance) => balance.usable && unit.expiry.status !== 'expired').reduce((sum, balance) => sum + balance.quantity, 0);
          return [
            material.name,
            material.category,
            material.spec,
            unit.displayLabel,
            unit.unitType === 'container' ? '盒 / 容器' : unit.unitType === 'lot' ? '批次' : unit.unitType === 'position' ? '序列 / 单件' : '总库存',
            unit.quantity,
            available,
            unit.expiry.expiryDate,
            unit.expiry.status === 'expired' ? '已过期' : unit.expiry.status === 'expiring' ? '临期' : '正常',
            unit.expiry.daysRemaining ?? '',
            unit.active ? '使用中' : '已归档',
          ];
        }),
    ];
    const expirySheet = XLSX.utils.aoa_to_sheet(expiryRows);
    expirySheet['!cols'] = [
      { wch: 28 }, { wch: 16 }, { wch: 22 }, { wch: 28 }, { wch: 13 },
      { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    ];
    const importableInventory = XLSX.utils.aoa_to_sheet([
      ['耗材名称', '分类', '当前库存', '安全库存', '单位', '规格'],
      ...importableMaterials.map((material) => [
        material.name,
        material.category,
        material.quantity,
        material.safetyStock,
        material.unit,
        material.spec,
      ]),
    ]);
    importableInventory['!cols'] = [
      { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 24 },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, overview, '库存概览');
    XLSX.utils.book_append_sheet(workbook, categoryStats, '分类统计');
    XLSX.utils.book_append_sheet(workbook, groupOverview, '组织分组概览');
    XLSX.utils.book_append_sheet(workbook, groupConsumption, '分组耗材消耗');
    XLSX.utils.book_append_sheet(workbook, inventory, '逐耗材统计');
    XLSX.utils.book_append_sheet(workbook, expirySheet, '批次有效期');
    XLSX.utils.book_append_sheet(workbook, importableInventory, '可导入库存');
    XLSX.writeFile(workbook, `${exportPrefix()}-库存统计-${localDateTimeValue().slice(0, 10)}.xlsx`);
    toast('库存统计已导出');
  } catch (failure) {
    toast((failure as Error).message || '库存统计导出失败');
  } finally {
    button.disabled = false;
  }
});
$<HTMLButtonElement>('[data-download-records]')?.addEventListener('click', async (event) => {
  if (!state) return;
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  try {
    if (!await ensureExportRecordsLoaded()) return;
    const currentSnapshot = exportSnapshot;
    if (!currentSnapshot) return;
    const transactionRowsForExport = currentSnapshot.transactions.map((record) => [
      record.occurredAt, record.correctionOfId ? '更正冲销' : record.type === 'in' ? '入库' : '出库', record.materialName, record.quantity, record.unit,
      record.userName, record.groupName || '历史未归属', record.sourceType === 'inventory_adjustment' ? 'Excel 库存调整' : '手工登记',
      record.operation === 'dispose' ? '处置' : record.correctionOfId ? '反向冲销' : '库存变更', record.inventoryUnitLabel ?? '', record.statusName ?? '',
      record.accessScope === 'user' ? '成员自用' : record.accessScope === 'shared' ? '开放使用' : '', record.ownerName ?? '', record.counterparty,
      record.type === 'in' ? '供应商' : record.operation === 'dispose' ? '处置去向' : '房间号 / 领用人 / 项目', record.note,
    ]);
    const eventRowsForExport = currentSnapshot.inventoryEvents.map((event) => [
      event.occurredAt, eventTypeLabel(event), event.materialName, event.quantity,
      currentSnapshot.materials.find((material) => material.id === event.materialId)?.unit ?? '', event.userName, event.groupName || '历史未归属',
      '库存明细事件', eventTypeLabel(event), event.inventoryUnitLabel, `${event.fromStatusName || '-'} → ${event.toStatusName || '-'}`,
      `${event.fromAccessScope === 'user' ? '成员自用' : event.fromAccessScope === 'shared' ? '开放使用' : '-'} → ${event.toAccessScope === 'user' ? '成员自用' : event.toAccessScope === 'shared' ? '开放使用' : '-'}`,
      `${event.fromOwnerName || '-'} → ${event.toOwnerName || '-'}`, ['use', 'use_correction'].includes(event.eventType) ? event.counterparty : eventChangeLabel(event), ['use', 'use_correction'].includes(event.eventType) ? '使用位置 / 项目' : '状态 / 使用范围 / 位置变更', event.note,
    ]);
    const allRows = [...transactionRowsForExport, ...eventRowsForExport].sort((left, right) => new Date(String(right[0])).valueOf() - new Date(String(left[0])).valueOf());
    downloadCsv(`${exportPrefix()}-库存审计记录.csv`, [['时间', '类型', '耗材', '数量', '单位', '操作人', '发生时组织分组', '记录来源', '库存操作', '库存单元 / 位置', '库存状态', '使用范围', '自用成员', '来源 / 去向或变更内容', '字段类型', '备注'], ...allRows]);
    toast('记录已导出');
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('click', (event) => {
  if (!(event.target as Element).closest('.m3-select, .m3-autocomplete')) closeM3Menus();
});
document.addEventListener('reset', (event) => {
  window.setTimeout(() => $$<HTMLSelectElement>('select[data-m3-enhanced]', event.target as HTMLFormElement).forEach(refreshM3Select));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    const topmostBackdrop = $$<HTMLElement>('.modal-backdrop.open').at(-1);
    const dialog = topmostBackdrop ? $<HTMLElement>('.modal', topmostBackdrop) : null;
    if (!dialog) return;
    const focusable = $$<HTMLElement>('button:not(:disabled), input:not(:disabled):not([aria-hidden="true"]), textarea:not(:disabled)', dialog)
      .filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  if (event.key !== 'Escape') return;
  if ($('.m3-select.open, .m3-autocomplete.open')) {
    closeM3Menus();
    return;
  }
  if (confirmModal?.classList.contains('open')) {
    finishConfirmation(false);
    return;
  }
  if (scannerModal?.classList.contains('open')) {
    closeScanner();
    return;
  }
  if (materialQrModal?.classList.contains('open')) {
    closeMaterialQr();
    return;
  }
  if (inventoryOperationModal?.classList.contains('open')) {
    closeInventoryOperation();
    return;
  }
  if (inventoryUnitEditModal?.classList.contains('open')) {
    closeInventoryUnitEdit();
    return;
  }
  if (inventoryDetailModal?.classList.contains('open')) {
    void closeInventoryDetail();
    return;
  }
  closeModals();
});
enhanceM3Selects();
enhanceM3Autocompletes();
beginWorkspaceLoading();
$<HTMLButtonElement>('[data-retry-startup]')?.addEventListener('click', () => window.location.reload());
void initialize();
