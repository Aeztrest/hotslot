/**
 * A state key identifies one piece of state a transaction can depend on:
 *   "<address>:<slot>"     a storage slot (slot is a 32-byte hex word)
 *   "<address>:balance"    an account's native balance
 *   "<address>:nonce"      an account's nonce
 *   "<address>:page:<n>"   a 128-slot storage page (MIP-8), used for page-granularity analysis
 * Addresses and slots are lowercase so keys compare as plain strings.
 */
export type StateKey = string;

export function storageKey(address: string, slot: string): StateKey {
  return `${address.toLowerCase()}:${normalizeWord(slot)}`;
}

export function accountKey(address: string, field: "balance" | "nonce"): StateKey {
  return `${address.toLowerCase()}:${field}`;
}

export function parseKey(key: StateKey): { address: string; slot: string; isStorage: boolean } {
  const i = key.indexOf(":");
  const address = key.slice(0, i);
  const slot = key.slice(i + 1);
  return { address, slot, isStorage: slot.startsWith("0x") || slot.startsWith("page:") };
}

/** Storage slot or storage page, as opposed to balance/nonce. */
export function isStorageKey(key: StateKey): boolean {
  return key.includes(":0x") || key.includes(":page:");
}

export function normalizeWord(word: string): string {
  return "0x" + BigInt(word).toString(16).padStart(64, "0");
}
