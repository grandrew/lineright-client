# LineRight Regbot — the desktop app

**LineRight Regbot**'s desktop app for [lineright.org](https://lineright.org), and
the robots it runs. Open source, under the [Apache License 2.0](LICENSE).

LineRight Regbot keeps an open, orderly line for appointments that are hard to get —
the California DMV first. The line itself lives on the site; this app is where a
person joins it, watches it and books: it keeps their details on their own
computer, its robots look for openings when the site asks, and when a slot is
theirs it books it for them — or opens the booking page and types their details
in, when the site wants a person.

| | |
|---|---|
| [`desktop/`](desktop/) | The Electron app: screens, sign-in by code, the profile kept on this machine, bringing details across from a browser, the robots it runs for the site, booking a hand-off, telemetry it shares only when asked. Its [README](desktop/README.md) is the long version. |
| [`dmq/`](dmq/) | The California DMV robots (Node + Playwright): look for openings (`bin/rqp-scout.js`) and book one (`bin/rqp-handler.js`) over RQP/1 envelopes on a pipe, and the office catalogue. Its [README](dmq/README.md) says how they work, and where they stop. |

Installers for Windows and Linux are on the [releases page](https://github.com/grandrew/lineright-client/releases),
which is also where an installed app updates itself from.

## What is not here

The site and the queue are LineRight Regbot's server, which is not open source.
The app talks to it only over its JSON API, as any client could, and pairs with
an account there by a code the person approves in their browser — the app never
sees their password.

The maintainers keep two more things with the server: a stand-in of the DMV
appointment site, which the robots' browser flows are tested against end to end
so that no test ever consumes a real appointment, and the long-running tests
that run real apps against it. With a checkout of the server beside this one
(`../lineright-server`, or `LINERIGHT_SERVER_DIR`), the app also offers
**Practice on this computer**, which runs that server and the stand-in locally,
and a few tests that hold the two halves to one contract stop skipping. Nothing
of the server is ever built into an installer.

## Running it

```bash
cd dmq && npm ci && cd ..
cd desktop && npm ci
npm run bundle          # the robots' browser, as an installer carries it
npm start               # the site config.json names (lineright.org)
npm test                # smoke runs need a display (xvfb-run on Linux)
```

and the robots' own tests:

```bash
cd dmq && npm test
```

Installers are built by `.github/workflows/desktop-release.yml` when a
`desktop-v<version>` tag is pushed (or by hand, `npm run dist` in `desktop/`),
and published to this repository's releases.

## Contributing

Issues and pull requests are welcome. Before sending a change, run `npm test` in
both `desktop/` and `dmq/`; on Linux the desktop suite's smoke tests want a
display, so `xvfb-run -a npm test` there. Please do not point anything at
dmv.ca.gov beyond the read-only live checks (`npm run test:live` in `dmq/`), and
run those sparingly: it is the state's website, and every appointment on it is
somebody's.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).

## Licence

Copyright 2026 The LineRight Regbot authors. Licensed under the Apache License,
Version 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
