import type { ContractLabel } from "@hotslot/core/report";

export const x = (v: number) => `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}×`;
export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const int = (v: number) => v.toLocaleString("en-US");
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const shortHash = (h: string) => `${h.slice(0, 10)}…`;

export function contractName(address: string, label: ContractLabel | null | undefined): string {
  if (!label?.name) return shortAddr(address);
  return label.symbol ? `${label.name} (${label.symbol})` : label.name;
}

export function explorerTx(chainId: number, hash: string): string | null {
  return chainId === 143 ? `https://monadvision.com/tx/${hash}` : null;
}

export function explorerAddr(chainId: number, address: string): string | null {
  return chainId === 143 ? `https://monadvision.com/address/${address}` : null;
}
