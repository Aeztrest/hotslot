import { isPrecompile } from "./keys.ts";
import { SLOTS_PER_PAGE_LOG2 } from "./pages.ts";

/**
 * Why a cost model instead of `gasUsed`: Monad charges the gas *limit*, and its receipts and traces report
 * `gasUsed = gasLimit` for every transaction (checked on mainnet). How much gas a transaction actually burned
 * is not exposed by any RPC method, so weighting the dependency graph by receipts would weight it by whatever
 * limit the sender's wallet picked.
 *
 * What we can price exactly is state access, from the prestate traces we already fetch: which accounts,
 * storage pages and slots a transaction touched and which it changed. On Monad, state access is the dominant
 * cost of execution (it is I/O), and its gas schedule is set to reflect that. The estimate leaves out compute,
 * memory, logs and refunds, and charges every access once, so it is a lower bound on the gas the
 * transaction used: model <= used <= limit. `hotslot scan` checks that inequality on every transaction.
 */

/** Monad gas schedule, MONAD_TEN revision (MIP-8). https://docs.monad.xyz/developer-essentials/opcode-pricing */
export const MONAD_GAS = {
  tx: 21_000,
  create: 32_000,
  initcodeWord: 2,
  calldataZeroByte: 4,
  calldataNonZeroByte: 16,
  accessListAddress: 2_400,
  accessListKey: 1_900,
  /** EIP-7702 PER_AUTH_BASE_COST: the part of an authorization that is never refunded. */
  authorization: 12_500,
  /** First access to an account (BALANCE, EXT*, CALL*, SELFDESTRUCT). Ethereum: 2600. */
  coldAccount: 10_100,
  /** First SLOAD or SSTORE on a 128-slot page. Ethereum prices this per slot (2100). */
  coldPage: 8_100,
  /** Any further slot on a page already accessed in the transaction. */
  warmSlot: 100,
  /** First SSTORE that changes a value on a page. */
  pageWrite: 2_800,
  /** Each time a page's count of non-zero slots reaches a new high. */
  stateGrowth: 17_000,
} as const;

/**
 * Cheapest possible call to each precompile under Monad's repricing. Input-dependent parts are taken at their
 * minimum, so a precompile in the touched set adds at least this much.
 */
const PRECOMPILE_MIN_GAS: Record<number, number> = {
  0x01: 6_000, // ecRecover (Ethereum 3000)
  0x02: 60, // sha256
  0x03: 600, // ripemd160
  0x04: 15, // identity
  0x05: 200, // modexp
  0x06: 300, // ecAdd (150)
  0x07: 30_000, // ecMul (6000)
  0x08: 225_000, // ecPairing base (45,000)
  0x0a: 200_000, // point evaluation (50,000)
};

export interface StorageChange {
  address: string;
  slot: string;
  before: bigint;
  after: bigint;
}

export interface CostInput {
  from: string;
  to: string | null;
  input: string;
  accessList?: { address: string; storageKeys: string[] }[];
  authorizationList?: unknown[];
  /** prestateTracer default mode: every account, and every slot of it, the transaction touched. */
  touched: Record<string, { code?: string; storage?: Record<string, string> }>;
  /** Storage slots whose value the transaction changed. */
  changes: StorageChange[];
  /** Accounts that are warm without being paid for: created in the transaction, or given 7702 code by it. */
  created: Set<string>;
  feeRecipient: string;
}

export interface CostBreakdown {
  intrinsic: number;
  accounts: number;
  storageRead: number;
  storageWrite: number;
  precompiles: number;
  total: number;
}

