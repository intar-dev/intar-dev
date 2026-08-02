const MAX_RUNTIME_VM_NAME_LENGTH = 63;

export function deterministicRuntimeVmName(
  prefix: string,
  runId: string,
  index: number,
): string {
  const discriminator = `${runId.slice(0, 6)}-${index + 1}`;
  const stemBudget = MAX_RUNTIME_VM_NAME_LENGTH - discriminator.length - 1;
  const stem = prefix.slice(0, stemBudget).replace(/-+$/, "") || "vm";

  return `${stem}-${discriminator}`;
}
