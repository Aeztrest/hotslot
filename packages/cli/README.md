# hotslot

Monad runs the transactions in a block in parallel. If two transactions touch the same storage slot or
the same MON balance, the later one has to wait for the earlier one. The EVM gives you no error and no
warning for this. Your contract works fine, but it runs one transaction at a time.

hotslot shows you which slots and balances cause this, why they are hot, and how to fix them. You can
run it on your own contract before you deploy, or on Monad mainnet.

## Before you deploy

You need [Foundry](https://getfoundry.sh). Run these from your Foundry project:

```sh
npx hotslot init MyContract            # writes hotslot/mycontract.json from the ABI
# set weights and arguments for the calls your users make, then:
npx hotslot simulate hotslot/mycontract.json
```

hotslot deploys the contract on a local anvil chain and has 64 different users call it in the same
block. It then reports:

- how parallel that block was;
- which slots made calls wait, by name (`totalTips`, `rewardsPayable[7]`);
- why each slot is hot (a shared counter, a last-writer slot, a real data dependency, or a shared MON balance);
- how to fix it.

To fail CI when parallelism drops below a threshold:

```sh
npx hotslot simulate hotslot/mycontract.json --min-parallelism 8
```

## On mainnet

```sh
npx hotslot scan --blocks 300                     # the hottest contracts and slots right now
npx hotslot scan --contract 0xYourContract        # how your users fare, and what a fix would gain
npx hotslot block 12345678                        # one block, step by step
```

`scan` and `block` need an RPC that serves `debug_traceBlockByNumber` with the prestate tracer.
The default is `https://rpc.monad.xyz`. You can pass a different one with `--rpc`.

More detail, the mainnet findings, and the dashboard: https://github.com/Aeztrest/hotslot

MIT license
