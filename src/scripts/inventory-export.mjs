export function effectiveManualOutboundTransactions(transactions) {
  const correctedQuantities = new Map();
  for (const record of transactions) {
    if (!record.correctionOfId) continue;
    correctedQuantities.set(
      record.correctionOfId,
      (correctedQuantities.get(record.correctionOfId) ?? 0) + Number(record.quantity ?? 0),
    );
  }

  return transactions
    .filter((record) => record.type === 'out' && record.sourceType === 'manual' && !record.correctionOfId)
    .map((record) => ({
      ...record,
      quantity: Math.max(0, Number(record.quantity) - (correctedQuantities.get(record.id) ?? 0)),
    }))
    .filter((record) => record.quantity > 1e-9);
}

export function groupConsumptionRows(transactions, materials) {
  const materialsById = new Map(materials.map((material) => [material.id, material]));
  const grouped = new Map();
  for (const record of effectiveManualOutboundTransactions(transactions)) {
    const quantity = record.quantity;
    const groupName = String(record.groupName || '历史未归属');
    const groupIdentity = record.groupId ? `${record.groupId}\u0000${groupName}` : `legacy:${groupName}`;
    const key = `${groupIdentity}\u0000${record.materialId}\u0000${record.unit}`;
    const material = materialsById.get(record.materialId);
    const item = grouped.get(key) ?? {
      groupName,
      materialName: record.materialName,
      category: material?.category ?? '-',
      spec: material?.spec ?? '-',
      quantity: 0,
      unit: record.unit,
      records: 0,
      members: new Set(),
      lastOutAt: record.occurredAt,
    };
    item.quantity += quantity;
    item.records += 1;
    item.members.add(record.userName);
    if (record.occurredAt > item.lastOutAt) item.lastOutAt = record.occurredAt;
    grouped.set(key, item);
  }

  return [...grouped.values()].sort((left, right) => (
    left.groupName.localeCompare(right.groupName, 'zh-CN-u-co-pinyin')
    || left.materialName.localeCompare(right.materialName, 'zh-CN-u-co-pinyin')
    || left.unit.localeCompare(right.unit, 'zh-CN')
  ));
}
