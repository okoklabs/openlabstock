export function inventoryAnomalyEntryLabel(entry) {
  const scope = entry.accessScope === 'user'
    ? `自用 · ${entry.ownerName || '未知成员'}`
    : '开放使用';
  return `${entry.statusName} · ${scope}`;
}

export function inventoryAnomalyResolutionBody(target, toPositionCode, reason) {
  return JSON.stringify({
    inventoryUnitId: target.anomaly.inventoryUnitId,
    fromStatusId: target.entry.statusId,
    fromAccessScope: target.entry.accessScope,
    fromOwnerUserId: target.entry.ownerUserId,
    fromPositionCode: target.entry.positionCode,
    toPositionCode,
    reason,
  });
}
