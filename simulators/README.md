# Simulators

A simulator is a copy of a booking site that runs on your own computer: the
same web addresses, the same pages and the same answers as the real site, with
appointments that are made up. It is how LineRight's robots are built and
debugged. A robot learns its way through the simulator first, and every test
of it runs there, so no test ever takes an appointment somebody needs.

| | |
|---|---|
| [`ca-dmv/`](ca-dmv/) | The California DMV's appointment site: offices, a busy calendar, cancellations, the human check, booking, cancelling, and the site changing under the robot. The robots in [`../dmq/`](../dmq/) are tested against it. |

```bash
cd ca-dmv
npm start                 # http://127.0.0.1:8787
npm test                  # the simulator's own tests
npm run test:robots       # the real robots through it, in a real Chromium (npm ci in ../dmq first)
```

Bringing a line for another site? [`../docs/adding-a-line.md`](../docs/adding-a-line.md)
says what a line is made of. A simulator of the site is the first piece.

## Writing one for another site

Start from `ca-dmv/`: one Node server with no dependencies, in four parts.

| File | What it holds |
|---|---|
| `world.js` | What exists to book: places, hours, holidays, how busy each place is, cancellations. Deterministic from a seed (`TESTSITE_SEED`), so a test sees the same world each run. |
| `server.js` | The addresses and the JSON the site answers with, the human check, holds, bookings, and the `/__admin` endpoints that make the hard cases happen on demand. |
| `pages.js` | Every page. The parts the robot reads by role, label or class are listed at the top as load-bearing. |
| `theme.js` | The stylesheet. A person is shown these pages too, when a turn is handed to them. |

What makes a simulator worth testing against:

- **Faithful where the robot looks.** Use the real site's addresses, JSON
  shapes, button words and form labels. Write down what is not faithful, as
  `ca-dmv/README.md` does, and pin each difference in a test
  (`ca-dmv/test/gaps.test.js`).
- **The real site's shape of scarcity.** A calendar with openings next week
  tests nothing. The DMV's is booked solid for two months; the only near dates
  are cancellations, and they last minutes.
- **The ways it goes wrong.** Make every one of them happen on demand: the
  human check, a slot taken while the robot is on its way, a booking that never
  confirms, and the site renaming its buttons (`drift`). The robot's answers
  to these cases are what the tests are about.
- **Never mistaken for the real site.** Every page says it is a stand-in. The
  phone numbers and accounts are made up. It listens on this computer only.
- **Tests of its own, and of the robot through it:** `npm test` without a
  browser, and `npm run test:robots` with one.
