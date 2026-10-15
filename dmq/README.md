# The California DMV robots

The robots the LineRight Regbot desktop app runs on the California DMV
appointment site, dmv.ca.gov. There are two, and each is one process that
reads one [RQP/1](#rqp1) envelope on stdin and writes one on stdout:

- **`bin/rqp-scout.js`** looks for openings. The site asks an app to check a
  line; the app hands this robot the offices and the window, and sends back what
  it found. A scout is given no applicant and no contact details, so it cannot
  book anything even if asked to.
- **`bin/rqp-handler.js`** books one slot: the slot the site allocated to the
  person using the app, with the details kept on their own computer, and only
  when they have said the app may book for them.

The app runs both on its own binary, as Node, with the Chromium the installer
carries (`../desktop/src/robots.js`). Nothing here runs by itself on a
schedule, and nothing books unless booking is switched on twice (see
[A note on booking](#a-note-on-booking)).

## The human check

**Availability cannot be read from an automated browser alone.** DMV fetches the
date list only after the page obtains a reCAPTCHA token (v2 Invisible, read live
off `#appointments-react-root`), and an automated browser does not get one. The
request is therefore never made and the office card sits on "Loading dates..."
indefinitely. The same gate returns `400 {"params": ["token"]}` on the JSON API.

Everything up to that point works: service routing, the credential gate, office
search, office selection, several offices in one run. The run then stops — not
with a generic error, but with a structured **gate** (`{kind, sitekey, page_url,
step}`, from `readGate()` in `src/bot.js`), which the app turns into the booking
page opened for its person, with their details filled in, so that they clear
the check themselves.

Getting past the check *on the applicant's behalf* would mean defeating bot
detection — a stealth driver or a CAPTCHA-solving service. That is not
implemented here and will not be. `CAPTCHA_SOLVER_URL` exists only for testing
against a local stand-in of the site: `src/config.js` refuses it unless both it
and `DMV_BASE_URL` are on loopback, so it cannot be aimed at dmv.ca.gov.

If DMV relaxes the gate, the live checks will say so: two of them pin the
current behaviour, including that the widget is still v2 Invisible.

## What a run does

1. Opens `select-appointment-type?option=<SERVICE>`.
2. For drive tests, clicks the vehicle card and enters the applicant's licence
   or permit number and date of birth. Office-visit services skip this.
3. Searches offices by name or ZIP and selects one.
4. Reads the calendar, month by month, and collects every day with open times
   inside the window. (This is where the human check stands — see above.)
5. Repeats for the next office.
6. A scout reports what it saw at every office. A booking run goes straight to
   the allocated office, day and time, and books that time and no other: if it
   is no longer listed, the run says the slot is gone and books nothing else.
7. A booking counts as booked only once the site shows a confirmation number,
   which comes back as the `reference`. If none appears within
   `CONFIRMATION_TIMEOUT_MS` the run ends `BOOKING_UNCONFIRMED`: the booking was
   sent and may exist, so it is neither claimed nor retried. A confirmed one
   also says where its confirmation page was (`confirmation_url`) and, with
   `RQP_CONFIRMATION_SHOT`, keeps a full-page picture of it there
   (`confirmation_shot`), for the person to see their confirmation as the site
   showed it; a replay says both again.

## Appointment types

Each LineRight line maps to one DMV appointment type (`SERVICE_BY_QUEUE` in
`src/rqp.js`):

| Line | `DMV_SERVICE` | What it books | Needs licence + DOB |
|---|---|---|---|
| `vehicle-registration` | `VR` | Vehicle or boat registration | no |
| `license-id` | `CID` | Driver's licence or ID card | no |
| `real-id` | `RID` | REAL ID | no |
| — | `IBC` | Industry Business Center | no |
| `drive-test-auto` | `DT` | Drive test — automobile | yes |
| `drive-test-commercial` | `CDL` | Drive test — commercial | yes |
| `drive-test-motorcycle` | `MC` | Drive test — motorcycle | yes |
| `knowledge-retest` | `KTR` | Knowledge test re-evaluation | yes |

The office-visit types go straight to office selection; DMV shows their
calendars without identifying anyone. The drive-test types show no availability
until a valid licence or permit number and date of birth are entered, so they
cannot be scouted: a scout has nobody to identify.

## Offices

A run takes a list of office names and/or ZIP codes and searches each in turn
within one browser session. A name is matched against the office card's own
text; a bare five-digit entry is a ZIP, for which DMV orders results by distance,
so the nearest is taken. One office failing does not abandon the rest of the
run. The earliest date across all offices wins, and ties go to the office listed
first, so the order is a preference.

### The office catalogue

`catalog/ca-dmv-offices.json` holds all 187 California field offices — booking
code, address, opening hours, latitude and longitude — plus the 44 partner
counters (AAA and friends) that are bookable but ungeocoded.
`catalog/ca-zip-centroids.csv` holds 1,763 California ZIP centroids from the U.S.
Census 2020 ZCTA gazetteer, which is public domain.

Both are generated from public sources, not written by hand:

```bash
node tools/build-catalog.mjs      # refreshes the office file from dmv.ca.gov's public endpoints
```

Every office is stored under **both** the name the website shows and the name
the appointment API books it under. Twenty-five of them disagree — the office
the site calls `Hollywood` books as `HOLLYWOOD COLE` — and a lookup that knew
only one of the two would break either the search box or the booking call.
`src/catalog.js` accepts either, plus the slug and the raw `publicId`.

Coordinates are what make "any office within 25 miles of me" real rather than a
guess from ZIP prefixes:

```js
const origin = resolveOrigin('92064');        // ZIP centroid, or an office
officesWithin(origin, 25);                    // -> 10 offices, nearest first
```

The LineRight Regbot server keeps a byte-for-byte copy of these two files, so
the office a person names, the distance the site measures and the office a robot
searches for are the same record.

## RQP/1

The envelopes are JSON, one in and one out, and the boundary is a pipe rather
than an import: the caller never hosts a browser, a hung page cannot wedge it,
and each side versions on its own. The app is the usual caller; a LineRight
server that looks for openings itself runs the same two entry points.

### Looking: `discovery.request` → `discovery.result`

```bash
echo '{"protocol":"RQP/1","kind":"discovery.request",
       "target":{"site":"ca-dmv","connector":"dmv.ca.gov.qmatic","queue":"vehicle-registration"},
       "offices":["Poway","El Cajon"],"window":["2026-10-01","2026-11-30"],
       "hours":["08:00","17:00"],"timezone":"America/Los_Angeles"}' \
  | RQP_MODE=simulate node bin/rqp-scout.js
```

The result lists offers (office, date, time) and, for every office named,
whether it was read. A sweep that meets a human check it has no way through
stops there and reports the gate: every office on the site sits behind the same
check, and the rest of the sweep would only wait at it again, the better part of
a minute an office, on the computer of whoever's app was asked to look.

### Booking: `booking.request` → `booking.result`

```bash
echo '<envelope>' | node bin/rqp-handler.js
```

It always writes one envelope and exits 0: a failed booking is a result, not a
crash.

| Robot outcome | RQP status | What it means |
|---|---|---|
| booked, confirmation number read | `confirmed`, with that number as `confirmation` | the appointment exists |
| sent, but no confirmation shown | `rejected`, with `unconfirmed: true` | it may exist: never retried, since a retry could book it twice |
| the allocated time is no longer listed | `unavailable`, with `slot_gone: true` | somebody else took it first |
| nothing in the window | `unavailable` | try again later: cancellations appear |
| found, but booking not switched on | `unavailable` | nothing was booked |
| bad or missing personal data | `rejected` | a retry cannot fix it |
| unmapped line, crash, timeout | `unavailable` | may be tried again |

### Idempotency

A booking can be asked for twice — the app can close after DMV committed a
booking but before the answer was sent — and a replay must return the original
confirmation rather than book a second appointment. So the replay store is on
disk (`RQP_STATE_PATH`): confirmed bookings are recorded, and so are unconfirmed
ones, which replay as the same refusal instead of running again. Any other failed
attempt is not recorded, so it cannot block its own retry.

It can also be asked for twice at once. An app closed or crashed mid-booking
leaves its robot running, and started again it sends a second one for the same
slot. Racing the first, the second would lose the slot to it and report it gone
while the person held the appointment. So a run marks its booking as under way
beside the store, with its process id, and says when it sends the form:

- a second run waits for a first that is still going, up to `RQP_WAIT_MS`
  (3 minutes), and answers with what it got;
- if the first is gone and had sent the form, the booking may exist: the second
  answers `unconfirmed` and records it, and nothing books it again;
- if the first is gone and had not, nothing was booked, and the second books it.

The booking robot goes on when nobody reads its output any more, so that it can
finish and record what it made; the scout stops within seconds of the process
that started it.

## A note on booking

A confirmed slot is a real appointment at a government agency, under a real
person's name and, for drive tests, their licence number. So booking is opt-in
twice over: an envelope asking for it is not enough, the process must also be
started with `RQP_ALLOW_BOOKING=true`, or the run is a dry probe that stops
before anything is held. The desktop app sets it only for a booking its person
agreed to.

## Configuration

The entry points turn an envelope into these variables (`requestToEnv` and
`discoveryRequestToEnv` in `src/rqp.js`); the caller's own environment supplies
the rest.

| Variable | Meaning |
|---|---|
| `RQP_ALLOW_BOOKING` | Must be exactly `true` before a run will book. Anything else is a dry probe |
| `RQP_STATE_PATH` | The replay store, default `./data/rqp-bookings.json`; the marks of runs under way, and its lock, sit beside it |
| `RQP_WAIT_MS` | How long a booking waits for another run of the same booking still going, default 180000 |
| `RQP_CONFIRMATION_SHOT` | Where a confirmed booking keeps its picture of the confirmation page (a `.png`); none without it |
| `RQP_TRACE_DIR` | A folder for everything the run does on the site (`src/instrument.js`): `events.jsonl` as it happens (requests and what was sent, responses and the site's data, failures, navigations, console, page errors, the run log's steps), each document as `doc-N.html`, and Playwright's `trace.zip` when the run ends. Secrets are struck out. None without it |
| `RQP_TRACE_SCREENSHOTS` | `1`: pictures in the trace too |
| `RQP_MODE` | `simulate`: answer without a browser or a network, to test both sides of the pipe |
| `RQP_SIMULATE_OUTCOME` | What a simulated booking ends with: `BOOKED_SUCCESS`, `BOOKING_UNCONFIRMED`, `FOUND_AND_STOPPED`, `SLOT_GONE`, or `NO_AVAILABILITY` (the default) |
| `RQP_SIMULATE_DELAY_MS` | How long a simulated run takes; a booking sends its form half way |
| `DMV_BASE_URL` | The site to drive, default `https://www.dmv.ca.gov` |
| `DATE_START`, `DATE_END` | Inclusive window, `YYYY-MM-DD` |
| `DMV_SERVICE`, `DMV_OFFICES` | The appointment type and the offices, from the envelope |
| `DMV_TARGET_OFFICE`, `DMV_TARGET_DATE`, `DMV_TARGET_TIME` | The slot the site allocated: booked directly, and nothing else |
| `DMV_LICENSE`, `DMV_DOB` | Drive tests only (`MM/DD/YYYY`) |
| `FIRST_NAME`, `LAST_NAME`, `EMAIL_ADDRESS`, `PHONE_NUMBER` | Required only for a booking |
| `CAPTCHA_TOKEN` | A token the applicant minted themselves, carried to the page that asked |
| `DISCOVER_DATES_PER_OFFICE` | Days per office a scout reads times for, default 2 |
| `CADMV_DATA_DIR` | Where the office catalogue lives, default `./catalog` |
| `OFFICE_DELAY_MS`, `CALENDAR_TIMEOUT_MS`, `CONFIRMATION_TIMEOUT_MS` | Pacing: the gap between offices (1500), how long a calendar may take before it counts as blocked (30000), how long to wait for a confirmation number (30000) |
| `HEADLESS`, `DEBUG_MODE`, `RUN_TIMEOUT_MINUTES`, `RUN_LOG_PATH` | Run behaviour |

Configuration is validated before the browser launches, and only what the run
needs is required: a vehicle-registration scout asks for no licence number and
no contact details.

## Tests

```bash
npm ci
npm test                          # offline: no network, no browser
npx playwright install chromium   # for the live checks only
npm run test:live                 # read-only checks against dmv.ca.gov
```

`npm test` is pure logic — the calendar, configuration, services, offices, the
catalogue, slots, the office constraint, the RQP/1 mapping — plus the two entry
points run as processes in simulate mode. `test/live.test.js` is read-only: it
loads public pages and public JSON and asserts the structures the robots depend
on. It never holds, confirms, books or cancels anything, and submits no personal
data. Run it sparingly; it is somebody else's website.

The robots' browser flows are also exercised end to end, bookings included,
against a stand-in of the DMV site that the LineRight Regbot maintainers keep
with the server. The stand-in is not part of this repository, because it is not
part of the app.

## Acknowledgement

The first version of these robots was built on
[SHEEPQUEEN422/dmv-bot](https://github.com/SHEEPQUEEN422/dmv-bot), a Playwright
script that walked the DMV's booking pages. The robots here have since been
rewritten throughout.
