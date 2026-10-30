# A DMV stand-in you can safely point the robots at

A local HTTP server that behaves like the California DMV appointment site: same
URL shapes, same JSON endpoints, the same gate on the same endpoint, the same
DOM the Playwright code drives — and, since it is also what a person is handed
when regbot asks them to finish a booking themselves, a site that reads like a
government site rather than a pile of unstyled inputs.

It exists because the interesting behaviour in LineRight Regbot — the reCAPTCHA
gate, a job parking for a human, a slot cascading to the next bidder, a booking
that races another bidder — can only be exercised end to end against something
that answers like DMV. Doing that against dmv.ca.gov means consuming real public
appointments. This is the alternative.

It lives here, beside the robots it tests (`../../dmq/`), as the example of how
LineRight's robots are built and debugged: everything a robot does to a booking
site is tried here first — reading a calendar, booking, the human check, a
booking that races another, and the site changing under the robot (`drift`,
below), which is what the desktop app's AI oversight is for. A new robot, or a
fix to one, starts by making it pass here. [`../README.md`](../README.md) says
how to write a simulator like this one for another booking site.

```bash
npm start                             # :8787, gate strict (behaves like live)
TESTSITE_GATE=open npm start          # auto-issues tokens: unattended happy path
TESTSITE_GATE=off  npm start          # no gate at all
node standin.mjs --port=0             # as the app's practice mode runs it: any free port, announced on stdout
```

Point the robots at it with `DMV_BASE_URL=http://127.0.0.1:8787` — the worker of
a server that looks for openings itself, the app's practice mode (which starts
it), or the robots' RQP/1 entry points by hand. With the gate `off` a sweep reads
the calendars; with `strict` it comes back blocked, as it would from dmv.ca.gov:

```bash
echo '{"protocol":"RQP/1","kind":"discovery.request","target":{"site":"ca-dmv","connector":"dmv.ca.gov.qmatic","queue":"vehicle-registration"},"offices":["Alturas"],"window":["2026-11-01","2027-02-28"],"hours":["08:00","17:00"],"timezone":"America/Los_Angeles"}' \
  | DMV_BASE_URL=http://127.0.0.1:8787 node ../../dmq/bin/rqp-scout.js
```

| File | What it is |
|---|---|
| `server.js` | Routes, the JSON API, the gate, bookings, MyDMV, `/__admin` |
| `world.js` | Offices, hours, holidays, demand, cancellations — what exists to book |
| `pages.js` | Every page, and the list of selectors that are load-bearing |
| `theme.js` | The stylesheet, served from `/portal/assets/dmv.css` |

## What is faithful

| | |
|---|---|
| `GET /portal/wp-json/dmv/v1/appointment/branches` | ungated, 200 |
| `GET …/appointment/services/` | ungated, 200 |
| `GET …/branches/{publicId}/dates` | **gated** — `400 {"code":"rest_missing_callback_param","data":{"params":["token"]}}`, byte-for-byte the real body |
| `#appointments-react-root` | carries `data-recaptcha-key`, `data-recaptcha-version="2"`, `data-disable-get-in-line` |
| reCAPTCHA widget | an `api2/anchor?size=invisible` iframe, so `readGate()` reads the same shape as live |
| The DOM | `#inputKeyWord`, `li.location-results__list-item`, "Select Location", `<day> Open Times`, "Choose an appointment time", Confirm → applicant form → Continue → Schedule appointment |
| View/Cancel Appointment | `/portal/appointments/appt-edit`: `#appointment-info-form` (first and last name, phone) → "View Appointment" → `POST …/appointment/my-appointments` → items `[data-appt-id]` (an id of its own, 64 hex characters, as on the live site — not the confirmation number) saying the office in capitals and "10/27/26, 10:00 AM, <service>", with "Cancel Appointment" → `#delete-confirmation` → `POST …/appointment/cancel-appointment` → "Your appointment has been canceled." The live page's ids and words, which the desktop app's cancel guide walks; ungated here, where the live site wants a token for both calls |
| Token semantics | **single-use**, TTL-bounded, and bound to the branch they were minted for |
| Service families | office-visit (VR/CID/RID/IBC) goes straight to location search; drive-test (DT/CDL/MC/KTR) is picked on a four-card "Choose a vehicle" page — Automobile, Commercial, Motorcycle, Knowledge Test Re-Evaluation — then demands licence + DOB |
| Office hours | every office keeps the hours the catalogue publishes — Alturas opens Tuesdays and Thursdays, most places open at nine on Wednesdays — and every office shuts on the twelve California state holidays |
| Demand | REAL ID is the scarce one, registration is not, and each office has its own load, so a board of bidders across a county does not see one uniform world |
| Drive tests | only at the offices that run them, and the last one of the day is earlier than the last counter appointment |
| Inventory | finite and deterministic from `TESTSITE_SEED`. Slots have capacity, so "3 customers" is a different question from "1". A booked slot is gone for everyone. |
| The calendar | **busy**. Nothing at all inside `busyDays` (60); the backlog only starts past it. A month grid, weekends and holidays greyed out, one gated `/dates` read per month paged |
| Holds | picking a time takes it off the market for ten minutes; walk away and it goes back on sale rather than being lost |
| Cancellations | a few every `cancelIntervalMs`, at a random office, service, weekday the office is actually open and time it is actually working — and gone again after `cancelTtlMs` if nobody takes them |
| Giving one up | cancel or reschedule with a confirmation number and a last name, and the slot goes straight back on the calendar |
| MyDMV | a sign-in, an account page listing what you booked, and details filled in for you at the form |

