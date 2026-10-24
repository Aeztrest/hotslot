# hotslot

Finds the storage slots that stop Monad from running transactions in parallel, measures what they cost,
and tells you whether each conflict is avoidable.

```
$ pnpm hotslot scan --blocks 500

Monad mainnet: parallelism lost to shared state
blocks 116,171,670–116,172,169 · 499 blocks · 6,672 txs · chain 143

  conflicted txs        42% had to wait on an earlier tx in the same block
  parallelism possible  13.37×
  parallelism actual    3.20×
```

## The problem

Monad executes the transactions of a block in parallel. It runs each one optimistically against the state at
the start of the block and commits the results in block order. If transaction 7 read a storage slot that
transaction 3 wrote, transaction 7 ran on a stale value: its result is discarded and it is executed again after
transaction 3. Transaction 7 cannot finish before transaction 3.

Follow those waits through a block and you get a dependency graph. The longest chain in it is the minimum number
of sequential steps the block needs, no matter how many cores execute it. A contract where every call does
`totalCount += 1` turns a block of its transactions into a single chain: one transaction at a time.

Nobody notices, by design. Ethereum is sequential, so a global counter costs nothing there, and most contracts
on Monad were written for Ethereum. Monad keeps full EVM compatibility: no access lists to declare (Solana makes
you name every account a transaction touches), no error, no extra gas, no warning. The parallelism is lost
silently.

On 499 consecutive mainnet blocks (116,171,670–116,172,169):

| | |
|---|---|
| transactions that waited on another tx in the same block | 42% |
| parallelism available (avg. txs per block) | 13.37× |
| parallelism achieved (Σ txs ÷ Σ longest chain) | 3.20× |
| allowed by contract storage conflicts alone | 3.25× |
| allowed by same-account ordering alone (one sender, several txs) | 4.35× |

Storage conflicts are the larger limit, and they are the part contract design controls. Removing the storage conflicts of the 6 worst contracts would take storage-limited parallelism from 3.25× to 10.68× on the same blocks. That is an upper bound: it also removes conflicts the root-cause probe classifies as inherent.

## What hotslot does

1. **Read/write sets.** For every transaction in a block, `debug_traceBlockByNumber` with geth's
   `prestateTracer` gives every slot it touched (default mode) and every slot it changed (diff mode).
   An SSTORE counts as a read, because its gas cost depends on the current value.
2. **Dependency graph.** Each read is linked to the most recent earlier transaction that wrote that slot. The
   longest path is the block's sequential cost; transactions ÷ longest path is its parallelism.
3. **Attribution.** For every slot and every contract we recompute the graph without it. Contracts are often
   hot *together* (two transactions share slots in both a router and a vault), so the "what if we fixed these"
   numbers are computed greedily, adding the contract that helps most at each step.
4. **Root cause by replay.** For the hottest slots, sample transactions are replayed with `debug_traceCall`
   on the block they were included in, with everything that transaction and later ones wrote rewound through
   state overrides, so each replay sees exactly the state the transaction saw on chain. A replay is only used if
   it reproduces the transaction's on-chain storage writes exactly. Then only the hot slot's value is changed and
   the effects are diffed:

   | result | meaning | avoidable |
   |---|---|---|
   | `unused` | changing the value changes nothing | yes: drop the read |
   | `overwrite` | the old value is ignored (`lastCaller = msg.sender`) | yes: per-user storage or an event |
   | `accumulator` | the tx adds a fixed delta and nothing else depends on it (`total += x`) | yes: shard it or derive it from events |
   | `guard` | the value only decides whether the tx reverts (a cap, a threshold) | usually not |
   | `dependent` | other writes or transfers are computed from it (price from reserves) | no: only batching helps |

5. **Before you deploy.** `hotslot simulate` deploys a contract on a local anvil chain, has N users call it in
   the same block and runs the same pipeline, naming slots from the Solidity storage layout.

| 64 users, one block | per slot | per page (MIP-8) | hot slots found |
|---|---|---|---|
| `QuestNaive`: global `totalCheckIns`, `lastPlayer`, `lastCheckInAt` | 1.00× | 1.00× | `totalCheckIns` accumulator, `lastPlayer` and `lastCheckInAt` overwrite: all avoidable |
| `QuestSharded`: total kept in `uint256[64]` shards picked by address | 21.3× | 1.00× | shard collisions; per page, all 64 shards are on page 0 |
| `QuestShardedMap`: same shards in a `mapping` | 21.3× | 21.3× | shard collisions only |
| `QuestFixed`: per-player struct, totals derived from events | 64.0× | 64.0× | none |
| `MiniPool`: constant-product pool | 1.00× | 1.00× | `reserveMon`, `reserveToken`: dependent, inherent |

