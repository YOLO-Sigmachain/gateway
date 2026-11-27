# Fork notes: Hummingbot Gateway with an Ergo chain

This branch (`feat/ergo`) is Hummingbot Gateway v2.18.0 (upstream commit `72d3938b`) plus the commits on this branch. They add the Ergo chain and one connector, `ergodex`. They change a small number of shared upstream files, listed in section 6.

This file is for two readers: someone who wants to run this fork for Ergo, and someone who has to merge a new upstream release into it. It states what was checked and what was not. Where a statement comes from reading code rather than from running it, it says so.

## 1. What this fork adds

Ergo is a UTXO chain. A pool on Ergo is a single box (an unspent output) that holds the pool's tokens. A swap here is one transaction that spends the pool box and creates a new pool box in its place. The Gateway builds that transaction, signs it with the wallet's key, and posts it to an Ergo node. There is no order box, no relayer and no third party in the path.

- Chain `ergo` (`src/chains/ergo/`): talks to one Ergo node (no explorer), keeps a list of submitted transactions, builds and signs transactions.
- Connector `ergodex` (`src/connectors/ergodex/`): one AMM connector, trading type `amm`, with two venues.

| Part | Venue | What it does on Ergo |
|---|---|---|
| Chain `ergo`, route `status` | node | Current block height and network settings. |
| Chain `ergo`, route `balances` | node | ERG and token balances for an address, read from the node's index. |
| Chain `ergo`, route `poll` | node | Reports one transaction as PENDING, CONFIRMED, FAILED or NOT_FOUND (section 4). |
| Chain `ergo`, route `estimate-gas` | node | Reports the miner fee from config as one "compute unit". Ergo has no gas price. |
| Chain `ergo`, routes `wrap`, `unwrap` | none | Answer 501. The native coin is not a token. |
| `ergodex`, `pool-info` | Spectrum-style and LithosDex | Reads the pool box from the node and reports reserves, price and fee. |
| `ergodex`, `quote-swap` | Spectrum-style and LithosDex | Prices a swap from the pool box. With no pool named, it picks the allowed pool with the best result for the size. |
| `ergodex`, `execute-swap` | Spectrum-style and LithosDex | Spends the pool box directly in the caller's own transaction and answers PENDING. |
| `ergodex`, `quote-liquidity` | Spectrum-style | The deposit an offer makes at the pool's current ratio, in exact units (section 4.1). |
| `ergodex`, `add`, `remove` | Spectrum-style | A deposit or redeem by direct spend of the pool box, answered PENDING (section 4.1). |
| `ergodex`, `position-info`, `positions-owned` | Spectrum-style | The wallet's confirmed LP balance of a pool and what a redeem of it would pay. |
| `ergodex`, liquidity and positions on a LithosDex pool; pool creation | none | Answer 501. |

Venues:

- Spectrum-style pools: ERG/token and token/token pools whose contract matches one of the exact ErgoTrees (compiled contract scripts) in the config.
- LithosDex pools: ERG/token and token/token pools, found on chain by contract template and admitted by the same rules as Spectrum-style pools (section 3.4).

Not built: LithosDex order mode, deposit and redeem; pool creation; Dexy; any network file for the yolo chain. See section 8.

## 2. What is proven and what is not

State of the code at `0b0f0301`.

### Proven

| Level | What it shows | Where |
|---|---|---|
| Unit and route tests against stand-in nodes | The chain layer, the transaction builder, the pending list, the swap routes and both venues behave as written when the node is a test double. | `test/chains/ergo/`, `test/connectors/ergodex/` |
| Contract proof on mainnet pool boxes kept as fixtures, Spectrum-style | The pool script, evaluated by the real signing library (`ergo-lib-wasm-nodejs` 0.28.0), is true for the swap this code builds and false for the same swap asking one unit more. Both directions, exact input and exact output. Fixtures: ERG/rsBTC, ERG/RSN, ERG/SigUSD, wtERG/wtADA. | `test/connectors/ergodex/ergodex-contract-proof.test.ts` |
| Contract proof of deposit and redeem on the same Spectrum-style fixtures | The pool script, evaluated by the same library, is true for the deposit and the redeem this code builds; false for one LP unit more out or one unit less of either side in (deposit, with each side as the limiting one), and false for one unit more of either side out or one LP unit less in (redeem). | `test/connectors/ergodex/ergodex-liquidity-proof.test.ts` |
| Contract proof on mainnet pool boxes kept as fixtures, LithosDex | The same two results (true for ours, false one unit over; also false for a successor register one unit off), on the signing library alpha build named below. Fixtures: an ERG/LIT pool and a LIT/RSN pool. | `test/connectors/ergodex/lithos-contract-proof.test.ts` |
| Read-only run of the server against a mainnet node | Gateway started as a server, read pool boxes from a mainnet node, answered status, tokens, balances, pool-info and quotes for ERG/RSN, ERG/SigUSD, and a poll of an unknown id. Nothing was signed or sent. | Run on 25 November 2026, on an earlier commit than `5d9480f7` (see below). |

Test counts, as of commit `0b0f0301` and taken from its message: 213 suites pass and 1 is skipped; 2,392 tests pass and 4 are skipped. Section 7 has the commands to run them. Tests that need a live node are skipped unless `ERGO_LIVE_NODE=1` is set (`test/connectors/ergodex/ergodex-live.test.ts`).

The read-only server run happened before the commits that add `pendingData`, the `failedAfterConfirmations` depth, the LithosDex venue and `submitMode`. It has not been repeated since. Its output shows a token list without ERG and a network config without `failedAfterConfirmations`, which the current templates have.

### Not proven

