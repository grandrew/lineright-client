# The Recreation.gov robots — Yosemite campsites

The robots the LineRight Regbot desktop app runs for the Yosemite campsites
line, on Recreation.gov. Like the DMV robots beside them (`../dmq`), there are
two, and each is one process that reads one RQP/1 envelope on stdin and writes
one on stdout:

- **`bin/rqp-scout.js`** looks for openings. It reads Recreation.gov's public
  availability feed for the campgrounds it is given — plain HTTPS, no browser,
  no sign-in — and reports every run of open nights at every campsite. It is
  given no applicant, no card and no sign-in, so it cannot book anything.
- **`bin/rqp-handler.js`** books one stay: the campsite the site allocated to
  the person using the app, for their nights, in their own Recreation.gov
  account, paid with the card in their profile — and only when booking is
  switched on twice (see [Booking](#booking)).

The app runs both on its own binary, with the Chromium the installer carries
(`../desktop/src/robots.js`, which picks these robots for any envelope whose
`target.connector` is `recreation.gov.camps`). They use dmq's replay store,
oversight channel, trace and Playwright rather than copies of them
(`src/shared.js`), so they ship with no `node_modules` of their own.

The server half of the line — the site record, the lines, the bid form, the
matcher — is in [SERVER.md](SERVER.md).

## The campgrounds

`catalog/yosemite-campgrounds.json` holds the 16 reservable campgrounds the
National Park Service runs inside Yosemite: facility id, name, kind, area of
the park, coordinates and campsite count. It is generated from Recreation.gov's
public search, not written by hand:

```bash
node tools/build-catalog.mjs      # asks recreation.gov's search again
```

A campground is found by facility id, slug, full or short name (`232447`,
`upper-pines`, `Upper Pines Campground`, `Upper Pines`). Each has a **kind**,
and each line takes one kind only:

| Line | Kind | Campgrounds |
|---|---|---|
| `yosemite-campsite` | `family` | Upper, Lower and North Pines, Wawona, Hodgdon Meadow, Crane Flat, Bridalveil Creek, Tamarack Flat, White Wolf, Yosemite Creek, Porcupine Flat, Tuolumne Meadows |
| `yosemite-camp-4` | `walk-in` | Camp 4 (one campsite on the feed, booked by the place) |
| `yosemite-horse-camp` | `horse` | Wawona, Bridalveil Creek and Tuolumne horse campsites |

## The feed

```
GET https://www.recreation.gov/api/camps/availability/campground/<facility id>/month?start_date=<YYYY-MM>-01T00:00:00.000Z
```

One answer per campground per month: every campsite, and for each night a
status — `Available`, `Reserved`, `NYR` (not yet released), `Not Reservable`,
`Closed`, `Open` (first come, first served). Only `Available` can be booked;
a campsite booked by the place (Camp 4) also says how many places are left, and
is open only while some are. Checked live 2026-10-29 (`npm run test:live`).

The scout asks politely and stops when told:

- every request says who it is (`USER_AGENT`, naming lineright.org);
- requests are spaced `RGOV_REQUEST_DELAY_MS` apart (1500 by default), across
  months and across campgrounds;
- a `429`, a `403`, or a page that is not the feed is a **gate**
  (`rate_limited` or `blocked`): the sweep stops there and says so, and nothing
  tries again from another address or under another name.

An offer is one run of open nights at one campsite, at least as long as the
shortest stay the read asked about:

```json
{ "office_code": "232447", "office_name": "Upper Pines", "office_lat": 37.736111, "office_lng": -119.5625,
  "slot_date": "2027-06-29", "slot_time": "",
  "campsite_id": "100", "site": "044", "loop": "Upper Pines", "campsite_type": "STANDARD NONELECTRIC", "max_people": 6,
  "first_night": "2027-06-29", "last_night": "2027-07-02", "nights": 4 }
```

The office fields carry the campground, so the matcher places it on the map as
it does a DMV office; the matcher cuts a stay out of the run (SERVER.md).

## Booking

What a run does, with `src/checkout.js`:

1. Asks the feed whether the allocated stay is still open. Not open: the slot
   is gone, and no page was opened and nothing went in a cart.
2. Opens the campsite page in a browser signed in as the person — the app hands
   over their Recreation.gov cookies, and only those, as a storage-state file
   for this run alone (`RGOV_STORAGE_STATE`). Not signed in: a `signin` gate.
3. Chooses the nights and books; fills in the order details (party size,
   vehicles, equipment) and acknowledges the campground rules.
4. Goes from the cart to payment, noting how long the cart holds the site; fills
   in the card and billing address.
5. Places the order (`hooks.onSubmit` just before it: from here a reservation,
   and a charge, may exist).
6. Reads the reservation number off the confirmation page.

| Robot outcome | RQP status | What it means |
|---|---|---|
| reservation number read | `confirmed`, with it as `confirmation` | the reservation exists and is paid for |
| order placed, no number shown | `rejected`, `unconfirmed: true` | it may exist and may be charged: never retried |
| card declined | `rejected`, `payment_declined: true`, `cart_url`, `held_until` | nothing charged; the site sits in the person's cart until the hold ends |
| stay taken (feed or page) | `unavailable`, `slot_gone: true` | somebody else got there first |
| found, booking not switched on | `unavailable` | nothing went in a cart |
| a human check, waiting room or sign-in | `unavailable`, with `gate` | the person's to clear; after the order went, `unconfirmed` too |
| bad bid or profile (unknown campground, wrong line, expired card…) | `rejected` | a retry cannot fix it |

Booking is opt-in twice: an envelope asking for it is not enough, the process
must also be started with `RQP_ALLOW_BOOKING=true`, or the run is a dry probe
that stops before any page opens. The desktop app sets it only for a booking its
person agreed to. The card is checked (Luhn, expiry, security code) before a
browser opens.

These robots stop at every human check — reCAPTCHA, hCaptcha, Turnstile, a
waiting room, "unusual activity" — and hand the page to the person. Getting
past one on the person's behalf would mean defeating Recreation.gov's bot
detection, which is not implemented here and will not be.

The replay store and its rules are dmq's: one booking per idempotency key on
this computer, a second run waits for a first still going, and an order placed
and never confirmed is never placed again. A declined card is not recorded, so
a new card can try.

### The pages are not yet verified live

The feed is. The campsite, order, cart and payment pages are written to the flow
Recreation.gov shows a person, found by role and label (`src/selectors.js`), and
driven end to end against the stand-in in `test/standin.mjs` — but not against
the live site, because that means putting a real campsite in a real cart. To
check them, by hand, with a stay you actually want:

```bash
# from rgov/, signed-in cookies exported to state.json, a window to watch
HEADLESS=false RQP_ALLOW_BOOKING=true RGOV_REHEARSE=true node bin/rqp-handler.js < booking.json
```

`RGOV_REHEARSE=true` runs the whole flow, card and all, and stops before the
button that pays. The site stays in your cart for its hold, for you to pay or
remove. It is read only from the environment of a process started by hand — no
envelope can ask for it. Where the live pages differ, fix `src/selectors.js`
and the stand-in together, and note the date it was seen.

## Configuration

| Variable | Meaning |
|---|---|
| `RQP_ALLOW_BOOKING` | Must be exactly `true` before a run will book. Anything else is a dry probe |
| `RGOV_REHEARSE` | `true`: stop before paying (by hand only, see above) |
| `RGOV_BASE_URL` | The site, default `https://www.recreation.gov`; a loopback stand-in for tests |
| `RGOV_STORAGE_STATE` | The person's sign-in: a Playwright storage-state file |
| `RGOV_REQUEST_DELAY_MS` | Gap between feed requests, default 1500 |
| `RQP_STATE_PATH`, `RQP_WAIT_MS`, `RQP_CONFIRMATION_SHOT`, `RQP_TRACE_DIR`, `RQP_TRACE_SCREENSHOTS`, `RQP_CONTROL` | As for dmq |
| `RQP_MODE`, `RQP_SIMULATE_OUTCOME`, `RQP_SIMULATE_DELAY_MS` | Simulate mode; outcomes as dmq's plus `PAYMENT_DECLINED` |
| `CONFIRMATION_TIMEOUT_MS`, `RUN_TIMEOUT_MINUTES`, `HEADLESS`, `DEBUG_MODE`, `RUN_LOG_PATH` | Run behaviour |

The envelope supplies the rest (`requestToEnv` in `src/rqp.js`): the campgrounds,
the arrival window, the nights, the allocated campsite, the party, and — for a
booking — the contact details, card and billing address. They are passed to the
robot in memory, never through the operating system's environment.

## Tests

```bash
npm test             # offline: no network, no browser (the stand-in's feed over loopback)
npm run test:e2e     # the checkout in Chromium against the stand-in (needs ../dmq's Playwright browser)
npm run test:live    # two read-only requests to recreation.gov's feed
```

Run the live checks sparingly. It is a public service, and every campsite on it
is somebody's holiday.
