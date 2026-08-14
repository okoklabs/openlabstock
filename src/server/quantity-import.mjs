import { randomUUID } from 'node:crypto';

export function normalizedMaterialName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\-_/\\()（）\[\]【】]+/g, '');
}

function failure(status, error) {
  return { ok: false, status, error };
}

export function planQuantityImport({ rows, materials, user, group, occurredAt = new Date().toISOString(), createId = randomUUID }) {
  if (!Array.isArray(rows) || rows.length === 0) return failure(400, '文件中没有可导入的数据');
  if (rows.length > 500) return failure(400, '单次最多导入 500 行，请拆分文件后重试');

  const normalizedRows = [];
  const names = new Set();
  for (const [index, raw] of rows.entries()) {
    const rowNumber = index + 2;
    const name = String(raw?.name ?? '').trim();
    const category = String(raw?.category ?? '').trim();
    const quantity = Number(raw?.quantity);
    const safetyStock = raw?.safetyStock === '' || raw?.safetyStock === undefined ? 0 : Number(raw.safetyStock);
    const unit = String(raw?.unit ?? '').trim();
    const spec = String(raw?.spec ?? '').trim();
    if (!name || name.length > 120) return failure(400, `第 ${rowNumber} 行：耗材名称需为 1-120 个字符`);
    if (!Number.isFinite(quantity) || quantity < 0) return failure(400, `第 ${rowNumber} 行：当前库存必须是大于或等于 0 的数字`);
    if (category.length > 80) return failure(400, `第 ${rowNumber} 行：分类不能超过 80 个字符`);
    if (!Number.isFinite(safetyStock) || safetyStock < 0) return failure(400, `第 ${rowNumber} 行：安全库存必须是大于或等于 0 的数字`);
    if (unit.length > 20) return failure(400, `第 ${rowNumber} 行：单位不能超过 20 个字符`);
    if (spec.length > 120) return failure(400, `第 ${rowNumber} 行：规格、型号不能超过 120 个字符`);
    const normalizedName = normalizedMaterialName(name);
    if (names.has(normalizedName)) return failure(400, `第 ${rowNumber} 行：文件中存在重复耗材“${name}”`);
    names.add(normalizedName);
    normalizedRows.push({ name, category, quantity, safetyStock, unit, spec, normalizedName });
  }

  const materialChanges = [];
  const transactions = [];
  const materialsByExactName = new Map(materials.map((material) => [material.name.toLowerCase(), material]));
  const materialsByNormalizedName = new Map(materials.map((material) => [normalizedMaterialName(material.name), material]));
  for (const raw of normalizedRows) {
    const existing = materialsByExactName.get(raw.name.toLowerCase());
    const duplicate = existing ? null : materialsByNormalizedName.get(raw.normalizedName);
    if (duplicate) return failure(409, `耗材“${raw.name}”可能与已有耗材“${duplicate.name}”重复，请统一名称后再导入`);
    if (existing && !existing.active) return failure(409, `耗材“${existing.name}”已归档，请先恢复后再导入`);
    if (existing && existing.trackingMode !== 'quantity') return failure(409, `耗材“${existing.name}”启用了状态化库存，请使用库存单元导入，不能用普通库存表覆盖`);
    if (existing && raw.unit && raw.unit !== existing.unit && existing.quantity !== 0) {
      return failure(409, `耗材“${existing.name}”当前仍有 ${existing.quantity} ${existing.unit} 库存，不能通过导入改为“${raw.unit}”`);
    }

    const delta = existing ? raw.quantity - existing.quantity : raw.quantity;
    const material = existing ? {
      ...existing,
      category: raw.category || existing.category,
      quantity: raw.quantity,
      safetyStock: raw.safetyStock,
      unit: raw.unit || existing.unit,
      spec: raw.spec,
      updatedAt: occurredAt,
    } : {
      id: createId(), name: raw.name, category: raw.category || '未分类', quantity: raw.quantity,
      safetyStock: raw.safetyStock, unit: raw.unit || '件', spec: raw.spec, trackingMode: 'quantity',
      positionCodeHelp: '', usageContextHelp: '', active: true, updatedAt: occurredAt,
    };
    materialChanges.push(material);
    if (delta === 0) continue;
    transactions.push({
      id: createId(), type: delta > 0 ? 'in' : 'out', materialId: material.id, materialName: material.name,
      quantity: Math.abs(delta), unit: material.unit, userId: user.id, userName: user.name,
      groupId: group?.id ?? '', groupName: group?.name ?? '', sourceType: 'inventory_adjustment',
      counterparty: 'Excel 批量导入', note: existing ? 'Excel 导入库存调整' : 'Excel 导入期初库存', occurredAt,
      operation: 'stock', inventoryUnitId: '', inventoryUnitLabel: '', statusId: '', statusName: '',
      accessScope: '', ownerUserId: '', ownerName: '', positionCode: '', correctionOfId: '',
    });
  }

  return {
    ok: true,
    imported: materialChanges.length,
    adjustments: transactions.length,
    materials: materialChanges,
    transactions,
  };
}