- No transaction has been signed with a real wallet key or submitted to a node. The contract proofs use test keys and fixtures. The live test signs with a synthetic test key and fails if anything is posted.
- What a live node answers at submit, and when a transaction is posted again, was read from node source code. It was not observed. The HTTP codes in section 4 rest on that reading.
- LithosDex pool boxes are at ErgoTree version 3, which `ergo-lib-wasm-nodejs` 0.28.0 cannot read. A transaction with a version-3 input is therefore signed with `ergo-lib-wasm-nodejs@0.29.0-alpha-2f840d3`. That is an unreleased build of the library, installed under the alias `ergo-lib-wasm-nodejs-alpha` and loaded only when such a transaction is signed (its wasm file is about 17 MB). Everything else signs with 0.28.0. Whether a node accepts a LithosDex swap built and signed this way has not been tested.
- LithosDex pools are admitted without anyone checking how they were created (section 3.4), as Spectrum-style pools always were. Discovery by template hash was checked once against the local mainnet node on 26 November 2026 (11 pool boxes, the 11 known pools); the routes have not been run against it.
- LithosDex discovery is switched by `networks.<network>.lithos.discoverPools`, shipped `true` on mainnet. Upgrade note: a config written before this key existed has `lithos.poolAllowlist: []`, which used to offer no LithosDex pool. When it loads, the loader fills the missing key in from the template as `true`, so that config now discovers LithosDex pools and offers every one that passes the rules. Set `discoverPools: false` to keep LithosDex off (section 3.4).
- The check-only mode (section 3.5) exists so that a real node can judge a real signed swap without anything being broadcast. It has been tested against stand-in nodes only. What the node's check endpoint does was read from the node's API description and source, not observed.

## 3. Running it for Ergo

### 3.1 What the node must provide

Every read and every submit goes to one Ergo node, set by `nodeURL`. No explorer is used. The node client (`src/chains/ergo/ergo.node-client.ts`) calls these endpoints:

