/** Deliberate UI confirmation only. Never identity proof or API authorization. */
export function matchesCabinetConfirmation(displayId: string | undefined, entered: string): boolean {
  return typeof displayId === 'string' && /^[0-9]{10}$/.test(displayId) && entered === displayId;
}
