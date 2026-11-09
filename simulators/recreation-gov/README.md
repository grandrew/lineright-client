# A Recreation.gov stand-in for the Yosemite robots

A local HTTP server that answers like Recreation.gov where the Yosemite robots
(`../../rgov/`) look: the campsite availability feed, and the booking flow a
person goes through — campsite page, order details, cart, payment,
confirmation. The robots are built and tested against it, so no test ever puts
a real campsite in a cart or charges anybody's card.

```bash
npm start                 # http://127.0.0.1:8788 — three open campsites at Upper Pines; /__signin signs you in
npm test                  # the stand-in's own tests, over HTTP, no browser
npm run test:robots       # the real booking robot through it, in a real Chromium (npm ci in ../../dmq first)
```

Point the robots at it with `RGOV_BASE_URL=http://127.0.0.1:8788`. The scout's
own tests (`../../rgov/test/processes.test.js`) read its feed too.

## What is faithful, and what is not

| | |
|---|---|
| **The feed** | Faithful. The address, the month-by-month answer, the campsite fields and the night statuses are Recreation.gov's, checked against the live feed on 2026-10-29 (`npm run test:live` in `../../rgov/`). |
| **The booking pages** | **Not yet checked against the live site.** They follow the flow Recreation.gov shows a person, with the labels and button words `../../rgov/src/selectors.js` looks for. Checking them means putting a real campsite in a real cart, so it is done by hand, with a stay the person wants — `RGOV_REHEARSE=true` in `../../rgov/README.md`. Where the live site differs, change the selectors and these pages together. |
| **Signing in** | A cookie, `rgov_session=ok`, set by visiting `/__signin`. The real site's sign-in is not copied: the app never signs in for anybody, it carries the person's own cookies. |
| **Scarcity** | Only the campsites a test puts there (`addCampsite`), open on the nights it says. The real Valley campgrounds sell out within minutes of a release; tests make that happen by taking a campsite between the feed and the cart (`gone-at-cart`). |

## The hard cases, on demand

`site.state.mode`, set by a test:

| mode | what happens |
|---|---|
| `gone-at-cart` | the campsite is taken between the feed and the order step |
| `decline` | the card is declined (so is `4000000000000002` in any mode) |
| `silent` | the order goes through and no reservation number is shown |
| `waiting-room` | every page sends the visitor to a waiting room |
| `rate-limited` | the feed answers 429 with `Retry-After: 60` |

Every page says it is a stand-in, the campsites are made up, and it listens on
this computer only.