| Endpoint | Used for |
|---|---|
| `GET /info` | Block height and `parameters.minValuePerByte` (the node must be synced). |
| `GET /blockchain/indexedHeight` | Confirms the extra indexer is on and how far it has indexed. The client refuses a node without it. |
| `GET /blocks/lastHeaders/{n}` | Block headers for the signing context. |
| `GET /blockchain/box/unspent/byAddress`, `byTokenId`, `byErgoTree` | Wallet boxes and pool discovery. |
| `GET /blockchain/box/unspent/byTemplateHash/{hash}` | LithosDex pool discovery (called by the connector through the node client's `request`). |
| `GET /blockchain/box/byId/{id}` | One box, including whether it is spent. |
| `GET /blockchain/transaction/byId/{id}` | A confirmed transaction. |
| `GET /blockchain/token/byId/{id}` | Token name, decimals and issued amount. |
| `GET /transactions/unconfirmed/byTransactionId/{id}` | A transaction in the mempool. |
| `GET /transactions/unconfirmed/outputs/byTokenId/{id}` | Unconfirmed pool boxes. |
| `GET /transactions/unconfirmed/inputs/byBoxId/{id}` | Whether the mempool spends a box. |
| `POST /transactions` | Submit a signed transaction. |

The node therefore needs the extra indexer enabled (the part that serves the `/blockchain` routes), and its index must be caught up for poll to answer reliably. The client sends no API key.

### 3.2 Config files

The templates are in `src/templates/`. Copy them to `conf/` as upstream does for other chains (`root.yml` registers the namespaces `ergo`, `ergo-mainnet`, `ergo-testnet` and `ergodex`). Then edit the copies in `conf/`.

| File in `conf/` | Schema in `src/templates/namespace/` | Purpose |
|---|---|---|
| `chains/ergo.yml` | `ergo-chain-schema.json` | Default network and default wallet for the chain. |
| `chains/ergo/mainnet.yml`, `chains/ergo/testnet.yml` | `ergo-network-schema.json` | One file per network. |
| `connectors/ergodex.yml` | `ergodex-schema.json` | Swap settings and the pool contracts and guards, per network. |
| `tokens/ergo/mainnet.json`, `tokens/ergo/testnet.json` | | Token list. ERG is listed under the all-zero id. |
| `pools/ergo/mainnet.json` | | Pool list. Used only for `/pools` lookups, never by the swap routes. |

Gateway's own wallet routes accept `chain: ergo`. Set `defaultWallet` in `chains/ergo.yml`; it ships as the placeholder `<ergo-wallet-address>`.

#### Chain file `chains/ergo.yml`

| Key | What it does | Shipped value |
|---|---|---|
| `defaultNetwork` | Network used when a request names none. | `mainnet` |
| `defaultNetworks` | Networks queried for balances. | `[mainnet]` |
| `defaultWallet` | Wallet used when a request names none. | `'<ergo-wallet-address>'` |

#### Network file `chains/ergo/mainnet.yml`

The testnet file differs only in `nodeURL` (`http://127.0.0.1:9052`), `addressPrefix` (16), `tokenListSource` and `pendingStateFile`. The schema marks the first ten keys below as required; the rest have defaults in code where stated.

| Key | What it does | Shipped value (mainnet) |
|---|---|---|
| `nodeURL` | The Ergo node. | `http://127.0.0.1:9053` |
| `addressPrefix` | Network prefix for addresses (0 mainnet, 16 testnet). Taken from this file only. Must be a multiple of 16 up to 240. | `0` |
| `nativeCurrencySymbol` | Symbol of the native coin. | `ERG` |
| `nativeDecimals` | Decimals of the native coin. | `9` |
| `minerFee` | Miner fee per transaction, in nanoERG. Must be positive. | `1100000` |
| `maxMinerFee` | Highest fee a transaction may pay. A request for more, or for less than `minerFee`, is refused before signing. Default: 10 times `minerFee`. | `11000000` |
| `minerFeeErgoTree` | ErgoTree (hex) of the miner fee output. | the standard miner fee tree |
| `tokenListSource` | Token list file, relative to `conf/`. | `tokens/ergo/mainnet.json` |
| `blockTimeSeconds` | Average block interval. Used for the pending-age check and published to clients. | `120` |
| `pendingTxTimeoutBlocks` | A pending transaction older than this many blocks is checked against the node when boxes are next selected, at most once per block. | `15` |
| `pendingStateFile` | File that keeps pending transactions across restarts (section 3.3). Unset: kept in memory only, with a warning at start. | `db/ergo/mainnet-pending.json` |
| `transactionsExpire` | Stated for clients: an Ergo transaction has no expiry, so "not found" never proves it can no longer confirm. Gateway itself does not read it. | `false` |
| `confirmations` | Blocks (counting the one with the transaction) before poll says CONFIRMED. | `1` |
| `failedAfterConfirmations` | How deep a different transaction that spent one of our inputs must be before ours is reported FAILED. Unset: the value of `confirmations`. | `3` |
| `nodeTimeoutMs` | Node request timeout. Default 10000. | `10000` |
| `boxPageSize` | Page size for box queries, 1 to 500. Default 100. | `100` |
| `submitMode` | What happens to a signed transaction: `send`, `check`, or not set. **Not set, nothing is signed or sent** (section 3.5). | not set (a commented example line) |
| `checkAllowsRemoteNode` | Lets `check` mode run against a node that is not on this machine. In `check` mode the node receives the signed transaction in full. | not set |
| `swapProvider` | Connector used on the unified trading routes when a request names none (`connector/type`). | `ergodex/amm` |

With `failedAfterConfirmations: 3` and 120-second blocks, a lost race is reported about six minutes after the winning transaction lands.

#### 3.3 Pending transactions and the `db` folder

Gateway records every transaction it submits, so that its wallet boxes and the pool box are not selected again while the transaction waits, and so that a dropped transaction can be posted again.

- `pendingStateFile` is relative to the Gateway folder. The file holds signed transactions and box ids. It never holds a key.
- One file per network. Gateway refuses to start on a file that belongs to another network.
- One Gateway process per file. Every write replaces the whole file with that process's list, so two processes sharing a file lose each other's entries. There is no lock on the file.
- Writes go to a temporary file that is then renamed over the old one. A file that cannot be parsed is moved aside and the list starts empty. A file that exists but cannot be opened stops start-up.
- The folder `db` is in `.gitignore`. `docker-compose.yml` in this fork mounts `./db` at `/home/gateway/db`, so the file survives a container being replaced. Without that mount the file is lost with the container.

#### 3.4 Connector file `connectors/ergodex.yml`

Top level:

| Key | What it does | Shipped value |
|---|---|---|
| `slippagePct` | Default slippage between quote and execute, in percent. Between 0 and 100. | `1` |
| `maxRebuilds` | When the node rejects a swap because the pool box was already spent: how many times to re-read, re-quote and rebuild. Integer 0 to 10. | `2` |
| `rebuildWaitMs` | When the pool box is spent by one of Gateway's own pending swaps: wait this many milliseconds times the rebuild number before rebuilding. 0 to 10000. | `500` |

Per network, under `networks.<network>`. The pool guards are here. They fail closed: a network with pool trees must set `maxPoolFeePct` and `minPoolNativeReserve`, or Gateway refuses the config.

| Key | What it does | Shipped value (mainnet) |
|---|---|---|
| `useMempoolSuccessor` | Build on the newest unconfirmed successor of a pool box from the node's mempool (true), or only on the confirmed box (false). | `true` |
| `maxPoolFeePct` | Pools charging a higher fee (percent) are refused when named and skipped when chosen. | `3` |
| `minPoolNativeReserve` | Pools with less native coin than this (nanoERG) are refused or skipped. | `100000000000` (100 ERG) |
| `minPoolTokenReserve` | Pools with any token reserve below this (raw units, the same number for every token whatever its decimals) are refused or skipped. This is the only size guard on a token/token pool. | `1` |
| `poolAllowlist` | If not empty, only these pool NFT ids may be traded, of any venue. | `[]` |
| `maxDiscoveredBoxes` | Most boxes read per pool tree, or per LithosDex template, when discovering pools. One with more is read in part, with a warning. | `5000` |
| `spectrum.n2tPoolTrees`, `spectrum.t2tPoolTrees` | Exact ErgoTrees (hex) of ERG/token and token/token pools. A box is a Spectrum-style pool only at one of these trees. | one tree each |
| `spectrum.feeDenominator` | The pool contracts' fee denominator. | `1000` |
| `spectrum.n2tMinSuccessorValue` | An ERG/token pool's successor must hold more than this many nanoERG. | `10000000` |
| `spectrum.lockedLiquidity` | The pool contracts' LP constant: a pool's LP supply is this minus the LP tokens it holds. Must be a constant of every configured pool tree; another value is refused when the config loads (a wrong value would underpay deposits). Unset: the liquidity and position routes answer 501; swaps are unaffected. | `'9223372036854775807'` |
| `lithos.discoverPools` | `true`: LithosDex pools are discovered by template hash, and with `lithos.poolAllowlist` empty every one that passes the rules is used. `false`: none is discovered; only the pools on `lithos.poolAllowlist` are used, and none when it is empty. Absent from an older file: the loader fills it in from the template as `true`. See below. | `true` |
| `lithos.poolAllowlist` | Optional. Not empty: only these LithosDex pool NFT ids are used, and no LithosDex pool is discovered. Empty or absent: with `discoverPools`, every LithosDex pool that passes the rules; without it, none. See below. | `[]` |
| `lithos.feeDenominator`, `lithos.accumulatorScale`, `lithos.lockedLiquidity`, `lithos.n2tMinSuccessorValue`, `lithos.swapOperation` | Constants of the LithosDex contracts. | `10000`, `10^27`, `9223372036854775807`, `10000000`, `0` |
| `lithos.sentinels`, `lithos.provisionGuardTree`, `lithos.n2t.*`, `lithos.t2t.*` | The pinned LithosDex contract templates (pool, fee vault, provision logic) with placeholder ids that are replaced by each pool's own ids. Do not edit these without a reason. | pinned templates |
| `lithos.n2t.poolTemplateHash`, `lithos.t2t.poolTemplateHash` | The node's template hash of each pool tree (blake2b256 of the tree with its constants taken out). LithosDex pools are discovered under it. Must be the hash of the `poolTree` beside it, or the config is refused with the right value in the message. | `76fb6082...c139`, `4b8ced39...055a` |

The testnet block has no pool trees, so a testnet pool is never found. Its `minPoolNativeReserve` is 0.

Two more checks run on every pool, whatever the config: a pool is used only if its NFT was issued with a supply of exactly 1 (read from the node), and a swap whose fee would exceed `maxPoolFeePct` is refused.

#### LithosDex pools: discovery and admission

With `networks.<network>.lithos.discoverPools: true` (the shipped mainnet value), LithosDex pools are found and admitted by the same rules as Spectrum-style pools. Each pool's contract tree holds its own ids (vault NFT, provision guard hash) as constants, so there is no single tree to look up. The connector asks the node for the unspent boxes under each kind's template hash instead (`GET /blockchain/box/unspent/byTemplateHash/{hash}`, newest first, paged at `boxPageSize`, at most `maxDiscoveredBoxes`). A box found there is a candidate only if its tree is the pinned template with 32 bytes at each id slot and nothing else changed, and its tokens and registers read as a pool. The first discovery on a network logs "LithosDex pools are being discovered by template (discoverPools: true)" at info. A 404 from that route means the node does not serve it: discovery logs a warning and counts the read as partial.

With `discoverPools: false`, no LithosDex pool is discovered: only the pools on `lithos.poolAllowlist` are offered, and with that list empty no LithosDex pool is offered at all, and Spectrum-style pools work as if the LithosDex block were not there.

Upgrade note: a config written before `discoverPools` existed has `lithos.poolAllowlist: []`, which used to offer no LithosDex pool. When it loads, the loader merges the template in and fills `discoverPools` in as `true`, so that config now discovers LithosDex pools and offers every one that passes the rules. Set `discoverPools: false` to keep LithosDex off.

Before a LithosDex pool is used for pool info, quote, swap or pool choice, it must pass:

- the deployment check: the pool's contract tree rebuilt from its own ids matches byte for byte, and exactly one vault box sits at the rebuilt vault tree;
- the pool NFT issued with a supply of exactly 1;
- for a quote, swap or pool choice, the guards that apply to every pool: `maxPoolFeePct` (on the costlier direction, and on the trade's own fee), `minPoolNativeReserve` (ERG/token pools), `minPoolTokenReserve`, and `poolAllowlist` when not empty.

With the shipped mainnet guards, a LithosDex pool above 3% fee is refused and an ERG/token pool under 100 ERG is skipped.

`networks.<network>.lithos.poolAllowlist` is an optional restriction with the same meaning as the top-level `poolAllowlist`: empty means every pool that passes (with `discoverPools: true`; none with `false`); not empty means only those pools, which must still pass, and LithosDex pools are then not discovered. If `networks.<network>.poolAllowlist` is also non-empty, a LithosDex pool must be on both lists.

Neither the check nor the guards prove how a pool was created; the same is true of a Spectrum-style pool. To restrict trading to pools you have checked, list them and check from the chain first:

- the pool NFT and the vault NFT were each minted as one unit;
- the whole supply of the provision token was minted into the pool;
- the fee accumulators and pending fees were zero at genesis;
- the fees are in range;
- the pool's size is enough for what you want to trade.

#### 3.5 Sending is off until you turn it on: `submitMode`

A fresh config sends nothing on Ergo. The network file (`conf/chains/ergo/<network>.yml`) must say what to do with a signed transaction, in one top-level key:

| `submitMode` | What happens |
|---|---|
| not set (no line) | Every swap and transfer is refused with a 503 that names the line to add. The wallet key is not loaded. Quotes, pool info, balances, status and poll work. |
| `check` | The swap or transfer is built, bounded and signed as usual, then posted to the node's `POST /transactions/check`, which validates it against the node's boxes, scripts included, and does not take or relay it. Nothing is recorded or kept. The answer is never PENDING: a 409 "Check only: the node accepted transaction ... as valid; nothing was sent" with what it would move, a 400 with the node's reason if the node refuses it, or a 503 if the check gave no verdict. |
| `send` | The transaction is submitted to the node, which relays it. |

Use `check` for a dry run with a real wallet before you send anything.

Rules that keep the mode from being something other than what you wrote:

- **Change it only with Gateway stopped.** Edit the file, start Gateway, make one read request on the network (status or balances), and read the log line `ergo-<network>.submitMode is ...` before you execute anything. It is written when the network is first used, in every state.
- At every submit, the mode Gateway started with, the config in memory and the file on disk must agree. If they do not, nothing is sent, the answer is a 503, and the network refuses to send or check until Gateway is restarted.
- A value other than exactly `send` or `check` stops the config from loading. A key that looks like `submitMode` but is not it (another case, a typo, a prefix such as `ergo-mainnet.submitMode`, a nested copy, a near-synonym such as `dryRun` or `mode`), in the network file or in `conf/chains/ergo.yml`, stops the network.
- If an Ergo config file was edited by hand while Gateway runs, an update of that namespace through the config API is refused with a 409 until Gateway is restarted. Without this the API update would rewrite the file from memory and erase the edit.
- `check` mode starts only when `nodeURL` is on this machine (`localhost`, `127.0.0.0/8` or `::1`), unless `checkAllowsRemoteNode: true`, and never when Node is set to route `fetch` through a proxy from the environment. The node in a check receives the whole signed transaction; whoever runs or can watch it could broadcast it.
- In `check` mode a transaction tracked from an earlier `send` run is kept and not posted again.

A check validates against the node's current boxes and mempool. It does not prove that a later send is accepted (the pool box may have moved by then), and if the pool box was spent first, a check answers 400 where a send would rebuild; run the check again.

## 4. How a swap behaves here

Route: `POST /trading/amm/execute-swap`, with `chainNetwork` `ergo-mainnet`. A request that names no connector on chain `ergo` uses the network's `swapProvider`. A request with no `poolAddress` lets `ergodex` choose; a pool NFT id pins one pool.

**A pinned pool must hold the pair asked for.** With `poolAddress`, quote and execute resolve `baseToken` and `quoteToken` (symbol or token id; the native coin by its symbol or the all-zero id) and refuse with a 400 `Pool <id> holds <A>/<B>, not <base>/<quote>` unless the pool holds exactly those two tokens, in either order. Execute checks this before the wallet's key is loaded. `quoteToken` has the schema default `USDC`, so a request that pins a pool must send it.

**One transaction, no price limit on chain.** The swap spends the pool box as input 0 and creates its successor as output 0. What the trader receives goes to change at the wallet's own address. The amounts are fixed in the transaction, so the chain enforces no price band. The limits are enforced by Gateway before signing:

- `minAmountOut` (SELL, exact input) or `maxAmountIn` (BUY, exact output), if you send one. Sending `minAmountOut` on a BUY, or `maxAmountIn` on a SELL, is a 400.
- the slippage (`slippagePct`, or the config default) applied to Gateway's own first fresh quote;
- if that quote was built on an unconfirmed pool box that none of Gateway's own transactions created, the slippage is also applied to the confirmed pool box.

The strictest of these binds. Every build, the first and each rebuild, must meet it. Before signing, the built transaction is checked against the plan: the pool is input 0, the successor matches the plan byte for byte, the pool contract's rule holds in exact integer arithmetic, and the wallet's balance changes by exactly the swap and the miner fee.

**The answer is PENDING.** A swap that was posted answers `status: 0` (PENDING) with the transaction id in `signature` and a `pendingData` block. `pendingData` has the same fields as `data` and holds the amounts the transaction fixes, that is, what it moves if it confirms. The answer carries no `data`, because `data` means confirmed.

**Confirmation comes only from poll.** `POST /chains/ergo/poll` with the network and the signature answers:

| Answer | When |
|---|---|
| CONFIRMED (1) | The transaction is in a block with at least `confirmations` blocks on top, counting its own. |
| PENDING (0) | It is in the node's mempool; or it is in a block but not deep enough; or the node's index is behind the chain so the answer is not yet known; or one of its inputs was spent by another transaction that is not yet `failedAfterConfirmations` deep; or it waits for an earlier pending transaction of Gateway's that creates its inputs; or it was just posted again. A `note` in `txData` says which. |
| FAILED (-1) | Only on proof: one of its inputs was spent by a different transaction that is at least `failedAfterConfirmations` deep, or it spends an output of a transaction that failed that way, or its id is remembered as failed. A node refusing to take it again proves nothing and never gives FAILED. |
| NOT_FOUND (-2) | The node has it nowhere, and Gateway cannot show that an input was spent. This is not proof that it can no longer confirm: an Ergo transaction has no expiry. |

**A dropped transaction is posted again.** If a transaction Gateway submitted is in no mempool, none of its inputs is spent, and the node's index has caught up, Gateway posts the same signed transaction again: when it is polled, and on its own once the transaction is older than `pendingTxTimeoutBlocks` blocks and wallet boxes are next selected. Gateway keeps tracking it until it confirms, fails on proof, or one of its inputs is shown spent. If the node refuses the re-post (a 4xx), the entry is kept and marked refused; poll answers PENDING if the mempool holds it or spends one of its inputs, and NOT_FOUND otherwise, with the node's words in the note.

**HTTP codes at submit** (this is how the code maps them; the node's side of it was read from node source, not observed):

| Code | Meaning |
|---|---|
| 400 | The node refused the transaction with a 4xx. It was not taken. Also: a request the builder cannot satisfy (for example not enough funds), a `minAmountOut` or `maxAmountIn` on the wrong side, an ambiguous token symbol. |
| 409 | The pool moved. Either the swap would now fall outside the bound, or the pool box was spent first and still was after `maxRebuilds` re-reads. Nothing that can still execute was submitted. Retry with a fresh quote. |
| 503 | Not submitted: the connection to the node was refused or its name did not resolve, so no byte was sent. Also any other node error with status 0. |
| 504 (`TRANSACTION_TIMEOUT`) | The outcome is unknown: the connection broke after it may have been made, the node answered 5xx, or it answered 200 with no id. The message carries the transaction id. Poll it; do not send the swap again. Gateway does not rebuild or re-post in this case. |
| 409 ("Check only") | `submitMode` is `check` and the node found the transaction valid. Nothing was sent. |
| 503 (`submitMode` not set, or in doubt) | Nothing was signed or sent. Set the mode, or restart Gateway, as the message says (section 3.5). |
| 500 | Any other error from the node. |

Text the node sends back is cut and stripped of signature bytes before it goes into any answer or log. A 400 or 503 at submit is definite only after Gateway has written the release of that transaction to the pending file. If that write fails, the answer is the 504 case instead, so a restart cannot post something the caller was told was not sent.

### 4.1 Liquidity on Spectrum-style pools

Routes: `GET /trading/amm/quote-liquidity`, `POST /trading/amm/add`, `POST /trading/amm/remove`, `GET /trading/amm/position-info`, `GET /trading/amm/positions-owned`. Base is the pool's first side (ERG on an ERG/token pool) and quote its second, as `pool-info` reports them.

A deposit or redeem is one transaction, built and checked like a swap: the pool box is input 0 and its successor output 0; the wallet pays in, and what it receives comes back in its change. The pool counts its LP supply as `lockedLiquidity` minus the LP tokens it holds. Rounding, as the contract demands:

- Deposit of at most X and Y: the wallet receives `LP = min(floor(X * S / x0), floor(Y * S / y0))` and pays `ceil(LP * x0 / S)` and `ceil(LP * y0 / S)`, each at most what was offered. What does not fit the pool's ratio stays in the wallet (the pool would take it for nothing). `add` needs both amounts above zero; `quote-liquidity` treats 0 as no limit on that side. A deposit that buys no LP token is a 400.
- Redeem of LP tokens: the wallet receives `floor(LP * x0 / S)` and `floor(LP * y0 / S)`. `remove` takes exactly one of two fields. `lpTokenAmount` returns exactly that many LP tokens, read in the LP token's decimals: more decimal places than the token has is a 400 (never rounded), and more than the wallet's spendable LP tokens of the pool is a 400 that names both amounts (never cut down). `percentageToRemove` returns that share (read to 8 decimals) of the wallet's spendable LP tokens, rounded down. Both or neither is a 400. A side that rounds to zero is a 400.

**Which box is the pool.** A box is used for liquidity or a position only if it sits at a configured pool tree, its NFT was issued once, and it holds more than half of its LP token's emission. Only one box can hold more than half, and a real pool is created holding nearly all of it. Without this, a look-alike box holding one unit of a real pool's LP token could receive a wallet's whole LP position on a `remove`; the pool contract does not prevent that. When another box at a pool tree holds at least the LP amount in question of the same token, `remove`, `position-info` and `positions-owned` refuse with a 409 and name both boxes: a pool whose own box holds half or less of its LP token cannot be told apart from a box planted beside it.

**Entering and leaving.** `add` and `quote-liquidity` apply every pool guard and allowlist. `remove`, `position-info` and `positions-owned` do not: they keep only the checks above, so a provider can leave a pool that later falls under a reserve or fee guard or off an allowlist. A warning is logged when a guard is passed over this way. A `remove` the pool cannot pay in full (the sole provider of an ERG/token pool asking for 100%: the contract keeps a storage minimum) is a 400 that names the largest amount that can be removed.

Before signing, as for a swap: the fresh pool box and the mempool-successor rule; the guards and allowlist (on entry); the pool price (quote per base) at every build within `slippagePct` of the first fresh read, and of the confirmed box when someone else's unconfirmed box is used; what the wallet receives at least that read's less `slippagePct`; the check of the built transaction against its plan; the rebuild on a spent pool box; `submitMode`.

The answer to `add` or `remove` is PENDING with the transaction id and a `pendingData` block: what the transaction moves if it confirms, read from the transaction that was signed, as exact decimal strings. For `add`: `fee`, `poolAddress`, `baseTokenAmountAdded`, `quoteTokenAmountAdded` and `lpTokenAmountAdded` (the LP tokens the wallet receives). For `remove`: `fee`, `poolAddress`, `baseTokenAmountRemoved`, `quoteTokenAmountRemoved` and `lpTokenAmountRemoved`. The answer carries no `data`, because `data` means confirmed; confirmation comes only from poll. The same amounts are in the log line `ergodex: submitted deposit|redeem as <id>, PENDING; if it confirms: ...` and, with `submitMode: check`, in the 409's message. `quote-liquidity` has no field for the LP tokens a deposit pays; they are logged. Positions report confirmed balances only; when several boxes hold the same LP token, the real pool is the one used. Liquidity does not write Gateway's pool list for `ergodex`.

## 5. Differences from upstream that affect everyone

1. **Start-up no longer kills the process holding the port.** Upstream kills every process found on the Gateway port at start-up. In this fork it does so only when `GATEWAY_KILL_PORT_HOLDERS=true` (checked case-insensitively; only `true` counts). Otherwise, if the port is busy, start-up fails with a message that names the port and this variable. The code is in `src/services/port-holders.ts` and `src/app.ts`.

2. **Execute-swap request schemas.** The shared `AmmExecuteSwapRequest` and `ClmmExecuteSwapRequest` schemas gain two optional fields, `minAmountOut` and `maxAmountIn`. Only `ergodex` reads them; other connectors ignore them. The shared `ChainExecuteSwapResponse` gains an optional `pendingData`; other connectors never set it. The text of the `poolAddress` description changes.

   **AMM liquidity schemas.** `AmmAddLiquidityResponse` and `AmmRemoveLiquidityResponse` gain an optional `pendingData`; other connectors never set it. `AmmRemoveRequest` gains an optional `lpTokenAmount`, and its `percentageToRemove` becomes optional with no default. A request with both is a 400. A request with neither still removes 100% on every connector except `ergodex`, which must be told what to remove and answers 400. (The schema default of 100 had to go, because a default would turn an `lpTokenAmount`-only request into one with both; the route keeps the old meaning instead.) A connector other than `ergodex` given `lpTokenAmount` answers 400 `lpTokenAmount is not supported by <connector>; send percentageToRemove` and is not called; given `percentageToRemove` it is called exactly as before.

3. **Connector listing.** `/config/connectors` lists `ergodex`, and each entry may carry a boolean `binds_price_limit`. Only `ergodex` sets it. `/config/chains`, the wallet request enums and the shared list of accepted network names now include `ergo`.

4. **`openapi.json`** is regenerated to match these changes.

Nothing else was found that changes behaviour for Solana or Ethereum. This was checked by reading the diff of every shared source file in section 6 against `72d3938b`, and upstream's own Solana and Ethereum tests are part of the suite that passes at `0b0f0301`. Each other change is either a new `ergo` or `ergodex` case beside the existing `ethereum` and `solana` ones, or sits behind a test for chain `ergo` or connector `ergodex`. Examples: the pool is chosen by the connector only when the connector defines `resolvePool` (only `ergodex` does), and a request's connector is defaulted from the network's `swapProvider` only on chain `ergo`.

## 6. Shared upstream files this fork touches

Everything outside `src/chains/ergo`, `src/connectors/ergodex`, `test/chains/ergo`, `test/connectors/ergodex` and the Ergo templates (`src/templates/chains/ergo.yml`, `chains/ergo/`, `connectors/ergodex.yml`, the three Ergo schema files, `pools/ergo/`, `tokens/ergo/`). From `git diff --stat 72d3938b HEAD`.

| File | Why it changed |
|---|---|
| `src/app.ts` | Start-up kills a port holder only if `GATEWAY_KILL_PORT_HOLDERS=true`; a busy port gives a clear message. |
| `src/services/port-holders.ts` (new) | The test for that variable, and the message. |
| `src/chains/chain.routes.ts` | Registers `ergo` in the chain table (status, estimate-gas, balances, poll, wrap, unwrap) and validates its network config. |
| `src/chains/default-wallet.ts` | Returns `ergo.defaultWallet` for chain `ergo`. |
| `src/config/routes/getChains.ts` | Lists `ergo` among known chains. |
| `src/config/routes/getConnectors.ts` | Lists `ergodex`; adds the optional `binds_price_limit` field. |
| `src/config/utils.ts` | Adds `ergo` to the known chains used to read config namespaces. An update through the config API to the `ergo` namespace or an `ergo-<network>` namespace is refused with a 409 when that namespace's config file was changed on disk while Gateway was running (section 3.5). Other chains' updates are unchanged. |
| `src/services/config-manager-v2.ts` | Adds `ergo` to the chains whose network namespaces are collected. |
| `src/services/connection-manager.ts` | Adds `Ergo` to the chain instances and to the supported chain list. |
| `src/services/pool-service.ts` | Maps `ergo` to the Ergo chain enum; a pool and its tokens must be 64-hex ids. |
| `src/services/token-service.ts` | A token on `ergo` must have a 64-hex id. |
| `src/tokens/types.ts` | Adds `ERGO` to `SupportedChain`. |
| `src/pools/pool-info-helpers.ts` | Reads Ergo AMM pool info through the shared pool-info route; resolves Ergo token symbols (all-zero id is the native coin). |
| `src/schemas/chain-schema.ts` | Adds Ergo's networks to the accepted network names; adds optional `pendingData` to the execute-swap response. |
| `src/trading/common.ts` | On chain `ergo`, the default connector comes from the network's `swapProvider`; text of the `poolAddress` description. |
| `src/trading/connector-registry.ts` | Registers `ergodex` in the AMM registry; adds an optional `resolvePool` hook; passes `minAmountOut` and `maxAmountIn` through; adds an optional `quoteToken` to the pool swap arguments, passed to `ergodex` only. |
| `src/trading/pool-swap-routes.ts` | Adds the two optional limit fields; on chain `ergo`, a request that names no connector uses the network default; lets a connector choose the pool itself; passes the request's `quoteToken` to the connector's quote and execute (only `ergodex` reads it). |
| `src/trading/trading-amm-routes/pool-info.ts` | Routes `ergodex` to its pool info. |
| `src/trading/trading-amm-routes/add.ts`, `position-info.ts`, `positions-owned.ts`, `quote-liquidity.ts`, `remove.ts` | Each gets an `ergodex` case that calls the connector's liquidity or position function. `add.ts` and `remove.ts` skip the pool-list write for `ergodex`, as the swap route does. `remove.ts` also takes the optional `lpTokenAmount`, makes `percentageToRemove` optional without a default (the route keeps 100% when neither is sent, except for `ergodex`), refuses both, and refuses `lpTokenAmount` for any connector but `ergodex` (section 5). |
| `src/schemas/amm-schema.ts` | Adds optional `pendingData` to the AMM add and remove responses. |
| `src/trading/trading-amm-routes/create-pool.ts` | Gets an `ergodex` case that answers 501 "not supported yet". |
| `src/wallet/routes/removeWallet.ts`, `src/wallet/routes/setDefault.ts` | Validate an Ergo address for chain `ergo`. |
| `src/wallet/schemas.ts` | Adds `ergo` to the chain enums of the wallet requests. |
| `src/wallet/utils.ts` | Ergo wallets are added by their own function (so the error text never echoes the start of a secret); `ergo` joins the valid wallet chains and address checks. |
| `src/templates/root.yml` | Registers the namespaces `ergo`, `ergo-mainnet`, `ergo-testnet` and `ergodex`. |
| `docker-compose.yml` | Mounts `./db` at `/home/gateway/db` for the pending file. |
| `README.md` | A note at the top that this is a fork, a link to the instructions for testers (`TESTING.md` in the client fork), and Ergo and `ergodex` in the lists of supported networks and DEX protocols. |
| `package.json`, `pnpm-lock.yaml` | New dependencies (below). |
| `openapi.json` | Regenerated. |
| `test/app.integration.test.ts` | Allows chain `ergo` in the connector listing; checks that only `ergodex` sets `binds_price_limit`. |
| `test/services/port-holders.test.ts` (new) | Tests for the port-holder variable. |

New dependencies, exact versions as in `package.json`:

| Package | Version |
|---|---|
| `@fleet-sdk/core` | `0.12.0` |
| `ergo-lib-wasm-nodejs` | `0.28.0` |
| `ergo-lib-wasm-nodejs-alpha` (alias for `ergo-lib-wasm-nodejs`) | `npm:ergo-lib-wasm-nodejs@0.29.0-alpha-2f840d3` |

## 7. Merging a new upstream release

The fork is additive. Ergo code lives in its own folders. The edits to shared files are small registration lines beside the existing Solana and Ethereum ones. Conflicts, if any, are in the files in section 6.

1. **Fetch.** `git fetch upstream --tags`. Pick the release tag (for example `v2.19.0`) rather than the tip of `main`.
2. **Merge, do not rebase.** `feat/ergo` is published on the fork remote with the same head as the local branch. A rebase rewrites those commits and needs a force push; a merge does not. Make a working branch from `feat/ergo` and run `git merge <tag>`.
3. **Resolve conflicts, expected only in the section 6 files.** Most likely: `src/trading/connector-registry.ts`, `src/trading/pool-swap-routes.ts`, `src/schemas/chain-schema.ts`, `src/chains/chain.routes.ts`, `src/app.ts`, `src/wallet/utils.ts`, `src/templates/root.yml`. Keep upstream's change and re-add the Ergo line beside it. Take upstream's version of `package.json` and `pnpm-lock.yaml`, re-add the three dependencies from section 6, and run `pnpm install` to regenerate the lock file. Do not hand-merge `openapi.json`; step 5 regenerates it.
4. **Look for new hard-coded chain lists.** Search the merged tree for lists that name chains, for example `grep -rn "'ethereum', 'solana'" src`, and for new `switch` or `if` chains on connector names in `src/trading/`. Each new one needs an `ergo` or `ergodex` case if it is reached for Ergo. The integration test `test/app.integration.test.ts` checks that every connector trading type advertised by `/config/connectors` has a unified route behind it.
5. **Regenerate `openapi.json`.** `pnpm generate:openapi`. Upstream CI runs this and fails if `openapi.json` then differs from the committed copy.
6. **Verify.** The commands below are the ones upstream's CI workflow (`.github/workflows/workflow.yml`) runs, plus the type check and lint scripts from `package.json` (CI does not run those two; the pre-commit hook runs `lint-staged`).

   ```
   pnpm install --no-frozen-lockfile
   pnpm build
   mkdir -p conf && cp -rf src/templates/* conf/
   pnpm generate:openapi && git diff --exit-code -- openapi.json
   pnpm typecheck
   pnpm lint
   pnpm test
   ```

   `pnpm test` runs `GATEWAY_TEST_MODE=dev jest --verbose`. `pnpm lint` runs eslint with `--fix`, so it can edit files; review its changes.

   Tests need Node 22 or newer: `package.json` has `"engines": { "node": ">=22.0.0" }`. Upstream's CI workflow currently sets up Node 20, which is below that range. `package.json` has no pnpm entry under `engines`; it lists `"pnpm": "^10.10.0"` among its dependencies, and CI installs pnpm 10. Use pnpm 10.10 or newer.
7. **Compare with the last known counts.** At `0b0f0301`: 213 suites pass and 1 is skipped; 2,392 tests pass and 4 are skipped. A different number after a merge is expected if upstream added tests. A failure in `test/chains/ergo` or `test/connectors/ergodex` is not.
8. **Commit the merge** and push the branch to the fork.

## 8. Known limits and open items

- **No cancel route.** A submitted swap cannot be withdrawn through Gateway. A cancel would sign a new transaction that spends one input back to the wallet. It is not built.
- **No age limit on re-posting.** Gateway re-posts a dropped swap until it confirms or one of its inputs is spent. On a pool nobody else trades, an old swap could execute hours later at the pool's unchanged price.
- **A refused re-post can keep wallet boxes hidden.** If the node refuses a re-post (for example its minimum fee rose above the transaction's fee), the entry is kept and marked refused, and its wallet boxes stay out of selection. They return when someone trades that pool and the entry is resolved, or when you stop Gateway and remove the entry from the pending file by hand.
- **Large amounts.** An amount that needs more than 15 significant digits, or a whole number above 9007199254740991, cannot be sent as a JSON number and is refused.
- **Exact-output buys.** A BUY fixes the amount received and asks the contract for the smallest whole input unit that pays for it. On a token with few decimals one unit is a coarse step, so the input can be above the exact price.
- **Duplicate requests.** There is no request id. Two identical execute-swap requests each trade.
- **Not built:** LithosDex order mode, deposit and redeem; pool creation; Dexy; network files for the yolo chain. Liquidity and positions on a LithosDex pool, and pool creation, answer 501.
- **LithosDex liquidity, when built,** must first require the vault NFT's supply to be 1 and account for the provision tokens (the whole supply in the pool or in genuine provision boxes), or be allowed only on listed pools: the deployment check does not prove these, and a discovered pool with loose provision tokens can be drained through Redeem or Resize.
- **Liquidity answers carry no amounts.** An `add` or `remove` answers PENDING with the id only, and `quote-liquidity` does not state the LP tokens; see section 4.1.
- **Not proven:** a live swap, deposit or redeem (section 2).
