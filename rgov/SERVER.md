# The Yosemite line — what the server needs

The robots in this folder are half of the Yosemite campsites line. The other
half is lineright-server's, which is not in this repository: the site record,
the lines, the bid form, the reads it hands out, the matcher, and what it makes
of each answer. This is that half's contract, written against the envelopes
`src/rqp.js` reads and writes. Anything the server does for the DMV that is not
mentioned here is meant to work the same way.

## 1. The site and its connector

| | |
|---|---|
| site slug | `yosemite` |
| name | Yosemite National Park — campsites |
| connector | `recreation.gov.camps` (the app routes envelopes to these robots by `target.connector`) |
| app robot | `rgov-rqp/1` (the app now reports `['dmq-rqp/1', 'rgov-rqp/1']` in its sync body) |
| base_url | `https://www.recreation.gov` (the app sends robots nowhere else for this connector; a loopback stand-in in practice mode) |
| time zone | `America/Los_Angeles` |

Every envelope for this site carries
`"target": { "site": "yosemite", "connector": "recreation.gov.camps", "queue": "<line>" }`.
An envelope with no connector is treated as the DMV's, as before.

## 2. The lines

| queue slug | label | campground kind |
|---|---|---|
| `yosemite-campsite` | Yosemite campsite | `family` (12 campgrounds) |
| `yosemite-camp-4` | Camp 4 (walk-in) | `walk-in` |
| `yosemite-horse-camp` | Yosemite horse campsite | `horse` |

The catalogue is `catalog/yosemite-campgrounds.json`; keep a byte-for-byte copy
server-side, as for the DMV offices, so the campground a person names, the
distance the matcher measures and the campground a robot reads are one record.

## 3. The bid form → `personal_data`

What a person chooses when they bid, and the key it travels under:

| key | values | notes |
|---|---|---|
| `campground_mode` | `specific` · `area` · `radius` · `any` | like the DMV's `office_mode` |
| `campgrounds` | list of facility ids or names, best first | `specific`: the order is the preference |
| `area` | `Yosemite Valley`, `Wawona`, `Big Oak Flat Road`, `Glacier Point Road`, `Tioga Road` | `area` |
| `origin_lat`, `origin_lng`, `radius_miles` | numbers | `radius` |
| `nights` | 1–14 | length of stay; check the park's own limits per season and area before launch |
| `party_size` | 1–6 for Camp 4, else up to the campsite's `max_people` | |
| `vehicles` | 0–2 | |
| `equipment` | `tent` · `rv` · `trailer` · `van` | |
| `equipment_length_ft` | number, optional | RV/trailer only |

The arrival window is the bid's `slot.window` (`[first arrival, last arrival]`).
A campground of another line's kind must be refused at bid time — the robot
refuses it too (`rejected`), but by then the person has waited for nothing.

## 4. A hand-off's `robot.requires`

The profile keys the app adds to `personal_data` from the person's computer
before it books (booker.js `request`):

```
first_name, last_name, email, phone,
card_name, card_number, card_exp_month, card_exp_year, card_cvc,
street, city, state, zip
```

The profile now has a **Payment card** group for the card keys (secret, like the
licence number: scrubbed from every trace, never imported from a browser). The
address doubles as the billing address. If any is missing the app does not
book and opens the page for the person instead (`why: 'profile'`), as today.

## 5. Reads: `discovery.request` → `discovery.result`

```json
{ "protocol": "RQP/1", "kind": "discovery.request",
  "target": { "site": "yosemite", "connector": "recreation.gov.camps", "queue": "yosemite-campsite" },
  "campgrounds": ["232447", "232450", "232449"],
  "window": ["2027-06-01", "2027-06-30"],
  "nights": 2 }
```

`campgrounds` (or `offices`, accepted for symmetry with the DMV) is the union of
what the read's bids want; `window` the union of their arrival windows;
`nights` the **shortest** stay among them — the scout reports every run at
least that long, and the matcher filters per bid.

What it costs: one feed request per campground per calendar month the stay
nights touch, spaced 1.5 s. A read of the three Valley campgrounds over a June
window is 3–6 requests and about 5–10 seconds. So:

- **Pace reads by campground, not by bid.** One read per campground set per
  interval, shared by every bid that wants it. Suggested start: no campground
  read more often than once every 2–3 minutes across all apps, and never more
  than one app reading the same campground at once.