The busy calendar is not decoration. A DMV with openings next week is not
something anybody writes a bot for; a DMV whose next opening is in November,
where near dates exist only because somebody cancelled and only until somebody
else takes it, is. Everything about the latency argument depends on the calendar
being that shape, so this one is.

It also surfaced a price that a near-term calendar hides. "Next month" re-fetches
`/dates`, and a token is single-use, so **reaching a backlog two months out costs
a check per month paged** — not the single check the parked-job flow asks the
applicant for. `test/robots.test.js` pins it.

Token semantics are the part worth dwelling on. Because a token is single-use
and branch-bound, nothing can be pre-warmed or shared across a sweep — which is
what makes the cost-and-latency argument in the project plan testable instead of
theoretical. It is also what caught a real bug: the bot used to read the
calendar twice per booking (once to discover, once to book), so one applicant
solve was never enough and the person would have been asked twice. See
`TARGETED` in the robots' `src/bot.js`.

Two page-level details are load-bearing in the same way, and both have caught
something:

* **The calendar is never server-rendered.** The month heading and the day
  buttons arrive together, after `/dates` answers, and a month change clears
  both before fetching. Rendering the heading early would turn "we were not
  allowed to look" into "there is nothing here"; leaving last month's buttons up
  while the next month loads let a reader take this month's heading with next
  month's buttons — which is exactly how a scout ended up clicking a day that
  was no longer there.
* **The times page prints no clock time that is not bookable.** The booking flow
  reads every `h:mm AM` in the body as a slot to try, so office hours on that
  page would send it clicking at 5:00 PM. Hours live on the office card and the
  confirmation page instead. `test/flow.test.js` pins it.

## What is not faithful

- **The check is not reCAPTCHA.** It is a shim with the same shape and the same
  refusal behaviour. It cannot tell you whether a real solver would work against
  Google, and it is not meant to.
- No Qmatic, no rate limiting, no IP reputation, no bot scoring beyond the
  `navigator.webdriver` refusal.
- No email and no SMS: the confirmation page says what would have been sent.
- MyDMV is a toy. Accounts live in memory, hold nothing but a name, an email and
  a phone number, and are forgotten when the process stops.
- Geography is only what the office catalogue already carries — which is enough
  for real distances, since it carries coordinates.
- **It never pretends to be dmv.ca.gov.** Every page carries a stand-in badge in
  the state strip and says so again in the footer. A fixture that could be
  mistaken for the real site would be a worse fixture, not a better one.
- **Several of the scheduler's URLs are not here yet.** The live appointment
  app's own routes are `/select-location/A`, `/select-date`, `/select-info`
  and `/appt-confirm`, and it keeps the flow's state in the page, not in the
  address. This server serves the same flow on its own paths.
  `test/gaps.test.js` pins each difference and is marked `todo` until the page
  does it. The notes in that file say what was checked on the live site and
  where. Get in Line, the live page's same-day line, is not simulated, and its
  tests are commented out in that file.

## Gate modes

| `TESTSITE_GATE` | Behaviour | Use it for |
|---|---|---|
| `strict` (default) | No token to an automated browser (`navigator.webdriver`). The calendar sits on "Loading dates..." exactly as the real one does, and offers a person the "I'm not a robot" box. | The gate path: does the bot report a gate, does regbot park a job, does the cascade fire |
| `open` | Mints a token to anyone on page load | Unattended end-to-end booking runs |
| `off` | `/dates` needs no token at all | Isolating non-gate behaviour |

## Admin endpoints

For driving the cases that are hard to produce by waiting.

```bash
curl localhost:8787/__admin/state          # bookings, taken slots, solves, event log
curl -X POST localhost:8787/__admin/reset  # clear bookings, holds, tokens, log
curl -X POST localhost:8787/__admin/config -d '{"gate":"open"}'   # flip mode live
# make "Schedule appointment" go wrong: "taken" (a rival gets the slot, nothing
# is booked) or "no-reply" (booked, but the page never confirms it); "" is off
curl -X POST localhost:8787/__admin/config -d '{"commitFault":"no-reply"}'
# make the site "change" under the robots, as a real one does now and then:
# "labels" renames the time's Confirm, the details form's labels, Continue and
# Schedule appointment; "offices" renames Select Location; "confirmation" calls
# the number a booking reference, so the robot sees none. Any of them, comma
# separated ("" is the site as it was; TESTSITE_DRIFT at startup). The robot
# stops, and the desktop app's AI oversight is what takes over.
curl -X POST localhost:8787/__admin/config -d '{"drift":"labels,confirmation"}'
# what one office can do on one day, hours and holiday included
curl "localhost:8787/__admin/day?branch=<publicId>&service=RID&date=2026-11-23"
# take a slot out from under a run mid-flow — the race the cascade exists for
curl -X POST localhost:8787/__admin/take \
     -d '{"branch":"<publicId>","service":"VR","date":"2026-09-22","time":"9:00 AM"}'
# make a cancellation happen now: pot luck, or a slot you name
curl -X POST localhost:8787/__admin/cancel -d '{"count":3}'
curl -X POST localhost:8787/__admin/cancel \
     -d '{"branch":"<publicId>","service":"VR","date":"2026-09-28","time":"9:00 AM"}'
```