The pool is there on purpose: it is as serialized as the naive quest, and hotslot correctly reports that
nothing about its storage layout can fix that.

## Per slot or per page (MIP-8)

[MIP-8](https://mips.monad.xyz/MIPs/MIP-8) groups storage into pages of 128 consecutive slots
(`page = slot >> 7`). A page is the unit of disk I/O, of the state commitment and of SLOAD/SSTORE gas. MIP-8 does
not say whether parallel execution detects conflicts per slot or per page, so hotslot reports both.

If conflicts are per page, two transactions that write *different* slots on the same page still wait for each
other: false sharing, as with two CPU cores writing different variables on one cache line. On the mainnet range
above, parallelism is 3.20× per slot and 3.18× per page; 90 of 4227 (2%) page-level waits are false sharing. On today's mainnet the question barely moves the total: the hot contracts already collide on the *same* slots.

The simulations show why it matters for contract design. `QuestSharded` splits its counter into a `uint256[64]`:
64 consecutive slots, all on page 0. Per slot that gives 21×; per page every shard collides and it is 1×.
`QuestShardedMap` keeps the same shards in a mapping, whose entries are hashed onto different pages, and stays at
21× either way. The advice that holds under both models: shard with mappings, not arrays or adjacent variables.

MIP-8's gas model pulls the other way. Later slots on a page already touched in the transaction are warm and cheap,
so packing hot data onto one page saves gas while concentrating conflicts.

## Running it

Requirements: Node 22.18+ (runs TypeScript directly), pnpm, and [Foundry](https://getfoundry.sh) for `simulate`.

```sh
pnpm install

# analyze recent mainnet blocks (any RPC that serves debug_traceBlockByNumber and debug_traceCall works)
pnpm hotslot scan --blocks 500 --out data/mainnet.json

# simulate a contract before deploying it
pnpm hotslot simulate contracts/scenarios/quest-naive.json

# dashboard over everything in data/
pnpm dashboard

pnpm test        # unit tests for the graph and attribution logic
pnpm typecheck
```

A scenario is a small JSON file naming a contract in `contracts/src`, the number of users, and the call each
one makes (`"$user"` in args becomes the caller's address). See `contracts/scenarios/`.

## Layout

```
packages/core     analysis engine: tracing, dependency graph, attribution, replay probe, labels
packages/cli      hotslot scan / hotslot simulate
contracts         demo contracts (Foundry) and simulation scenarios
apps/dashboard    React dashboard over the JSON reports in data/
data              generated reports
```

## What it does not claim

- The parallelism figure is an upper bound set by data dependencies, assuming unlimited cores and equal-cost
  transactions. It is not a measurement of Monad's executor, whose real speedup also depends on core count,
  transaction cost and state I/O. Re-execution on Monad is cheap because reads are cached; the cost here is the
  chain of waits, not the re-execution itself.
- A plain `BALANCE` read is not visible to the tracer, so balance conflicts are only counted when both
  transactions change the balance. Account-level conflicts are under-counted rather than invented.
- Root cause is decided per sampled transaction (3 per slot by default); the most restrictive result wins.
  Two perturbations (+1 and +0x1234567) are tried; a guard far from its limit can look like `unused`.
- Which granularity Monad's executor uses for conflict detection is not specified by MIP-8; the per-slot figures
  are the main ones and the per-page figures show the other case.
- Monad system transactions (gas = 0) and the staking precompile are in the graph because they execute in the
  block, but they are not replayed: overriding a precompile's storage proves nothing.

## Where this goes next

- **CI check**: run the simulation in a pull request and fail it when a change drops the parallelism score,
  the way gas snapshots work today.
- **Live index**: scan continuously and keep per-contract history, so a protocol sees when a release made it a
  hotspot.
- **Names for mainnet slots**: pull storage layouts of verified contracts (Sourcify) to name slots like the
  simulator does.
- **Static lint**: flag writes to non-mapping storage in externally callable functions before anything runs.