/** Estimated execution gas of one transaction under Monad's schedule. A lower bound; see the top of this file. */
export function estimateCost(c: CostInput): CostBreakdown {
  const G = MONAD_GAS;
  const from = c.from.toLowerCase();
  const to = c.to?.toLowerCase() ?? null;

  let intrinsic = G.tx + calldataGas(c.input);
  if (to === null) intrinsic += G.create + G.initcodeWord * Math.ceil(hexBytes(c.input) / 32);

  // Warm from the start (EIP-2929, EIP-3651): sender, recipient, fee recipient, precompiles, access list.
  const warmAccounts = new Set([from, c.feeRecipient.toLowerCase(), ...c.created]);
  if (to) warmAccounts.add(to);
  const warmPages = new Set<string>();
  for (const entry of c.accessList ?? []) {
    const address = entry.address.toLowerCase();
    intrinsic += G.accessListAddress + G.accessListKey * entry.storageKeys.length;
    warmAccounts.add(address);
    // MIP-8: an access-list key warms its whole page.
    for (const key of entry.storageKeys) warmPages.add(`${address}:${pageOf(key)}`);
  }
  intrinsic += G.authorization * (c.authorizationList?.length ?? 0);
  // EIP-7702: calling a delegated account also loads its delegate's code. Monad does not charge that load at
  // the cold-account price: a plain transfer to a delegated account succeeds with 3,408 gas above intrinsic
  // (mainnet tx 0x85414a90…). We cannot tell a delegate load from a direct call in the trace, so delegates
  // are left uncharged rather than risk over-counting.
  for (const state of Object.values(c.touched)) {
    const target = delegateOf(state.code);
    if (target) warmAccounts.add(target);
  }

  let accounts = 0;
  let storageRead = 0;
  let precompiles = 0;
  for (const [addr, state] of Object.entries(c.touched)) {
    const address = addr.toLowerCase();
    if (isPrecompile(address)) {
      // Calls into precompiles are warm. Monad's own precompiles (staking at 0x1000) keep their state outside
      // EVM storage and price calls by method, which the trace does not show, so they add nothing here.
      precompiles += PRECOMPILE_MIN_GAS[Number(BigInt(address))] ?? 0;
      continue;
    }
    if (!warmAccounts.has(address)) accounts += G.coldAccount;
    const slotsPerPage = new Map<string, number>();
    for (const slot of Object.keys(state.storage ?? {})) {
      const page = pageOf(slot);
      slotsPerPage.set(page, (slotsPerPage.get(page) ?? 0) + 1);
    }
    for (const [page, slots] of slotsPerPage) {
      const first = warmPages.has(`${address}:${page}`) ? G.warmSlot : G.coldPage;
      storageRead += first + G.warmSlot * (slots - 1);
    }
  }

  // SSTORE: a page write for each page with a changed slot, plus state growth for each net new non-zero slot.
  // Slot order inside the transaction is unknown, so growth is the smallest count consistent with the result.
  const netNewSlots = new Map<string, number>();
  for (const ch of c.changes) {
    if (isPrecompile(ch.address)) continue;
    const page = `${ch.address.toLowerCase()}:${pageOf(ch.slot)}`;
    const delta = ch.before === 0n && ch.after !== 0n ? 1 : ch.before !== 0n && ch.after === 0n ? -1 : 0;
    netNewSlots.set(page, (netNewSlots.get(page) ?? 0) + delta);
  }
  let storageWrite = 0;
  for (const net of netNewSlots.values()) storageWrite += G.pageWrite + G.stateGrowth * Math.max(0, net);

  return {
    intrinsic,
    accounts,
    storageRead,
    storageWrite,
    precompiles,
    total: intrinsic + accounts + storageRead + storageWrite + precompiles,
  };
}

/** EIP-7702 delegation indicator: code is exactly 0xef0100 followed by the 20-byte delegate address. */
function delegateOf(code: string | undefined): string | null {
  return code && code.length === 48 && code.toLowerCase().startsWith("0xef0100") ? "0x" + code.slice(8).toLowerCase() : null;
}

function pageOf(slot: string): string {
  return (BigInt(slot) >> SLOTS_PER_PAGE_LOG2).toString(16);
}

function hexBytes(hex: string): number {
  return (hex.length - (hex.startsWith("0x") ? 2 : 0)) >> 1;
}

/** EIP-2028 calldata cost: 4 gas per zero byte, 16 per non-zero byte. */
export function calldataGas(hex: string): number {
  let gas = 0;
  for (let i = hex.startsWith("0x") ? 2 : 0; i + 1 < hex.length; i += 2) {
    const zero = hex.charCodeAt(i) === 48 && hex.charCodeAt(i + 1) === 48; // "00"
    gas += zero ? MONAD_GAS.calldataZeroByte : MONAD_GAS.calldataNonZeroByte;
  }
  return gas;
}
