export function terminalStateConfirmation(operation, targetStatus, balance) {
  if (operation !== 'state_change' || !targetStatus?.terminal || !balance) return null;
  return {
    title: '将库存标记为不可用？',
    message: `“${balance.displayCode}”将变更为“${targetStatus.name}”。不可用库存不能继续登记使用；如需恢复，须由库存管理员修正状态。`,
    confirmLabel: '确认标记不可用',
  };
}