Times are `'9:00 AM'` style and a branch is the Qmatic public id from the office
catalogue (`676!3472dc…` is Poway), both exactly as they appear in `/__admin/state`.

`TESTSITE_OFFICES` decides how much of the office catalogue it serves: 12 by
default because that is enough for a test, and `0` for all 186. The catalogue is
alphabetical, so the default twelve are Alturas to Blythe — point a board of San
Diego bidders at that and every office lookup fails before a calendar is ever
reached, which reads as "no availability" and is nothing of the kind. Use `0`
for a run against real seeded demand.

The world's knobs are `/__admin/config` fields too — `busyDays`, `horizonDays`,
`cancelIntervalMs`, `cancelBatch`, `cancelTtlMs`, `holdTtlMs`, `apiDelayMs`,
`solveDelayMs`, `solveFailureRate` — or `TESTSITE_BUSY_DAYS`, `TESTSITE_CANCEL_MS`,
`TESTSITE_CANCEL_BATCH`, `TESTSITE_CANCEL_TTL_MS`, `TESTSITE_HOLD_TTL_MS`,
`TESTSITE_API_DELAY_MS` at startup. `apiDelayMs` is what the JSON API takes to
answer: zero in tests so they stay fast and deterministic, 220ms when you run
the server, because a government portal is a REST route over a database and it
shows.

`solves` is the count of tokens minted: the "cash burned" number, and the one to
watch when reasoning about what a solving service would cost.

## Signing in

MyDMV starts with one account, printed on its own sign-in page:
`applicant@example.invalid` / `dmv-stand-in`. Create others from the same page.
Signing in fills your name, email and phone into the booking form and lists what
you have booked — which is the flow the desktop app's browser tab is for.

## Running the desktop app against it

The app's practice mode (Settings → Server → Practice, in developer mode) runs
this simulator, the LineRight site and its worker on one computer, and the
app's robots look and book on the simulator, never on dmv.ca.gov. The site is
not open source: practice mode needs a checkout of it (`lineright-server`
beside this repository, or `LINERIGHT_SERVER_DIR`), and says so otherwise.

Without the site, the robots and the app's own tests use the simulator alone:
`npm run test:robots` here, and in `desktop/`, `test/oversight-e2e.test.js`
(the AI taking over a robot after the site changed) and
`test/dmv-cancel.test.js` (cancelling on the View/Cancel page).

A bid that reaches the front of a line parks at the gate when the gate is
`strict`, and the token the person supplies travels down through
`request.captcha.token` → `CAPTCHA_TOKEN` → the page. Nothing in that path
solves a check; it carries one a person made.

## Tests

```bash
npm test              # the stand-in's own behaviour, no browser needed
npm run test:robots   # drives the robots' real Playwright code against this server
```

`test/flow.test.js` covers the site over HTTP: search and distances, office
hours and holidays, capacity, holds and their expiry, booking, cancelling,
rescheduling, MyDMV, and the two page invariants above. It is fast and always
runs, including the one that holds the vehicle page to the robots' own service
map.

`test/robots.test.js` drives a real Chromium through the robots: the gating,
token single-use and branch-binding, a gated browser reporting a structured
gate, an applicant token opening the calendar, the one-solve-per-allocated-slot
invariant, paging a busy calendar, buying a solve, a full booking that consumes
its slot and reports the site's confirmation number, and the two
`commitFault`s, which must end unconfirmed rather than booked. They touch no
network. They are opt-in (`TESTSITE=1`) only because a real Chromium makes them
slow — they are the only cover the Playwright selectors have. The robots and
their Playwright are this repository's `dmq/` (`npm ci` and
`npx playwright install chromium` there first), found by `test/client.js`.

`test/cancellations.test.js` covers the calendar's shape: booked solid inside the
horizon, a backlog past it, cancellations that land near and far and lapse if
nobody takes them.

`test/gaps.test.js` is the live site's behaviour this stand-in does not have
yet, as checked on 2026-10-13:
- the bare type page as the front door, with its four Select buttons;
- `?option=` for an office visit ending on `/select-location/A`;
- a step loaded cold going back to the type page;
- the details form at `/select-info`;
- the map marker's second Select Location for each office.

Those tests are `todo` and fail, and `npm test` still passes. Take the `todo`
off a test once the page makes it true. Where each one comes from is written
above the test. The Get in Line tests are commented out at the bottom of the
file for now.

The stand-in reads the robots' own office catalogue, `dmq/catalog/`
(`TESTSITE_CATALOG` names another file), so the two never disagree on an office.
