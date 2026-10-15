# 1.3.0 validation — 2026-10-15

Working tree: `H:\Repositories\制約ワードウルフ\verify-repo`
Remote: https://github.com/MT0623Owner/-

## Local checks

- Existing core suite: passed (17 scenario blocks).
- New core/sync regression tests: 6 passed.
- Mobile Chromium browser tests: 6 passed.
- JavaScript syntax checks: passed.
- QR image decoded with jsQR to the room invitation URL; opening it prefilled the room code.

The regression tests reproduced the original failures before their fixes:
missing discussion deadline, fractional count settings, occupied-room overwrite,
unnecessary writes, destroyed input elements, blocked-storage entry failure,
late reconnection after leaving, and actionable buttons appearing before a write finished.

## Real Firebase smoke test

Ran `tests/live-smoke.cjs` against the local 1.3.0 site, using its configured Firebase project
and three isolated Chromium contexts with distinct anonymous identities.

Passed: room creation, two invitation URL joins, local topic generation, role confirmation,
10-second thinking phase, hidden submissions, ordered reveals, 60-second discussion deadline,
normal voting, and villager victory. No uncaught browser errors in the successful run.
The newly created test room was deleted after the run.

An initial live run exposed the next-action-before-write-completion problem. A browser
regression test reproduced it, the UI now disables buttons while saving, and the live rerun passed.

## Limits

- Chromium mobile viewport tests are not physical iPhone/Android camera or Safari tests.
- Gemini generation and real API keys were not used.
- Existing Firestore rules and authentication configuration were not deployed or changed.
- The shared room document still contains roles and hidden words. This release does not
  implement server-enforced game secrecy or anti-cheat isolation.
- Firebase writes in the unit/browser suites are mocked; the separate live smoke test
  is the evidence for real authentication and synchronized gameplay.
