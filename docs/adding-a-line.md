# Adding a line for another booking site

LineRight keeps an open, orderly line for appointments that are hard to get.
The California DMV is the first booking site it covers. This page is for anyone
who wants to bring another one: it says what a line is made of, what you can
build and test here today, and what is still missing before a line for a new
site can open on lineright.org.

## What a line is made of

A **line** is a queue for one kind of appointment on one booking site, such as
"California DMV: REAL ID". The site (lineright.org) keeps the line and says
whose turn it is. The apps' robots look for openings when the site asks, and
book the slot that has become somebody's.

| Piece | What it does | Where | For the DMV |
|---|---|---|---|
| **Robot** | Looks for openings and books one. Speaks RQP/1: one JSON envelope in on stdin, one out on stdout. | here | [`dmq/`](../dmq/): `bin/rqp-scout.js` looks, `bin/rqp-handler.js` books |
| **Simulator** | A copy of the booking site on your own computer. The robot is built and tested against it, so no test ever takes a real appointment. | here | [`simulators/ca-dmv/`](../simulators/ca-dmv/) |
| **Catalogue** | The places a line covers: names, addresses, coordinates, opening hours. | here (the site keeps a copy) | [`dmq/catalog/`](../dmq/catalog/) |
| **Person's guides** | When the app hands a turn to its person, it walks the booking page to their slot and types their details in. It also walks the page that cancels an appointment. | here | `desktop/src/dmv-guide.js`, `desktop/src/dmv-cancel.js` |
| **Connector** | The site's side of the robot: which robot to ask for, which places a bid may name, what the booking form needs, and what the AI is told about the site's pages. | the site (not open source) | `dmv.ca.gov.qmatic` |
| **The line itself** | Its name, time zone, how far ahead it books, its hours, and the least a bid may be. | the site | seven CA DMV lines |

## What you can do today

1. **Build a simulator of the site** in `simulators/<site>/`. Copy the shape of
   [`simulators/ca-dmv/`](../simulators/ca-dmv/) and follow
   [`simulators/README.md`](../simulators/README.md). Visit the real site by
   hand, as a person would, once or twice. Write down its addresses, its pages
   and how it refuses a robot, then make the simulator answer the same way.
2. **Write the robot** in a folder of its own beside `dmq/`. It needs two entry
   points that speak RQP/1, with the shapes in
   [`dmq/README.md`](../dmq/README.md#rqp1): `discovery.request` →
   `discovery.result` and `booking.request` → `booking.result`. Give it tests
   that drive it against your simulator, the way
   `simulators/ca-dmv/test/robots.test.js` drives `dmq/`.
3. **List the places** the line covers, in the catalogue format of
   [`dmq/README.md`](../dmq/README.md#the-office-catalogue).
4. **Open an issue or a pull request** named "A line for <site>", or ask for
   the site on [lineright.org/request](https://lineright.org/request). The
   maintainers add the connector and the line on the site. Until the gaps
   below are closed, a new robot also needs changes in the app.

### Rules for every robot

- Don't point a robot at the real site from a test. Tests use the simulator.
  A few read-only checks run by hand are as far as it goes, like dmq's
  `npm run test:live`.
- Don't solve a human check (a CAPTCHA). When the site asks for one, the robot
  stops and reports a gate. The person is asked, never a solving service.
- Book only the slot the request names, with the details it carries, and only
  when `RQP_ALLOW_BOOKING` says so.
- Report what the site said, not what you hoped. A booking with no
  confirmation on the page is `unconfirmed`, never `confirmed`.

## What is missing

These are the gaps between "a robot and a simulator for site X exist" and "a
line for site X is open". The first four are in this repository.

1. **The app runs one robot.** `desktop/src/robots.js` picks a script by its
   job (look, book, browse) and always from `dmq/`. It ignores the robot name
   the site sends with a read or a turn. It declares only `dmq-rqp/1`, and
   knows only the DMV's connector.
   *Needed:* a robot registry. Each robot folder would carry a small manifest
   (its name, its connector, its entry points, the web addresses it may
   visit). The app would declare every robot it carries and run the one the
   site names.
2. **Robots may go only to dmv.ca.gov or this computer.** `targetAllowed()` in
   `robots.js` refuses any other address. That is deliberate: a robot runs
   from the person's own internet connection. The person's yes to that is
   also the DMV's alone (`realDmvChecks`, "Check lines for everybody in line"
   — on the real DMV).
   *Needed:* the allowed addresses taken from each robot's manifest, and a yes
   per booking site, shown with that site's name.
3. **The person's guides are the DMV's, for every turn.** The app arms
   `dmv-guide.js` for any turn that has a slot, and `dmv-cancel.js` whenever
   the site names a page to manage the booking.
   *Needed:* guides chosen by connector, so a new site brings its own or none.
4. **The profile and the words are the DMV's.** The profile asks for a
   California licence number. About forty sentences in the app name the DMV,
   and the robots read the site's address from `DMV_BASE_URL`.
   *Needed:* profile fields that a line asks for (the site already lists each
   line's fields), app words that use the site's name, and a neutral
   `RQP_BASE_URL`.
5. **The site's side is not open.** A connector and a line are code on the
   site, so a new site waits for the maintainers.
   *Needed:* a general connector on the site, driven by a manifest kept here:
   the robot's name, the catalogue, the booking form's fields, the guide for
   the AI. A reviewed pull request here would then be all a new site needs.
6. **Lines are made of places.** Offers, bids and the check that an opening is
   believable all name offices. When a line has no offices, every opening it
   finds is dropped.
   *Needed:* a line that is the whole site, for appointments booked online or
   at one venue.
7. **RQP/1 is written down only as examples.** The shapes are in
   `dmq/README.md` and `dmq/src/rqp.js`.
   *Needed:* a versioned schema, including `browse.request` and the oversight
   channel. Also a conformance kit: one test that drives any robot through
   looking, booking, a human check, a slot gone, and a site that changed, on
   its own simulator.
8. **The AI cannot book a line by itself yet.** In developer mode, the AI can
   go through a site it is told about in words (`desktop/src/agent/sitetask.js`).
   A real line still needs a robot.
   *Possible:* a line whose site has no robot yet, booked by the AI from a
   written guide, at first only with the person watching.
9. **No public CI runs the simulator.** `npm test` and `npm run test:robots`
   in `simulators/ca-dmv/` run on a developer's computer, and in the
   maintainers' CI.
   *Needed:* a GitHub Actions job for pull requests, with Playwright's
   Chromium.
10. **An old site's made-up lines are guessed from the connector.** For a site
    that does not say which of its lines are made up, `developer.js` treats
    every connector but the DMV's as made up. A real new site served that way
    would be hidden. The registry in (1) fixes this as well.

The order above is roughly the order to close them in: 1–3 make a second
robot possible in the app, 5–6 make a second site possible on lineright.org,
and 7–9 make it easy for somebody outside the project to build one.
