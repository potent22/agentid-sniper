# Selected upstream changes

Source: upstream v2.7.1, commit `08a681c`; adapted to the modular `dev` implementation.

- Entry thresholds are drawn once at first application construction: progress 60–70% and 100–130 Agent ID senders. `watch_state.json.entryThresholds` persists the draw across restarts.
- Participation counts use fetched transaction senders, not addresses in transfer topics. Old recipient-based agent counts are invalidated; unavailable transaction data does not count as a sender.
- Paid mints require a readable wallet or transaction limit in the implementation bytecode. A readable getter is a heuristic, not proof the contract enforces the limit. Refund-function detection is no longer an entry requirement. Existing upgrade, blacklist, serial deployment, simulation and receipt checks remain.
- Replay value uplifts try 2%, 5%, 10% and 20%. Every attempted value and final execution still use the existing cumulative 1.2 USDT budget; the premium is included in that budget.
- BNB price failures use the last valid quote or a 600 USDT default and issue a warning. Costs remain receipt-backed ledger entries charged at the reserved conservative ceiling, tagged `bnbPriceEstimated` when needed. A fallback quote is an estimate: the real USD value can differ from the nominal budget.
- Optional Telegram group monitoring, popular-website discovery and inscription notifications are modular read-only inputs. Social mentions only add candidates; they do not bypass chain checks. No automatic inscription minting was added.

## Telegram setup

Run these commands yourself in the installation directory:

```sh
npm install --no-save --package-lock=false telegram@2.26.22
node tg-login.mjs
```

Enter your credentials only in your own terminal. Login is saved in ignored `data/tg_user.json` with owner-only permissions. Set `telegram.monitorGroups` to `true` in your local config to enable polling. The default is off; this change does not install a package, sign in, or read any chats automatically.

Group monitoring reads messages from joined groups/channels and stores only discovery counters/cursors, group names and addresses. Popular sites are detected after two groups or three senders mention a domain. The website reader uses HTTPS, pins a public IPv4 destination, limits response size and rejects cross-domain redirects. Website content is untrusted input.

Telegram needs a real-account integration check after user login; offline tests cover parsing, mention thresholds, default-off behavior and candidate registration. No live login or mint is used to test these changes.

## Release boundary

This update preserves automatic free mint, the 1.2U per-wallet/per-contract principal cap, durable recovery and approval cleanup. It does not adopt upstream's 20U default, 60U daily principal cap, free-notification-only policy, or automatic swaps. Swaps remain blocked pending full Permit2 cleanup support. Updating `dev` does not switch the running instance.
