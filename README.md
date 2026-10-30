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
| [`desktop/`](desktop/) | The Electron app: screens, sign-in by code, the profile kept on this machine, bringing details across from a browser, the robots it runs for the site, booking a hand-off, the numbers it shares when its person says so, and the trace the site asks for, with the person taken out. Its [README](desktop/README.md) is the long version. |
| [`dmq/`](dmq/) | The California DMV robots (Node + Playwright): look for openings (`bin/rqp-scout.js`) and book one (`bin/rqp-handler.js`) over RQP/1 envelopes on a pipe, and the office catalogue. Its [README](dmq/README.md) says how they work, and where they stop. |
| [`simulators/`](simulators/) | Copies of booking sites that run on your own computer, which the robots are built and tested against so that no test takes a real appointment. [`ca-dmv/`](simulators/ca-dmv/) is the California DMV's. |
| [`docs/adding-a-line.md`](docs/adding-a-line.md) | Bringing a line for another booking site: what a line is made of, what can be built here today, and what is still missing. |

Installers for Windows, macOS and Linux are on the [releases page](https://github.com/grandrew/lineright-client/releases),
which is also where an installed app updates itself from.

## What leaves your computer

The profile — name, date of birth, licence, passport and Social Security
numbers, address, email, phone — is kept on this computer, encrypted where the
operating system allows, and is typed only into the booking form it is for,
when it is your turn. Sign-ins brought across from a browser go only into the
app's own browser. The app never sees a password.

The site, over its JSON API and one device token, hears:

- what you do in a line: the bids you place, change or withdraw — which
  line, which offices or how far, which times, how much — and how a turn
  ended, with the booking site's confirmation number;
- what this computer's robots found when the site asked them to look, which
  is the same for everybody: offices, days and times;
- a name for this device (the computer's name until you change it), the app's
  version and system, and how quickly it answers;
- the numbers the Advanced screen shows, only when you press **Share now** or
  let it share every six hours;
- the trace: what the app did, page by page and request by request, with every
  detail of the profile and anything shaped like one taken out before it is
  written down and again before it goes. The site asks for it a little at a
  time; the app never sends it of its own accord. **Settings → Advanced**
  shows the last of it as it would be sent, and turns it off, which deletes
  what was kept.

The logs the app writes for its person (**Help → Open the logs folder**) are
never sent anywhere. [desktop/README.md](desktop/README.md) has the long
version of each, and the site's own [privacy page](https://lineright.org/privacy)
what it keeps and for how long.

## What is not here

The site and the queue are LineRight Regbot's server, which is not open source.
The app talks to it only over its JSON API, as any client could, and pairs with
an account there by a code the person approves in their browser — the app never
sees their password.

The maintainers keep the long-running tests that run real apps against the
server with it. The DMV simulator the robots are tested against is here, in
[`simulators/ca-dmv/`](simulators/ca-dmv/), and runs without the server. With a
checkout of the server beside this one (`../lineright-server`, or
`LINERIGHT_SERVER_DIR`), the app in **developer mode** (View → Developer mode,
or `npm start -- --developer`) also offers **Practice on this computer**, which
runs that server and the simulator locally, and a few tests that hold the two
halves to one contract stop skipping. Nothing of the server, and no simulator,
is ever built into an installer.

Developer mode is also where the made-up sites a development server lists are
shown — marked as test sites — and where the app can be pointed at another
server; everybody else's app pairs with lineright.org and lists only what is
real there.

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
cd dmq && npm test && cd ..
cd simulators/ca-dmv && npm test && npm run test:robots   # the robots through the DMV simulator
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

A change to what the app sends the site — the sync body, a new kind of event in
the trace — goes with a test that nothing personal rides along:
`desktop/test/scrub.test.js` throws a random profile at the trace in every
spelling a form or a URL might use, and is the place to add to.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).

## Licence

Copyright 2026 The LineRight Regbot authors. Licensed under the Apache License,
Version 2.0 ([LICENSE](LICENSE), [NOTICE](NOTICE)).
