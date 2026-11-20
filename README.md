# hotslot

**English** · [Türkçe](README.tr.md)

Monad runs the transactions of a block in parallel, but only those that don't touch the same state. hotslot
finds the storage slots and MON balances that make transactions wait for each other. It tells you why each one
is hot and how to fix it, and you can check your own contract before it ships.

```sh
npx hotslot scan                      # what is serializing Monad mainnet right now
npx hotslot init MyContract           # in your Foundry project: write a test scenario from the ABI
npx hotslot simulate hotslot/mycontract.json --min-parallelism 8
```

## The problem

Monad executes every transaction in a block at the same time, each one against the state at the start of the
block, and commits the results in order. When transaction 7 reads a slot that transaction 3 wrote, transaction 7
saw a stale value. Its result is thrown away and it runs again after transaction 3. In practice it can't finish
before transaction 3 does.

Follow those waits through a block and you get a chain. A contract where every call does `totalCount += 1` turns
a block of its calls into one chain, so the calls run one at a time on a 16-core machine.

Nothing tells you this is happening. Contracts written for Ethereum never paid for a global counter, because
Ethereum is sequential anyway. Monad keeps full EVM compatibility. You don't declare access lists the way you
declare accounts on Solana, and there's no error, no extra gas and no warning. The contract works, it's just
sequential.

## What it looks like on mainnet today

499 consecutive Monad mainnet blocks (122,988,945–122,989,444, Nov 17 2026), 15,410 transactions:

| | |
|---|---|
| transactions that had to wait for an earlier one in the same block | **70%** |
| parallelism the blocks could have had (txs per block) | 30.9× |
| parallelism they actually have (txs ÷ longest chain) | **2.13×** |
| the same, weighted by gas | 1.61× of 11.1× possible |

93% of the available parallelism is lost. The biggest single cause is one flow.

**The tip path.** 41% of all transactions in the range (6,257 of 15,410) are the same kind, and every one of them waited. A trading bot transaction goes through `0xd32e…ff58`: it trades on an
orderbook, looks up the current block's validator in the staking precompile, and pays a 0.07 MON tip to that
validator through **ShMonad** (`0x1b68…e19c`, `sendValidatorRewards`). Every one of these transactions:

- writes the same shared accumulators in ShMonad (the rewards owed to that validator, and global totals);
- sends MON into ShMonad's balance, which every other tip in the block also changes.

Either one alone is enough to chain all the tips in a block. hotslot's view of ShMonad:

```
$ npx hotslot scan --blocks 500 --contract 0x1b68626dca36c7fe922fd2d55e4f631d962de19c

  ShMonad (0x1b68626dca36c7fe922fd2d55e4f631d962de19c)
    txs that used it      6043, of which 100% waited on an earlier tx
    if it were fixed      network 2.13x → 2.13x
    fixed together with 0xd32e…ff58: network 2.13x → 4.81x  the same txs wait on both
```

Fixing ShMonad alone gains nothing, because the same transactions also wait on `0xd32e`. Fixing both more than
**doubles the parallelism of the whole network, 2.13× → 4.81×** (gas-weighted 1.61× → 3.98×). Taking the 6
worst contracts that a developer can change, one by one:

| fixed | network parallelism |
|---|---|
| today | 2.13× |
| + `0x34b6…2a6f` (likely a perp DEX's order execution) | 2.23× |
| + `0xd32e…ff58` (tip path) | 2.27× |
| + ShMonad | **5.86×** |
| + 3 orderbook markets | 6.47× |

"Fixed" here means the contract's slots and MON balance stop conflicting while everything else stays: other
contracts, and the order of each sender's own transactions.

**The fix is an ordinary design change.** Let searchers prefund a balance once, debit it per tip, keep what each
validator is owed per bidder (or per block), and pay out in batches. [`TipVault`](contracts/src/TipVault.sol) is a
small model of the pattern. With 64 users in one block, hotslot measures it at **1.00×**. The same bids against
[`TipVaultEscrow`](contracts/src/TipVaultEscrow.sol), which debits a prefunded balance, run at **64.00×**.

## Check your contract before you deploy

You need Node 20+ and [Foundry](https://getfoundry.sh). Inside your Foundry project:

```sh
npx hotslot init TipVault
```

This writes `hotslot/tipvault.json`, one entry per state-changing function. Pick the calls your users make and
how often (`weight`), fill in the arguments (`"$user"` is the caller), and add any setup such as an approve or a
deposit:

```json
{
  "contract": "TipVault",
  "users": 64,
  "deployValue": "100",
  "actions": [
    { "signature": "bid(uint64)", "args": ["7"], "value": "0.07", "weight": 3 },
    { "signature": "deposit()", "value": "1", "weight": 1 }
  ]
}
```

```sh
npx hotslot simulate hotslot/tipvault.json
```

hotslot deploys the contract on a local anvil chain and has 64 different users send their calls in the same
block. It then reports which state made them wait, using your variable names:

```
TipVault: 64 users in one block
  txs that waited       98% had to wait on an earlier tx in the same block
  parallelism           1.00x of 64.00x possible  (98% lost)

  hottest state and why it is hot
      63 waits  TipVault   MON balance          Shared MON balance · fixable by design
      47 waits  TipVault   totalTips            Shared counter · avoidable
      47 waits  TipVault   bidCount             Shared counter · avoidable
      47 waits  TipVault   lastBidder           Last-writer slot · avoidable
      47 waits  TipVault   rewardsPayable[7]    Shared counter · avoidable
      15 waits  TipVault   totalShares          Data dependency · inherent

  how to fix
    Shared counter: Shard the counter (mapping by msg.sender or by shard id, summed in a view), or drop it
                    and aggregate from events off-chain.
    Last-writer slot: Emit an event instead, or store it per user (mapping keyed by msg.sender).
    Shared MON balance: Have users prefund once (deposit) and debit an internal per-user balance per action ...
```

Add `--min-parallelism 8` to CI and the run fails (exit code 1) when a change makes the contract sequential, the
same way gas snapshots catch gas regressions.

The demo contracts in [`contracts/`](contracts/) cover the common cases:

| 64 users, one block | parallelism | what hotslot reports |
|---|---|---|
| `QuestNaive`: global `totalCheckIns`, `lastPlayer` | 1.00× | shared counter and last-writer slots, all avoidable |
| `QuestSharded`: counter split over a `uint256[64]` | 21.3× | shard collisions (and 1.00× if conflicts are per page, see below) |
| `QuestShardedMap`: the same shards in a `mapping` | 21.3× | shard collisions only |
| `QuestFixed`: per-player state, totals from events | 64.0× | nothing |
| `MiniPool`: constant-product AMM | 1.00× | `reserveMon`, `reserveToken`: a real data dependency, inherent |
| `TipVault`: MON tips into one contract | 1.00× | shared MON balance, counters, last-writer slot |
| `TipVaultEscrow`: tips debited from a prefunded balance | 64.0× | nothing |

The pool is there on purpose. It's exactly as sequential as the naive quest, and hotslot correctly says no
storage layout can fix that. Only batching can.

## On mainnet

```sh
npx hotslot scan --blocks 300                          # hottest contracts and slots
npx hotslot scan --contract 0xYourContract             # how your users fare, and what a fix would gain
npx hotslot block 122989000                            # one block, its longest chain step by step
```

The default RPC is `https://rpc.monad.xyz`. Any RPC that serves `debug_traceBlockByNumber` (prestate tracer) and
`debug_traceCall` works with `--rpc`. `scan --min-parallelism` works as a gate too.

## How it works

1. **Read and write sets.** For each block, `debug_traceBlockByNumber` with the prestate tracer gives every slot
   and account each transaction touched (default mode) and changed (diff mode). An SSTORE counts as a read too,
   because its gas depends on the current value.
2. **Dependency graph.** Every read links to the latest earlier transaction in the block that wrote the same
   key. A key is a storage slot, an account's MON balance, or a sender's nonce. The longest path is the minimum
   number of sequential steps the block needs, however many cores run it. Transactions divided by that is the
   block's parallelism.
3. **Three kinds of waits.** Each edge is classified by what caused it:
   - *contract storage*: a shared slot. Contract design controls this.
   - *shared MON balance*: different senders paying into the same account. Also contract design.
   - *same-sender order*: one sender's transactions run in nonce order. Not a contract issue.

   A sender's own balance is only counted through its nonce, so a bot sending 20 transactions isn't blamed on
   any contract.
4. **What if it were fixed.** For each contract, the graph is recomputed with its slots and balance removed and
   everything else kept. Contracts are often hot *together* (the same transactions wait on both), so the list is
   built greedily, and `--contract` also searches for the partner whose joint fix gains the most.
5. **Why each slot is hot.** For the hottest slots, a few transactions are replayed with `debug_traceCall` on
   their own block, with everything they and later transactions wrote rewound through state overrides. A replay
   is only trusted if it reproduces the transaction's on-chain writes exactly. Then only the hot slot's value is
   changed, and the effects are compared:

   | result | meaning | avoidable |
   |---|---|---|
   | `unused` | changing the value changes nothing | yes: drop the read |
   | `overwrite` | the old value is ignored (`lastCaller = msg.sender`) | yes: per-user storage or an event |
   | `accumulator` | the tx adds a fixed amount and nothing else depends on it (`total += x`) | yes: shard it, or derive it from events |
   | `guard` | the value only decides whether the tx reverts (a cap) | usually not |
   | `dependent` | other writes are computed from it (a price from reserves) | no: only batching helps |

6. **Names.** In simulations, slots are named from the Solidity storage layout, including mappings one or two
   levels deep (`rewardsPayable[7]`, `owed[7][0x…]`). On mainnet, contracts are named from their token metadata
   where they have one.

## Weighted by gas

Counting transactions treats a transfer and a heavy swap as the same step. A block can't finish before its
heaviest chain, so hotslot also weights every transaction by its gas.

Monad charges the gas *limit*, and every RPC (receipts, `callTracer`, `debug_traceCall`) reports `gasUsed` equal to
the limit. The gas a transaction actually burned isn't available, and weighting by receipts would weight by
whatever limit the sender's wallet picked. hotslot estimates it from the traces it already has, using Monad's
MIP-8 schedule ([opcode pricing](https://docs.monad.xyz/developer-essentials/opcode-pricing)):

| what the transaction touched | gas |
|---|---|
| intrinsic, calldata, contract creation, access list, 7702 authorizations | as on Ethereum |
| each cold account (not the sender, recipient, fee recipient, a precompile, or created) | 10,100 |
| first slot of each 128-slot storage page | 8,100 |
| every other slot on a page already accessed | 100 |
| each page with a changed slot | 2,800 |
| each new non-zero slot | 17,000 |
| an Ethereum precompile call (at its cheapest input) | e.g. ecRecover 6,000 |

It leaves out compute, memory and logs, so it is a **lower bound** on gas used, and gas used can never exceed the
limit. Every scan checks `estimate ≤ limit` on every transaction. In the range above it holds for all 14,911
non-system transactions.

| same 499 blocks | counting txs | weighted by gas |
|---|---|---|
| available | 30.9× | 11.1× |
| achieved | 2.13× | 1.61× |
| contract storage alone would allow | 2.14× | 1.61× |
| shared MON balances alone would allow | 2.56× | 1.74× |
| same-sender order alone would allow | 7.87× | 6.80× |
| after fixing ShMonad and `0xd32e` | 4.81× | 3.98× |

## Per slot or per page (MIP-8)

[MIP-8](https://mips.monad.xyz/MIPs/MIP-8) groups storage into pages of 128 consecutive slots. A page is the unit
of disk I/O, of the state commitment and of SLOAD/SSTORE gas. MIP-8 doesn't say whether conflicts are detected per
slot or per page, so hotslot reports both.

If conflicts are per page, two transactions writing *different* slots on the same page still wait for each other.
This is false sharing, like two CPU cores writing different variables on one cache line. On today's mainnet it
barely matters: 182 of 21,592 page-level waits (0.8%) are false sharing, and parallelism is 2.13× either way,
because the hot contracts already collide on the same slots.

It matters for contract design. `QuestSharded` splits its counter over a `uint256[64]`, which is 64 consecutive
slots on one page: 21× per slot, 1× per page. `QuestShardedMap` keeps the same shards in a mapping, whose entries
hash onto different pages, and stays at 21× either way. **Shard with mappings, not arrays or adjacent variables.**

## What it does not claim

- Parallelism here is the limit set by data dependencies, assuming unlimited cores. It isn't a measurement of
  Monad's executor, whose real speedup also depends on core count, execution cost and I/O. Re-execution on Monad is
  cheap because reads are cached; the cost counted here is the chain of waits.
- **Shared MON balances.** Monad's execution code has a relaxed merge for balances (`state3/state.cpp`): a
  transaction can be validated against the minimum balance it needed instead of the exact value. We couldn't
  confirm whether mainnet uses it. If it does, MON paid into a busy account conflicts less than hotslot counts.
  Storage conflicts are not affected. Reports keep balance waits separate, so you can see how much of a figure
  depends on this. It's an open question for the Monad team.
- A plain `BALANCE` read isn't visible to the tracer, so balance conflicts are only counted when both transactions
  change the balance.
- Root cause is decided from a few sampled transactions per slot (3 by default); the most restrictive result wins.
  A guard far from its limit can look like `unused`.
- System transactions and the staking precompile are in the graph because they run in the block, but they're not
  replayed, and nobody can "fix" a precompile, so they're left out of the what-if lists.

## Development

```sh
pnpm install
pnpm hotslot scan --blocks 500 --out data/mainnet.json       # runs the CLI from source (Node 22.18+)
pnpm hotslot simulate contracts/scenarios/tipvault.json --out data/sim-tipvault.json
pnpm dashboard                                                # React dashboard over data/
pnpm test && pnpm typecheck
```

```
packages/core     analysis: tracing, dependency graph, attribution, replay probe, gas model, labels
packages/cli      the hotslot command (published to npm as `hotslot`)
contracts         demo contracts (Foundry) and their scenarios
apps/dashboard    dashboard over the JSON reports in data/ (static, deploys to Vercel as is)
data              reports used in this README and the dashboard
```

## Next

- **Live index**: scan continuously and keep per-contract history, so a protocol sees which release made it a
  hotspot.
- **Slot names on mainnet** from verified sources (Sourcify), the way the simulator names them.
- **Static lint**: flag writes to non-mapping storage in externally callable functions before anything runs.

MIT license
