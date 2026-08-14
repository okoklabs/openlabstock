export const materialIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const inventoryUnitIdPattern = materialIdPattern;

function createInventoryPayload(parameter, id, currentUrl) {
  if (!materialIdPattern.test(id)) throw new TypeError(`Invalid ${parameter} ID`);
  const url = new URL(currentUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(parameter, id);
  return url.toString();
}

export function createMaterialQrPayload(materialId, currentUrl) {
  return createInventoryPayload('material', materialId, currentUrl);
}

export function createInventoryUnitQrPayload(unitId, currentUrl) {
  return createInventoryPayload('unit', unitId, currentUrl);
}

export function materialIdFromQrText(value) {
  const text = String(value ?? '').trim();
  if (materialIdPattern.test(text)) return text;

  try {
    const materialId = new URL(text).searchParams.get('material') ?? '';
    return materialIdPattern.test(materialId) ? materialId : '';
  } catch {
    return '';
  }
}

export function inventoryUnitIdFromQrText(value) {
  const text = String(value ?? '').trim();
  try {
    const unitId = new URL(text).searchParams.get('unit') ?? '';
    return inventoryUnitIdPattern.test(unitId) ? unitId : '';
  } catch {
    return '';
  }
}

export function inventoryTargetFromQrText(value) {
  const unitId = inventoryUnitIdFromQrText(value);
  if (unitId) return { type: 'unit', id: unitId };
  const materialId = materialIdFromQrText(value);
  return materialId ? { type: 'material', id: materialId } : null;
}
