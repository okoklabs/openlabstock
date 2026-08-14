const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function measureMobileViewport(viewport, fallbackHeight) {
  return {
    height: Math.max(1, Math.ceil(finiteNumber(viewport?.height, fallbackHeight))),
    offsetTop: Math.max(0, Math.floor(finiteNumber(viewport?.offsetTop, 0))),
  };
}

export function detectMobileKeyboard({ mobile, focusedInsideModal, baselineHeight, height, offsetTop }) {
  if (!mobile || !focusedInsideModal) return false;
  return offsetTop > 1 || finiteNumber(baselineHeight, height) - height > 80;
}