- **A gate stops everyone, not just that app.** `gate.kind` `rate_limited`
  (with `extra.retry_after`) or `blocked` means Recreation.gov asked for less:
  pause every read of this site — every app's — for at least `retry_after`
  (or 10 minutes), then come back at half the rate. Do not hand the read to
  another app to get round it.
- **Release mornings.** Most family campgrounds open a month of nights at a
  time, five months ahead, on the 15th at 7:00 a.m. Pacific (verify per
  campground each season; Camp 4 opens a week ahead). The queue exists so that
  people do not have to refresh at 7:00; it should not refresh at 7:00 on their
  behalf any faster than the steady rate above. The robots never wait in, or
  work round, a waiting room (`gate.kind: waiting_room`).

The answer:

```json
{ "protocol": "RQP/1", "kind": "discovery.result", "status": "confirmed",
  "offers": [ { "office_code": "232447", "office_name": "Upper Pines", "office_lat": 37.736111, "office_lng": -119.5625,
                "slot_date": "2027-06-29", "slot_time": "",
                "campsite_id": "100", "site": "044", "loop": "Upper Pines", "campsite_type": "STANDARD NONELECTRIC",
                "max_people": 6, "first_night": "2027-06-29", "last_night": "2027-07-02", "nights": 4 } ],
  "checked": [ { "office": "Upper Pines", "campground_id": "232447", "campsites": 235, "found": 10, "error": null } ],
  "gate": { "kind": "rate_limited", "page_url": "…", "step": "…", "extra": { "retry_after": "60" } } }
```

`slot_time` is empty: a campsite has no time. Camp 4's offers also carry
`spots` (the fewest places left on any night of the run). The offers table
needs columns for `campsite_id`, `site`, `loop`, `campsite_type`, `max_people`,
`first_night`, `last_night`, `nights` and `spots`, and its uniqueness key should
be `(site, campsite_id, first_night)` rather than `(office, date, time)`.

## 6. Matching an offer to a bid

An offer (a run of open nights *F*..*L* at one campsite) fits a bid when:

- its campground is one the bid takes (`office_code` in the bid's resolved list);
- some arrival *A* in the bid's window has *A* ≥ *F* and *A* + nights − 1 ≤ *L*;
- `party_size` ≤ `max_people` (and, for Camp 4, ≤ `spots`).

Allocate the **earliest** such *A*. Ties between bids go as for the DMV
(highest stake, then earliest bid). Then the run is only partly spent: the
nights *A*..*A*+nights−1 are taken, and what is left either side of them is
still an offer for the next bid. Record that split, or two bids are handed the
same campsite on the same nights.

The allocation goes on the booking request:

```json
"slot": { "window": ["2027-06-01", "2027-06-30"],
          "allocated": { "office_code": "232447", "office_name": "Upper Pines",
                         "campsite_id": "100", "site": "044", "date": "2027-06-29", "nights": 2 } }
```

`date` is the arrival; `nights` the stay. The robot checks the feed once more
before opening a page, and books that campsite for those nights and nothing else.

## 7. Bookings: `booking.request` → `booking.result`

```json
{ "protocol": "RQP/1", "kind": "booking.request", "job_id": 812, "idempotency_key": "rqp1-job-812-…",
  "target": { "site": "yosemite", "connector": "recreation.gov.camps", "queue": "yosemite-campsite" },
  "slot": { "window": [ … ], "allocated": { … } },
  "personal_data": { "campground_mode": "specific", "campgrounds": ["232447"], "nights": 2, "party_size": 4,
                     "vehicles": 1, "equipment": "tent" } }
```

What to do with each answer:

| answer | do |
|---|---|
| `confirmed`, `confirmation` = reservation number (`0123456789-1`) | booked: capture the escrow, show the number. `booked_date` is the arrival, `nights` the stay |
| `rejected`, `unconfirmed: true` | **never retry**: the order went and may be paid for. Refund, and tell the person to look in their Recreation.gov reservations |
| `rejected`, `payment_declined: true`, `cart_url`, `held_until` | nothing was charged. Refund the stake, and tell the person *now* that the campsite is in their Recreation.gov cart until `held_until` (link `cart_url`) — they can pay with another card before it lapses |
| `unavailable`, `slot_gone: true` | mark that run of nights gone and allocate the next offer |
| `unavailable`, with `gate` | park the job and ask the person (§8) |
| other `unavailable` | transient: retry while attempts remain, as for the DMV |
| other `rejected` | the bid is wrong (campground of another line, expired card, missing detail): refund, say why |

**The hold.** Recreation.gov keeps a site in the cart for about 15 minutes once
it is added. A booking turn's `seconds_left` should leave the robot at least
4 minutes from the moment it starts; the app already budgets
`min(seconds_left − 45, 240)` seconds per run.

## 8. Gates

| `gate.kind` | means | what the person is asked |
|---|---|---|
| `signin` | no Recreation.gov sign-in in the app, or it expired | "Sign in to Recreation.gov in the app" — the app opens the site in its own browser; next turn, the robot has the cookies |
| `waiting_room` | Recreation.gov is queueing visitors | book it themselves when through; the robot does not wait |
| `hcaptcha`, `recaptcha`, `turnstile` | a human check | clear it on the page the app opens |
| `blocked`, `rate_limited` | the site turned the robot away | from a scout: pause the site's reads (§5). From a booking: open the page for the person |

A gate after the order was placed comes back as `unconfirmed` with the gate on
it: the person finishes it on the page, and nobody may send it again.

## 9. Before going live

Things this work could not settle, which are yours to:

1. **Recreation.gov's terms on automated booking.** This line books and pays
   with a robot. Recreation.gov's rules pages could not be read here to check
   what they say about bots; in June 2026 Senator Heinrich asked the Forest
   Service to adopt a policy banning automated tools on Recreation.gov, and no
   adoption was found. Check the current terms, and consider asking
   Recreation.gov (it is run for the agencies by a contractor) before launch.
2. **Paid priority for federal campsites.** Stakes bought with money move
   people up this line. The site's own principles allow that only "where
   legally permitted"; check that for National Park Service campgrounds.
3. **Park rules a bid form should enforce.** Stay limits per season and area,
   people and vehicles per site, and that the reservation holder must be at the
   campsite — verify each on nps.gov/yose for the season, and enforce them at bid
   time rather than discovering them at checkout.
4. **The live pages.** Rehearse the checkout against the real site
   (`RGOV_REHEARSE=true`, README) and fix `src/selectors.js` where it differs.
5. **The card.** The card is typed into Recreation.gov's own payment form by
   the robot and nowhere else; the server never sees it. Check that is true of
   every trace you collect, the way `desktop/test/scrub.test.js` does.

## 10. Bookings the site lists (sync's `bookings`)

The app words and handles each booking by its site (`desktop/src/sites.js`), so
a Yosemite booking record should carry:

| field | value |
|---|---|
| `connector` | `recreation.gov.camps` — without it the app falls back to the host of `manage_url`, and then to the DMV |
| `date` | the arrival |
| `time` | the campground's check-in time (`HH:MM`, verify per campground), so reminders come before arrival rather than at midnight |
| `nights` | the stay; shown beside the time |
| `confirmation` | the reservation number |
| `manage_url` | the reservation's own page on recreation.gov, if the site can build one; otherwise the app opens the account's reservations |

`cancel_needs` is the DMV's alone: the app never cancels a Recreation.gov
reservation itself. Recreation.gov keeps a fee for cancelling ($10, and the
first night's fee the day before arrival or later, by its general rules), and
that is the person's to accept — so "Cancel reservation…" opens the
reservation for them, says what it costs, and leaves them to mark it cancelled.

## 11. What the app does for this line

- Asks once, in words that cover both sites, before it looks at a real booking
  site (`realDmvChecks` is one yes for both), and says in Settings that on
  Recreation.gov "Let the app book for me" also pays, with the profile's card.
- Words every turn, notice, oversight note and confirmation page by the turn's
  site; reads a confirmation number the person reaches by hand with the right
  robots' `parseConfirmation`.
- On a declined card, opens the person's Recreation.gov cart (only if it is on
  the hand-off's own site) and says until when it is held; on a `signin` gate,
  asks them to sign in on the page, which the app keeps for the next turn.
- Still the DMV's alone, and rightly: practice mode (its stand-in is the DMV's)
  and the DMV's cancel guide (`dmv-cancel.js`).
