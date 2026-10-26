# LineRight Regbot — the desktop app

The LineRight Regbot application for a person's own machine. The line itself — who is
waiting, in what order, what a place is worth — is kept on the public regbot
site (lineright.org, run by lineright-server), and the person's account is there. The app pairs with that
account by code and does everything else from this computer: its screens show
the sites, each line's live order book, your console and a profile, drawn from
the site's JSON API over one device token; its robots look for openings when the
site asks, for everybody in line; and when the site says a slot is yours, the
app opens the booking page in a tab, with your details filled in and a bar over
it saying what to do — or, once you let it, its robot books it with the details
kept here. Your personal details stay on this machine and go only into the
booking form they are for, and the app never sees your password.

The first time it opens it offers to bring your details across from a browser
you already use, then asks you to create your account on the site — or sign in —
and approve the code it shows (see *Your account on the regbot site*, below).
The site it pairs with is the one `config.json` names: `https://lineright.org`
(for a development site, `--server=http://127.0.0.1:5000`, or Settings in
developer mode).

What only the people who work on LineRight Regbot need is behind **developer
mode** (View → Developer mode, or `--developer`; see *Developer mode*): the
test sites a development server lists, other servers, Chromium's developer
tools, and **Practice on this computer** — a whole regbot of the app's own (the
website and its JSON API, the queue processor, the control room, the
California DMV robots and a DMV stand-in for them to practise on), a private
line with simulated rivals and nobody to sign in to. The robots and their
browser come with the app; the server and the stand-in are lineright-server,
which is not open source and never ships in the app, so practice is offered
only where a checkout of it is on the same machine.

The app becomes a browser only when a booking site needs one: then the same
window shows tabs and an address bar over a sandboxed page, and types your
details into the booking form for you.

```
┌────────────────────────────────────────────────────────────────────────┐
│ File   Sites   View   Help                                             │  native menu
│ [Sites] [Console]  Sites › California DMV › REAL ID    ada ⧗2,480 ⚙   │  the app's bar
│ ☞ Your turn · REAL ID — Poway, 2026-10-06 at 10:00 — 4:32 left         │  the hand-off
│                          [Open the booking page] [I booked it] [Pass]  │
├────────────────────────────────────────────────────────────────────────┤
│  the screen: sites, a line's board and your position, the console,     │
│  your profile, settings, help                                          │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│ [◉ regbot] [☞ Your turn — REAL ID ×] [+]                               │  browser mode:
│ ‹ › ↻ ⌂  www.dmv.ca.gov/portal/appointments/…        [✎ Fill form]     │  tabs, address
│ ☞ Your turn · REAL ID — Poway … 4:12 left  [I booked it] [Pass]        │  the hand-off
│   Book it on the booking page: choose Poway on 2026-10-06 at 10:00 …   │  what to do
├────────────────────────────────────────────────────────────────────────┤
│                 the booking site, in a sandboxed tab                   │
└────────────────────────────────────────────────────────────────────────┘
```

## Running it

```bash
cd dmq && npm ci && cd ..                    # the robots the app runs
cd desktop
npm ci
npm run bundle                               # once: the robots' browser, as an installer carries it
npm start                                    # the site config.json names
npm start -- --developer                     # developer mode, for one run
npm start -- --practice                      # practice: the lineright server from a checkout beside this one
REGBOT_SERVER_URL=https://regbot.example npm start     # another server, for one run
```

A checkout runs the sibling `../dmq` robots themselves, so an edit there is
what runs, with the browser `npm run bundle` put in `vendor/` — or Playwright's
usual cache when there is none (`cd ../dmq && npx playwright install
chromium`). Practice runs the lineright server from a checkout of
lineright-server beside this repository (`LINERIGHT_SERVER_DIR` names one
anywhere else), on that checkout's `regbot/.venv` and otherwise `python3`;
`REGBOT_PYTHON` names another outright.

Which server the app uses (`src/server-choice.js`): `config.json` names the
public site a build pairs with, `https://lineright.org`; a build for another
site names that one, and an empty one makes the app practise on its own (which
needs a lineright-server checkout, below). Settings changes it on one
machine, in developer mode: the site, Practice on this computer, or another
server at an address.
`--server=<url>` (or `REGBOT_SERVER_URL`) uses another for one run and
`--practice` (or `REGBOT_SERVER_MODE=builtin`) the app's own, without saving
either. A device token is kept with the server that issued it and offered to no
other. `regbot.json` holds only what was chosen — a build's default is worked out
each time it is read, so a build naming a new site moves everybody who had not
chosen one — and is readable by this user only.

On Ubuntu 24.04 and later an unpackaged `npm start` needs `--no-sandbox` (or
`ELECTRON_DISABLE_SANDBOX=1`) because the checkout's sandbox helper is not
setuid; packed builds decide that for themselves (see Installers).

## Developer mode

Everybody else's app is the public one: it pairs with the site `config.json`
names and lists the sites there that are real. Developer mode
(`src/developer.js`) adds what only the people who work on LineRight Regbot
need, and the top bar says **Developer mode** while it is on:

* **Test sites.** A development or practice server lists made-up sites beside
  the real ones — for demos, practice and tests — and says which (`mock` on a
  site, a line and a position, from the server's simulated connectors). Off,
  the app lists none of them and will not open one's page; on, each is marked
  **Test site** on its card, its page, its line and in the Sites menu. A server
  from before it said so is taken at its connectors: there, a site on a booking
  system the robots do not work (anything but `dmv.ca.gov.qmatic`) is a test
  site.
* **Other servers.** Settings → Server offers *Practice on this computer* and
  *Another LineRight Regbot server*; off, it offers the public site only (an app
  left on another server says so, with the way back). Settings → Updates takes
  an update feed of the app's own, which is followed only in developer mode.
* **Chromium's developer tools**, in the View menu.

**View → Developer mode** turns it on or off, and the app remembers
(`developerMode` in `regbot.json`). `--developer`, or `REGBOT_DEVELOPER=1`,
turns it on for one run, and practising holds it on: in either case the menu
says so and cannot turn it off.

## Practice on this computer

Practice is the whole of regbot on this machine, and the server in it is
lineright-server — not open source, and not in this app — so it is offered
where a checkout of it is beside this repository or named by
`LINERIGHT_SERVER_DIR` (Settings → Server says so otherwise). Choosing it
starts, in this order and each as its own process:

| Process | What it is | Runs on |
|---|---|---|
| DMV stand-in | the server checkout's `testsite/`, serving the whole office catalogue — what the robots practise on and a hand-off opens | the app's own binary as Node (`ELECTRON_RUN_AS_NODE`) |
| Website | the server's `regbot/app.py`: the JSON API the screens read, and the website itself | the server's Python |
| Queue processor | the server's `regbot/worker.py`: discovery, dispatch, hand-offs, settling | the server's Python |
| Control room | the server's `regbot/admin.py`, started the first time it is opened | the server's Python |

and the processor runs the California DMV robots (`../dmq/bin/rqp-scout.js`,
`rqp-handler.js`) exactly as it does on a server — through the connector,
over RQP/1 on a pipe — except that the `node` it runs them with is the app's
own binary and the browser they drive is the one in the bundle. The app is
the supervisor.

* **Only on loopback.** Every one binds `127.0.0.1`, on the port it had last
  time if that is free and any free one if not, and says so on one line when
  it is ready (the server's `regbot/desktop_host.py` and `testsite/standin.mjs`). Nothing is reachable
  from another machine.
* **Watched.** One that exits is started again after 1 s, 2 s, 4 s … up to
  30 s, and Settings → Server shows it and the last thing it said. A Python that
  is not there at all is reported once, not retried.
* **Gone with the app.** Each holds a lifeline to the app on its stdin and
  exits when it closes, so even a crashed app leaves nothing behind. Quitting
  closes the lifelines, then stops each process with everything it started — a
  robot mid-run and its browser included (a process group; on Windows,
  `taskkill /T`) — and exits once they are gone, within a few seconds.
* **Signed in as you, without a sign-in.** The first start makes an account
  named after your login, with the practice credits every practice account starts with, and a device token
  for the app; nothing asks for a password. The token is kept beside the
  database, and if it is ever lost the next start gives the app a new one for
  the same account rather than a stranger's. **View → Control room** opens the
  server's control room in a tab, unlocked through a key that changes every
  launch.
* **Its data is yours.** Under the app's user data, in `server/`: the
  database, `desktop.json` (the token, the session secret, the control room's
  key, the ports), `regbot.env` (read at start: set `RQP_ALLOW_BOOKING`,
  `REGBOT_BOOKED_BY`, Stripe keys and the like there), `logs/` (one per
  process, plus the robots' run log) and `bot/` (the robots' replay store).
  Settings → Server opens each.

**Starting over.** Settings → *Start over* → *Reset everything…* lists what
goes, and on a second click deletes all of it: the server's folder above (its
account, lines, practice credits and history, its settings file and logs), the profile,
the app's settings, and everything booking sites stored in the tabs (the app
page's own storage too). With somebody else's server chosen, this device is
signed out there first, and the account there stays. The app does not
restart: it stops its server, deletes (`src/reset.js`), clears what Chromium
kept, and carries on as on its first launch, with a new server of its own.
The server's folder is deleted first because, on Windows, a process that just
exited can still hold one of its files. If it cannot be deleted, the reset
stops there and the profile and settings are kept.

**Practice, or the real DMV.** Until you choose otherwise the robots look for
slots on the stand-in, book them there for the bids they book (the form
submitted, the confirmation read back), and a hand-off opens its pages — the
whole California line works end to end, and nothing reaches dmv.ca.gov.
Settings → Server →
*The real DMV* restarts the site and the processor pointed at dmv.ca.gov
instead. It is a choice made on purpose because it means this computer reading
the state's calendar every couple of minutes, for every bidder on the board —
the simulated rivals included, until they are turned off in the control room
or with `REGBOT_CROWD=0` in `regbot.env` — and a robot books nothing there
unless `regbot.env` says `RQP_ALLOW_BOOKING=true`; the machine's own
environment cannot switch that on. Where the stand-in should be
running and is not — a server checkout from before it had one, say — the
robots are pointed at an address that answers nothing, never at the real site.

The simulated rival bidders, the five made-up booking sites (each marked as a
test site here) and the simulated checkout are what they are on any regbot
server but the public one: a demo that moves. The control room turns the crowd
down or off.

## Your account on the regbot site

Unpaired, the app shows **Create your regbot account**. Its button asks the site
for a code, shows it, and opens the site's pairing page in your usual browser
with the code in it. Signed out there, that page is where an account starts: it
shows the code and this device, and offers to create the account — or sign in,
with a password or with whatever third-party sign-in the site offers, which is
exactly why it happens in a real browser and not in the app — each coming back
to the same code. Approving it is a separate click. The app polls until the code
is approved, is handed a device token, and is signed in. Nothing but the code
and a device name ever passes between them. It comes after the browser import
on a first run, and after *Start over*.

**File → Sign out** revokes the token. The account page on the site lists every
paired device and can remove any of them, and so can the app's own account tab;
the app's next sync is refused and it returns to the account screen. (Remove
*This computer* from the practice server and the app restarts its site, which
lets it back in: it is your own server.)

## Credits

Credits are what a place in a line is staked with. The balance is the site's —
the app shows it beside your name and every sync brings it up to date — and
**+ Credits** in the top bar, the balance itself, **File → Buy credits** and the
console's Credits tab all open the **Credits** screen: what you have to spend
and what is staked, the packs on sale, your purchases and every movement.

Buying opens the payment provider's own page — Stripe Checkout — in your usual
browser, where the card is typed; it never passes through the app. The screen
says it is waiting, asks the site every few seconds how the purchase stands (the
site asks Stripe), and shows the credits as soon as they are paid, with
*Open the payment page again* and *Cancel this purchase* meanwhile. The return
page opens in a browser that has never signed in to the site, on the purchase's
own token.

### Changing a bid

On a line's board, **Change range, time or amount…** (or **Change** beside a
position in the Console) opens a panel beside your position. The offices can
only grow — a wider range, or the offices around the one you named — and the
time only move later or reach farther: every slot your bid takes now stays in.
For each amount worth paying, the site says how many people ahead of you want
your offices, and how soon you would likely book, worked out by playing the
line's last week of found openings against the board as it is now. It suggests
one amount, with the reason in a sentence: often less than you bid, with the
difference back, because only the people who want your offices are in your way
(`ui/bidchange.js`). Nothing changes until
**Save**, which does all of it in one go. A bid can be lowered a few times a
day, and not at all once it has been handed a turn.

A bid or a raise your credits cannot cover is refused by the site, which says
how many are missing; the join form warns before you send it, and a refusal
opens the Credits screen with the pack that covers it marked and a way back to
the line. On a practice server the packs are free, and say so.

### A better opening, and the nearest one

Every sync says, for your bids, the nearest opening the site knows of and,
when a change to a bid would do better, that change. The app shows them on
bars under the top one; none changes anything by itself.

* **Your bid widened by itself** (`ui/widened.js`) comes first when it has: a
  bid whose time passed with nothing booked looks a step further — 5 hours
  becomes a day, 5 days two weeks — and again each day it stays unbooked (the
  site's `widen.py`). It says how far it looks now and up to when, and that
  **Settings → Bidding → Widen my bids by themselves** turns it off. A bid's own
  board has the same switch for that bid alone, and so does the join form.
* **A better opening**, and the rest of the site's suggestions
  (`ui/advice.js`), name a change and why, with a button that applies it: an
  opening open now that a wider range, a longer reach or the offices around
  the one you chose would take; or, looking back over the last two days, what
  would have caught the openings the bid missed — a longer reach, a later
  date, a wider range, a higher bid; or that the bid takes nothing now; or
  that turns came and went unbooked (its button opens Settings, where the app
  can book by itself). **×** closes one. It stays closed while the same change
  is suggested, until what it points to is a day or more sooner than when you
  closed it; then it is back.
* **Best bet** is the way of asking most likely to book, with its chance and
  your bid's, when it is clearly likelier. **Use this** makes that change.
* **Nearest opening** (`ui/situation.js`) says where and when, and why your
  bid does not take it: outside your range, past your reach, another office,
  or one you passed. It first appears 5 minutes after an opening becomes the
  nearest, comes back 30 minutes after **×**, then every 5 hours. While it is
  up, a new nearest opening takes its place at once. The nearest opening
  changes back and forth as real ones come and go, so the app remembers the
  last two dozen and their waits: one that comes back carries on where it
  was, and is announced once.

A turn, or a suggestion on the first bar, keeps the second bar out of the way
without closing it. A suggestion you closed does not.

### Three ways to ask

The join form shows three ways to ask for the line, each with its chance of
an appointment by the date it ends: the soonest with an even chance, the best
bet, and the surest (`ui/options.js`). The site works them out from the
openings its apps have seen on the line over the last week, at your offices
and a little wider, against the bids ahead of yours (the site's `chances.py`).
Picking one fills the form in; nothing is placed until you bid. Above them it
says the chance of the form as you filled it in. It is an estimate: next week
is taken to be like last week, so the app says "about".

## Advanced: telemetry and diagnostics

**Help → Advanced** (or **Settings → Advanced**) is how this app is doing, kept
on this computer for the last day in `telemetry.json` (`src/telemetry.js`):

- every conversation with the site — how many syncs, how many failed, how long
  they took (median and 95th), when it was offline and for how long;
- the round trips the site timed on its own clock, and how the site rates the
  connection among the apps online;
- what the robots did — reads (looked, stopped by a check, failed, openings
  found), robot runs and how long they took, bookings and how they ended;
- the memory and CPU of all the app's processes, once a minute.

Six charts over 1, 6 or 24 hours (drawn by `ui/charts.js`, the same file the
site's admin panel uses), the tiles above them and a log of what happened.

**Share now** sends it to the site this app is signed in to (`POST
/api/client/telemetry`), after showing exactly what would go — *See exactly what
would be sent* — and asking. What goes is numbers and a fixed list of words
(kinds of event and how they ended), plus the app's version and operating
system: nothing from the profile, no line, office, date, booking reference or
page. A word that is not already one of those words is dropped rather than
tidied into one. Each share reaches back to the last (a day at most) and is
named by this install and where its period starts, so a share whose answer was
lost and is sent again is kept once; the site rate-limits them and says when to
try again. **Share automatically, every six
hours** is off until the person turns it on. **Clear this app's telemetry**
deletes it; so does *Start over*.

## The trace the site asks for

Besides those numbers, the app keeps a **trace** of what it does for the people
running LineRight Regbot, so they can see why a booking did or did not work —
with its person taken out first. It is made from what the app already writes
down (the logbook hands every record and line on as it writes it,
`src/tracetaps.js`), each robot run read back from its own record when it ends,
and what `main.js` says as it happens:

- the app starting (version, platform, locale and time zone, which fields the
  profile holds — never what is in them) and stopping, its numbers every five
  minutes, its own log line by line, its errors and crashes, sleep and wake, and
  what it told its person;
- every exchange with the site but the routine syncs and pings;
- every turn: when it arrived and how much time was left, how the app took it
  (its robot, another device, the page, a profile that was not ready), the
  notification and the click on it, how the booking ended and how long it took;
- the booking pages of a turn, and any page on a booking site: where the tab
  went, the status and how long each page took to load, every document and data
  request with its time to the headers and in all and its size, failures, the
  rest of a page's requests counted, console warnings and errors, captchas met
  and how far they went, what was clicked and changed (a field's value never —
  only its length and its shape), what autofill filled, a confirmation found;
  a page anywhere else is the site's name alone;
- every read: how it came out, what it found, how long, and how the site judged
  each opening; every robot run: how long, what it answered, requests by status
  and host, the slowest, any captcha — and, for a booking or a look that went
  wrong, its steps, pages, requests and console errors besides.

**Taken out** (`src/scrub.js`): every detail the profile holds, wherever and
however it turns up — names, date of birth, licence, passport and Social
Security numbers, address, phone, email, in any case, URL- or form-encoded,
HTML-escaped, a phone or SSN with or without its separators, a date of birth in
the formats forms use — each replaced by its name (`[first_name]`, `[dob]`);
every confirmation number the app is given or the site has recorded for its
person; this computer's account name and home folder; and behind those, the
shapes of an email, a phone, an SSN, a card number, a licence number and a
token. An address keeps its host and path, its query keys, and a query value
only when it is plainly nothing personal (a number, a date, a word) and its key
is not a personal or secret one. Events are scrubbed as they are written and
again as they are sent, so a value learnt later (a confirmation number) is
taken out of what was written before it was known. City and state stay: offices
are named after their cities.

**Kept** in `traces/` in the app's data folder (`src/traces.js`): numbered from
1 within one history (`stream`), a megabyte a file, at most 3,000 events a
minute (past that, counted and said), at most 64 MB and a week — the oldest
first, counted as lost.

**Sent only when the site asks.** Every sync says how far the trace goes
(`traces: {stream, next, oldest, urgent, on, …}`); the site answers how much to
write down (`level`: `full`, `outline` — no single requests — or `off`), how far
it has the trace (`acked`, and the app deletes what is behind it), and, when it
wants more, an ask. The app answers the ask with the events after the site's
mark, as many as it said, gzipped, to `POST /api/client/traces`. The site decides
when to ask each app, within a budget of its own, so it is never flooded; the
app never sends of its own accord. A site that says nothing of traces is never
going to ask, and the app stops writing them down for it.

**Advanced** shows how much is kept, what went and when, and the last events as
they would be sent, and turns it off: off, nothing more is written down and
what was kept is deleted. A notice says so once, on the first start of a
version that keeps a trace. *Start over* deletes it and turns it back on.

## Logs

Everything the app does is written down on this computer, so that what
happened on a booking site can be told exactly afterwards. It goes into
`logs/` in the app's data folder (**Help → Open the logs folder**, or
**Settings → Logs**), and the logs themselves are never sent anywhere. The
trace the site asks for (above) is made from the same records, with the person
taken out first.

| What | Where |
|---|---|
| The app's own log, line by line | `app-<day>.log` |
| Each request to the LineRight Regbot site, with what was sent and what came back (an answer the same as that path's last is written as `"same"`) | `site-<day>.jsonl` |
| Each page in the app's tabs: every request it made, with headers and body for the site's documents and data, the status and headers that came back, and the body itself; navigations, loads and failed loads; console messages; what was clicked, changed, submitted or entered (the element's tag, id, name, label, text and where it sits); what autofill filled (which field, how it was matched); a confirmation found; the cards over a turn's page | `pages-<day>.jsonl`, one JSON record a line, each naming its tab and job |
| Those pages' documents as they arrived, and each page as it stood after a step | `pages/<day>/…-tab<N>-doc<M>.html`, `…-tab<N>-page<M>.html` |
| The robots' run log | `robot-<day>.log` |
| One robot run: what it was asked and what it answered, all it printed (`run.json`); its network, console, steps and documents as they happened (`events.jsonl`, `doc-N.html`); and Playwright's trace of it (`trace.zip`: every action, the element it resolved to, the page before and after, the network — open it with `npx playwright show-trace trace.zip`) | `robots/<time>-<kind>-<what>/` |

The network is watched from outside the page, through the DevTools protocol on
the tab (`src/pagelog.js`), and clicks are noted and pages copied by a script
in a world of its own: the site's scripts see neither. A run killed part way
keeps `run.json` as it started and `events.jsonl` up to then, but no trace.

Logs are kept for three days unless **Settings → Logs** says otherwise (1 to
30), and checked at start and every hour; past 2 GB the oldest goes first
anyway. *Start over* deletes them.

What never goes in: passwords, tokens (the device's among them), cookies,
captcha answers, Social Security and licence numbers, dates of birth — each
replaced by `‹redacted, N chars›`, in records, addresses, bodies and headers
(`src/logbook.js`). A name, email or phone typed into a page is kept as its
length; a field that is nobody's — an office searched for, a date picked —
keeps its value. Request and response bodies the site sends back are kept as
they came, less those secrets, so a confirmation page, or a request that
carried your name and email to the DMV, shows them: that is what it was.

## Asking for a line

**Help → Ask for a site or a line** (or **Not here?** under the sites, and *Ask
for a line* on a site's page, which fills in the site) asks the people running
regbot for a booking system it does not cover yet — another state's DMV, a
consulate, a clinic — or another kind of appointment on a site that is here: its
address, what it is called, which appointments, where, whether you want
appointments there or run the system yourself, and anything they should know.
Everybody who asks for the same site and appointments is counted together.

What you wrote goes to the people running regbot only; the site, how many asked
and their answer are shown to everybody once they have read it, and anybody
signed in can add themselves with **Me too**. When they answer yours, the app
says so, and the answer shows on that screen (and under your account on the
site, where the same form is at `/request`).

## Looking for openings, and booking your slot

The site keeps the line; the looking and the booking happen on the people's own
computers, with the California DMV robots from `../dmq` that the installer
carries. Each runs as one process per job on the app's own binary as Node, with
the installer's Chromium, out of sight: an RQP/1 envelope in on stdin, one back
on stdout (`src/robots.js`).

**Looking, for everybody in line.** Each sync says what this computer can do
(`reader` in the body: on or off, which robots, what it is doing), and every app
that is free is handed a *read*: a line with bidders — the one fewest apps are
reading, then the one looked at longest ago — with which offices, which days,
which DMV. Several apps may read one line at once; nothing is held for anybody.
The app's scout looks, and the answer goes back to `POST /api/client/reads/<id>`;
the site keeps only what it asked about and walks the board with it, exactly as
with a report from **⌕ Found a slot**. The app shows what became of each opening
— "went to #1", or "is yours". One read at a time, none started while this
computer is booking, and the one in hand is given back as the app closes
(`…/reads/<id>/release`). Settings → *This computer's robots* → **Look for
openings for everybody in line** turns it off: the read under way is finished,
and no other is started (`src/reader.js`).

**Booking, when it is yours.** By default you book it. The app opens the
booking page in a tab — on the stand-in, the office's calendar; on the real
DMV, the line's appointment page — raises the window, notifies you, and types
your profile into the form when it loads. The bar over the page says which
office, day and time, the clock, and what each way out costs: **I booked it**,
**Pass** (the next person gets it at once and you keep your place), or letting
the clock run out, which takes you out of the line with the share of your bid
the site sets (`missed` in the hand-off; 70% unless its operator says
otherwise). When the tab shows the booking site's confirmation number — read
the way the robot reads it — the app says "I booked it" with that number for
you, so a booking made and never reported does not run out. When a turn ends,
however it ended, the bar says so over the page for a quarter of an hour:
booked and its number, gone on to the next person with your place kept, or run
out and what came back. A page you used — clicked, typed or scrolled in, or
steered from the address bar — stays open until you close it, and so does one
showing a booking confirmation. One you had no use for does not pile up (a
slot is offered to a few people at once, so a busy line hands you many turns
somebody else books): the next turn on that line opens in its tab, and
otherwise it closes when the bar stops saying how the turn ended — never while
it is the page in front of you (`src/turntabs.js`).

**Letting the app book for you.** Settings → *This computer's robots* → **Let
the app book for me** — off until you tick it, on the real DMV and a practice
one alike. The turn's booking page opens all the same, covered by a card
saying the app is booking it — so nothing is booked by hand beside it — and,
once the robot has booked, the card says **✓ Booked** with the confirmation
number, and the DMV's confirmation opens in a tab of its own: its page, when its
address carries the number and opens anywhere (the stand-in's does), otherwise
the full-page picture the robot kept of it (`robots/confirmations/` in the
user-data directory, the newest 40; `src/confirmations.js`). That tab stays
until you close it; with it open, the turn's own page goes once the turn is
over, like any you did not use. Another of your devices booking it covers the
page the same way, naming that device.

A hand-off for a slot on a line the app has a robot for carries the
booking request the site stored for it, the DMV to book it on, and which
details the form wants. With that yes, and if the profile has them, the app
claims the hand-off (`POST …/handoffs/<job>/claim`: the first of your devices to
claim it books it, and the others say which one is — and take it over, should
that one stop answering for half a minute), fills in only those
details — name, email, phone; for a drive test also the licence number and date
of birth, never anything else — and its robot books that slot, that time
(`src/booker.js`). Then:

| The robot… | The app |
|---|---|
| booked it, and the DMV showed its confirmation number | says "I booked it" with that number, and tells you. If the site will not take it (its time ran out), you are still told you have the appointment; if the site could not be reached, it says it again on every sync until it hears |
| found the slot gone | says so (`POST …/handoffs/<job>/gone`): it comes off the board, and you keep your place. Not when it took over from a device that stopped answering, which may have booked it first: the hand-off runs out its time instead, for that device's "I booked it" to arrive, and you are told to check your email |
| met a human check, ran out of time, or could not finish | opens the booking page with your details typed in, as a hand-off always has, and says why |
| submitted it and saw no confirmation | the same, saying to check your email first. It never tries that one again: the appointment may exist |

While the robot is at the form the bar says so and offers nothing to press, so a
booking by hand cannot run beside it. It has the hand-off's time less a margin
for the page, up to four minutes.

Closing the app does not stop it. The window goes and the robots that look for
openings stop, but a booking under way finishes first: the site hears how it
went, a notification says so (with the confirmation number, if it booked), and
then the app exits. Stopped part way, the robot could have sent the form and
booked the slot with nobody left to tell the site, and the turn would have run
out as missed while you had the appointment. A full reset is the exception: it
stops every robot.

**Offered to a few, a few seconds apart.** A slot is not held for one person:
the site offers it to the top few in line who would take it, the first at once
and each next a few seconds later, and the first to book it has it; the others
are told it went and keep their places. The bar says where you are in that —
"offered to 3 people, you #2 in turn" — and, once somebody else booked it,
that it went. How much a place in line is worth against speed is the site's to
set.

**Your connection.** The app pings the site (`POST /api/client/ping`) — every
second or so when you are near the front of a line, so a slot released to you
reaches the app at once, and rarely otherwise — and the site times the round
trip on its own clock (`src/pinger.js`). Every sync says how that stands among
the apps online. A connection slower than most is shown in the status line,
Settings and a notice ("slow connection"): a slower app may lose a slot to a
faster one. One slower than the site's limit, or not heard from, is offered no
slots at all until it is faster, and the app says so plainly.

**Where the robots go** is decided by the app, not by the site: the real DMV,
or a practice one on this machine when the site is on this machine too. A site
that names anywhere else gets no robot. On the real DMV nothing happens without
a yes, and there are two. **Checking lines** is looking: the Sites screen asks
once — *Check lines and earn credits* is the button — since it is automated
traffic from your own address, and Settings turns it off again. Without it the
app does not offer the site to read at all, and gives back a read handed to it
anyway. **Let the app book for me** is booking appointments in your name, on
the real DMV or a practice one, off until you tick it. The time of each yes is
kept, and a yes to booking on the real DMV given before there were two counts as
a yes to looking too. Expect the
real DMV to ask headless browsers for a human check: then the reads come back
blocked, and bookings open the page for you.

**Credits for checking.** Every sync says whether this app is checking — reader
on, robots aboard, and its person's yes (`agreed`) — and the site adds credits
to the account for every hour one of its apps is (⧗0.2 an hour unless the
site says otherwise, one app's time per account). The status line says *checking
lines, +⧗0.2/h* while it counts, and **Credits** shows the hours, what they
earned, and the weekly top-up back to ⧗35 that every account gets.

## What it does, in order

| When | What |
|---|---|
| Every few seconds (the server says how many) | `POST /api/client/sync` — positions, hand-offs, recent outcomes, and what this computer's robots can do |
| The site hands this computer a read | The scout looks, and `POST …/reads/<id>` answers it |
| You open Sites, a site, a line | `GET /api/client/sites`, `…/sites/<slug>`, `…/queues/<id>` — the same numbers the website shows |
| You join a line, bid up, withdraw | `POST …/queues/<id>/bids`, `…/bids/<id>/raise`, `…/bids/<id>/withdraw` |
| You open **Change range, time or amount…** on a line, and change any of them | `POST …/bids/<id>/quote` — what each amount worth paying would buy, and the one the site suggests (writes nothing) |
| You click **Save** | `POST …/bids/<id>/change` — the amount, and only a wider range or time, in one write; a lower amount comes back to your balance |
| A hand-off arrives | Desktop notification, a tab on the booking page (the tab of the line's last turn, when that one is over and went unused) and the bar over it with the clock and what to do; or, when you let the app book for you, the same tab under a "booking it for you" card while the robot claims it and books it (`…/claim`, then `…/booked` or `…/gone`), then the confirmation in a tab beside it |
| The tab's page loads | Your profile is typed into the form (see below) |
| You click **I booked it** | `POST …/handoffs/<job>/booked` — the worker captures your escrow |
| You click **Pass** | `POST …/handoffs/<job>/pass` — the slot cascades to the next bidder; you keep your place |
| The tab shows the booking site's confirmation number | `POST …/handoffs/<job>/booked` with it, for you |
| The clock runs out | Nothing to click: the server cascades it, and you leave the line with the share of your bid the site sets (the hand-off's `missed`) — Pass instead to keep your place. A slot your app never picked up costs nothing |
| Near the front of a line, every second or so; otherwise now and then | `POST /api/client/ping` — the site times the round trip |
| A sync's answer asks for the trace | `POST /api/client/traces` — the events after the site's mark, as many as it asked for, gzipped |
| You press **Share now** (or every six hours, once you let it) | `POST /api/client/telemetry` — the numbers on the Advanced screen |
| You click **⌕ Found a slot** | `POST /api/client/found` — the board says who gets it, and it is passed to them if not you |

The last row is the part that makes people respect each other's positions.
Finding a slot does not let you take it. The report becomes an offer like any
the scout records, the same allocation walks the same board, and the reply
says who it goes to — "passed to #1 quiet_otter — you are #3" — before the
worker's next dispatch makes that the decision.

## Your profile, and the form

**File → Profile** holds what booking forms ask for: name, date of birth,
driver licence number, Social Security number, passport number, email,
phone, address. Most of it is already saved in whatever browser this person
uses, and can be brought over rather than typed again — see *Importing from a
browser you already use*, below. It is saved in one file in the app's user-data directory,
encrypted with Electron's `safeStorage` wherever the operating system offers a
keychain (macOS Keychain, Windows DPAPI, a Linux keyring); where none exists
the file is plain and the profile screen says so, rather than pretending.

A bid placed from the app carries only what the board needs to place it —
which office, how far you will travel, which counter — and none of the above.
The server stamps such a bid `booked_by: applicant`: whatever the line's
policy, a slot allocated to it is handed to *you* to book, because a
connector arriving at the form would have nothing to type.

Which is why the profile is asked for **before** the bid, not during the
booking. A line publishes the personal fields its form will want; the app
checks them against the profile (`src/needs.js`) and, when something is
missing, the join button opens the profile screen with those fields
highlighted instead of taking the credits. Save, and it goes straight back to
the line. The same check stands between a hand-off and the booking page: when
your turn comes and the profile cannot answer the form, the app opens the
profile rather than a page it cannot fill in — with the clock running, that is
the worst possible moment to go looking for a licence number. There is a way
past it (*Open the booking page without them*), because the appointment is
yours and you can always type on the form yourself.

Only fields the profile can actually hold are required. A site is free to ask
for a fan-club membership number or an insurance member id; nothing here can
store one, so those stay something you type on the site's own form and never
block a bid. `test/needs.test.js` pins both halves, and the smoke test pins
the hand-off case end to end: a line the profile is not ready for opens the
profile screen and no booking tab at all.

When the app opens a booking page it typed you to — a hand-off's page, a
site's booking portal — and the page has loaded, `src/autofill.js` matches
the page's inputs to the profile by what each field *says it is* (its
`autocomplete` token, its label, its `aria-label`, its placeholder, and only
then its name or id), fills the empty ones, and says how many. Nothing is
matched by position, a field with text in it is left alone, and it only ever
runs on an origin the app itself sent you to — never on an arbitrary tab.
**✎ Fill form** (or `Ctrl+Shift+F`) does it on request, and does overwrite.
On a DMV-shaped booking form the details page's four fields and the
drive-test flow's licence and date-of-birth fields are all filled; the smoke
test pins the first, on a form of its own.

## Importing from a browser you already use

**File → Import from your browser** takes what another browser on this machine
has already saved and puts it where this app can use it. The tedious minute of
setting the app up is typing a profile that Chrome has held for years, and the
worst moment to be signing in to a DMV is the one where a slot is being held
for you — so both are worth moving across, and nothing else is.

| What | Where it comes from | Where it goes |
|---|---|---|
| Name, email, phone, address | The addresses the browser saved for filling forms in | Your profile |
| Date of birth, licence number | What you have typed into forms of that name before | Your profile |
| Sign-ins for a booking site | That site's cookies | This app's own browser, so the booking page opens signed in |
| Sign-ins everywhere else | The rest of the cookie jar, if you tick it | The same place — for the portals that hand you to an identity provider |

Every browser built on Chromium is read the same way — Chrome, Edge, Brave,
Vivaldi, Opera, Arc, Comet, Chromium itself, and whatever is released next
month: after the ones it knows by name, the app sweeps the same directories
for anything else laid out like a Chromium profile, so an unlisted browser
still appears (named after its own directory, and marked *found on disk*).
A browser installed twice — from the distribution and from a Snap — is two
entries, because it is two sets of data. Firefox and Safari keep theirs in a
different shape and are not read.

The app opens this screen itself on startup, before anything else, while it
is still worth opening: the profile is empty and this machine has a browser to
take one from. It is the difference between being ready to bid and finding out
you are not — a line checks it has what its form will ask for before it takes a
bid at all, and the other moment it is noticed is with a slot held and a clock
running. Import, fill the profile in by hand, or press **Skip for now**, and it
is not offered again: it stays in the File menu, marked *(recommended)* only
while it still would be.

Nothing is read until you press **Look inside** on one browser, nothing is
written until you press **Import what is ticked**, and every line of what it
found is a tick box with where it came from written under it. Where the
browser has more than one answer — two saved addresses, an email you have used
twice — the others are in a dropdown beside it. A field your profile already
holds starts unticked, so an import adds to the profile rather than
overwriting it.

The cookie store is read whole, and then sorted before you are asked
anything: each booking site regbot lists is named and counted on its own line,
and everything else is one line with a number on it — "everywhere else you are
signed in, 813 cookies across 242 sites". Both start ticked, because a sign-in
does not always stay on the site you signed in to: a portal that hands you to
an identity provider leaves half of it on a host regbot has never heard of,
there is no list of those to keep, and a jar that arrives with holes in it
means a booking page that still asks you to sign in. Untick the second line to
bring only the named sites. Reading is not copying: nothing is written until
you press the button, what you leave unticked is never written at all, and the
screen is told counts rather than values either way.

**The same again, every week** (`src/reimport.js`). The browser goes on being
where the person keeps things current, so the app remembers where each import
came from and what was taken — which browser profile, which fields, which
sites' sign-ins; never the values — and a week later asks, over the app (never
over a booking page, never while it is somebody's turn): one big button,
**Re-import data from your browser**, takes the same things from the same
browsers again. A field changed or cleared on the profile screen since is the
person's and is left alone (the profile keeps where each field came from,
encrypted with the values); a value the browser still offers is kept even if it
is not its first choice; a field another browser supplied is left to it; and a
sign-in cookie the app's own browser holds with a later expiry is the fresher
one and stays. **Not now** asks again the next day; **File → Re-import data from
…** does it any time; **Settings → Your browser** lists the browsers, forgets
one, and stops the asking. Deleting the profile forgets them all. How often it
asks is the site's to say — its admin panel's Settings, sent on every sync as
`apps` and kept for the next start — a week and a day until it says otherwise.

Passwords are never read: this app has never seen one and this is no place to
start, and a sign-in that survives as a cookie needs no password here. Payment
cards are never read; nor is a form field whose name looks like one, which is
why the rule that matches field names is a list of names rather than a guess.
History and bookmarks are not read either — this app is a browser only while a
booking page is open, and a bookmark bar it does not have is not a thing to
import into.

### What each system asks of you

The browser's own files are never opened: each database is copied aside, read,
and the copy deleted, so a browser that is running cannot be disturbed and
cannot tear the read. Getting at its cookies, though, means getting at the key
the operating system holds for it, and that is a different conversation on
each:

* **Windows** — the key is in the browser's `Local State`, wrapped by DPAPI
  for your Windows account; unwrapping it is one PowerShell call (no native
  module, and no privilege you do not already have). Chrome 127 and later wrap
  it a second time (app-bound encryption), and the app asks the browser's own
  elevation service to undo that — which works on the builds that still
  release the key to a same-user caller. Current Chrome no longer does: its
  service returns the key only to the browser's own program, so those cookies
  stay sealed and the app says so rather than half-reading them. It does not
  reach for the key by injecting into the browser or impersonating the system;
  those are what the sealing exists to stop. On a browser whose cookies are
  sealed, sign in to the booking site once in the app's own browser instead —
  it keeps that session. Details import either way.
* **macOS** — the key is a password in your login keychain, and macOS puts up
  its own permission dialog before handing it over. Refuse it and the import
  says so and carries on with the details.
* **Linux** — either a password from the desktop keyring (`secret-tool`, the
  Python bindings the desktop ships, or KDE's wallet) or, on a machine with no
  keyring at all, the fixed word Chromium falls back to. Each cookie says
  which of the two it wants, so a profile that predates the keyring is read
  beside one that does not.

## Layout of the code

| File | What it is |
|---|---|
| `src/main.js` | The main process: window, menu, which server, sign-in, sync, autofill, IPC, updates, shutdown, smoke mode |
| `src/stack.js` | Practice mode's server: where each part is (the robots with the app, the server in a lineright-server checkout), starting them in order, restarting one that falls over, and stopping them with everything they started |
| `src/shell.js` | The window's two faces: the app view full-window, or a strip over one sandboxed `WebContentsView` per tab, each knowing whether the person used it |
| `src/turntabs.js` | Which turn's tab is spare once its turn is over — for the next turn on its line, or to close — and which always stays |
| `src/menu.js` | The application menu, from plain data |
| `src/sync.js` | The client API and the polling loop, plain Node, tested with a fake fetch |
| `src/profile.js` | The person's own details, kept and (where possible) encrypted on this machine |
| `src/needs.js` | What a line asks for against what the profile holds — the check before a bid or a booking |
| `src/autofill.js` | Matching a page's fields to the profile, and the script that fills them |
| `src/import.js` | What an import takes from another browser — details for the profile, sign-ins for booking sites — and what it leaves |
| `src/reimport.js` | The weekly re-import: which browsers were imported from and what was taken, when to ask, and what doing it again changes |
| `src/chromium.js` | Where the Chromium browsers keep their data on each system, and which profiles each has |
| `src/oscrypt.js` | The key each system gives a browser (DPAPI, the macOS keychain, a Linux keyring) and what it decrypts |
| `src/sqlite.js` | Enough of the SQLite file format to read a browser's tables, write-ahead log and all |
| `src/store.js` | The one file of settings: which server (and the token it issued), which DMV, update feed, developer mode, device name — choices only, never defaults |
| `src/server-choice.js` | Which server a run talks to, and with what token: `--practice`, `--server`, Settings, `config.json` |
| `src/developer.js` | Developer mode: whether it is on and what holds it on, and which sites are made-up test sites |
| `src/robots.js` | Runs the DMV robots (`../dmq`'s scout and booking handler) for the regbot site, on the app's own binary, and decides where they may go |
| `src/reader.js` | Looking for openings when the site hands this device a read, and answering it |
| `src/booker.js` | Booking the person's own slot with the robot when the site hands it over, and what comes of it |
| `src/logbook.js` | The logs folder: the day's files, a folder per robot run, what is struck out before anything is written, and what goes after how long |
| `src/pagelog.js` | Writing down a page in a tab as it goes: its network through the DevTools protocol, clicks and changes and copies of the page from a world of its own |
| `src/pinger.js` | Pinging the site: being timed, and hearing at once that a slot was released to the person |
| `src/telemetry.js` | This app's own numbers, a minute at a time for a day: what the Advanced screen plots, and exactly what Share sends |
| `src/traces.js` | The trace the site asks for: numbered, kept on disk, sent in the size the site asks, deleted once the site has it |
| `src/tracetaps.js` | What the trace is made of: the logbook's records as they are written, and each robot run read back when it ends |
| `src/scrub.js` | What takes the person out of the trace: every profile value in every spelling, confirmation numbers, the shapes of private things, addresses' query values |
| `src/links.js` | Which addresses the app hands your browser: web pages only, Stripe's own payment page, and the sign-in approval on the site the app signs in to |
| `src/reset.js` | The files a full reset deletes, the server's folder first |
| `src/portal.js` | Prefilling a report from a calendar page's address |
| `src/updater.js` | When to check for updates, and telling the app what happened |
| `src/preload.js` | The whole of what the app page may ask the main process |
| `ui/` | The application: every screen, the browser strip, the hand-off bar, the report form. `charts.js` and `charts.css` are the site's (lineright-server's `regbot/static`), kept identical by a test when a checkout of it is beside this one |
| `config.json` | Build-time defaults: which server (lineright.org; none named: the app's own), an optional update feed |
| `host/robot-preload.cjs` | Loaded into the robots on Windows so the browser they start opens no console window |
| `bundle.lock.json` | The robots' browser an installer carries, per platform |
| `scripts/bundle.js` | Stages the robots and fetches that browser into `vendor/` (`npm run bundle`, and electron-builder's `beforePack`) |
| `test/` | `node --test`: the pure modules, plus a smoke test that launches the real app |
| `test/fixtures/` | Browser databases to read, in the shapes Chromium has used |
| `scripts/update-server.js` | A self-hosted update feed |
| `scripts/make-import-fixtures.js` | Writes those fixtures (`npm run fixtures`); nothing else needs a SQLite that can write |
| `scripts/appimage-runtime.js` | Gives the AppImage a runtime that runs on today's Linux |
| `scripts/linux-launcher.js` | Puts a launcher in front of Electron on Linux that drops Chromium's sandbox only where the system allows none |

Tabs get the strictest web preferences Electron has — sandboxed, context
isolated, no Node — in a persistent partition of their own, so a sign-in on a
booking site survives a restart. The app page has no Node access and a named
list of things it may ask for. It runs only its own scripts (a
Content-Security-Policy with no inline script), draws every number a site sends
as a number and every word as text, and never becomes another page: a link that
would navigate it opens in a tab, and a new window opens nowhere. What a site
names for the browser to open goes through `src/links.js` first — a web page,
never a file, a share or another program's link; a payment page only if it is
Stripe's.

Flags for trying one screen: `--page=console`, `--page=site:ca-dmv`,
`--page=board:20`, `--page=profile`; `--open=<url>` opens a booking page in a
tab at once.

## Tests

```bash
npm test          # 368 tests: sync, store, which server a run uses, the robots, the reader, the booker, the pinger, telemetry,
                  # the trace (what takes the person out of it — a random profile in every spelling — how it is kept,
                  # what it is made of, and a smoke run whose site asks for it), portal,
                  # updater, menu, profile, needs, autofill, what goes to the browser and the page's policy,
                  # the SQLite reader, browser discovery on all three
                  # systems, the OS key each one gives, what an import takes, the AppImage runtime swap, the Linux
                  # launcher, the server's supervision, its host run for real, what an installer carries, what a
                  # reset deletes, which turn's tab is spare, and twelve smoke runs (among them a first run that pairs
                  # by code, a read answered with the real scout, a hand-off booked by the real booking handler, a
                  # booking page written down, turns' tabs that do not pile up, a bid changed from its board, the
                  # trace asked for, and a reset through Settings)
```

The smoke test launches the real app under a virtual display (`xvfb-run` on
Linux; on Windows the session's own desktop, which a session over SSH has
too). Against a stub of a remote server and a stub of a booking site it checks
end to end that a hand-off opened its page in a tab (once), that the window is
in browser mode with the bar grown for it, that the application menu lists the
server's real sites — its made-up one only once developer mode is switched on
from the menu, marked as a test site, and gone again when it is switched off —
and that the profile on that machine was typed into the booking
form — four fields, by label, nothing already filled touched — or, for a line
the profile is not ready for, that the profile opened instead. A first run asks
for an account and pairs by code, and *Start over* asks again. A read the stub
hands out is answered by the real scout, and a hand-off it hands over is booked
by the real booking handler — both in their simulate mode, so no browser starts:
booked with no tab, a run that could not finish with the tab, a slot gone
reported gone. Turns handed out on three lines and then over show that the
next turn on a line opens in the last one's unused tab, that an unused one
closes (seconds after its turn, in a test), that one clicked in stays, and
that a booked turn's page goes while the DMV's confirmation stays. And with
`--practice` it checks that the app started its own — stand-in, site and
processor running, signed in as an account made for the person, synced, the
seeded sites listed, its data under the app's user data — and that nothing it
started was still running after it quit. It skips itself
where there is no Electron binary or no display, the robot runs where there is
no `../dmq`, and the practice runs where there is no lineright-server checkout
or no Python with Flask for it.

`test/host.test.js` runs the server's `regbot/desktop_host.py` with that same
Python, when a lineright-server checkout is there: the
account made once and found again (same token, a lost token, a revoked one),
the ways in with a ticket and not without, the port it asked for, and the
lifeline. `test/stack.test.js` drives the supervision with a fake spawn and
fake timers — order, environment, restarts and their pauses, a missing
Python, stopping a whole process tree, the stand-in moving ports, switching
to the real DMV, no server at all. `test/bundle.test.js` checks that every
platform an installer is built for has its browser pinned, that the robots get
the Playwright `../dmq` locks, and that what is staged is the robots and how
they start, and none of the server.

`npm test` is `node --test` with no path, which searches from here. Naming
the directory (`node --test test/`) is what it used to say, and Node 22 on
Windows reads that as a module to load rather than a directory to search, so
the whole suite came back as one failing test.

The import is tested against real browser databases rather than mocks
(`test/fixtures`, written by `npm run fixtures`), and the parts that differ by
system are tested on every system at once: the filesystem and the commands are
injected, so a Windows layout and a macOS keychain are exercised from whatever
machine the tests are running on.

## Installers

electron-builder makes them; `electron-builder.yml` says what.

```bash
npm run dist            # what this OS can build (Linux: AppImage + deb)
npm run dist:win        # NSIS installer      — Windows, CI, or Linux with Wine
npm run dist:mac        # dmg + zip           — needs macOS, or CI
```

Every installer carries what the app runs itself, under `resources/`:
`stack/` (the robots from `../dmq` with the Playwright they import, and
`host/`) and `browsers/` (Playwright's headless Chromium for the robots,
~210 MB unpacked, every translation but English left out). No server, no
Python and no DMV stand-in: practice mode runs a lineright-server checkout,
which never goes in an installer. `scripts/bundle.js` stages them into `vendor/`, and runs
by itself before electron-builder packs each platform and CPU (`beforePack`),
so a build needs nothing beyond `npm ci`; the browser is the one the pinned
Playwright names for each platform (`bundle.lock.json`). Any machine can fetch
any target's (`node scripts/bundle.js win-x64 mac-arm64`).

The robots run on the app's own binary as Node, which relies on Electron's
`RunAsNode` fuse staying on (it is, by default; do not flip it with
`electronFuses`). macOS signs every binary in the bundle, the robots' browser
included, with `build/entitlements.mac.plist` — the browser
compiles JavaScript at run time under the hardened runtime.

Name a server in `config.json` first only for a build that should use
somebody else's by default. electron-builder is pinned to the 25
line because 26 pulls in an ESM-only hash library that Node 18 cannot
`require()`; on Node 20.19 or later either works. macOS installers have to be
built on macOS; the Windows one builds on Linux too, with Wine installed.

The AppImage runs on distributions without `libfuse2` (Ubuntu 22.04 and
later, Fedora): after the build, `scripts/appimage-runtime.js` swaps the
runtime electron-builder embeds for the AppImage project's static one, which
mounts through FUSE 3, then regenerates the embedded block map and rewrites
`latest-linux.yml` so updates still verify. It is pinned by release tag and
digest, and refuses any file whose layout it does not recognise. To run one
without any FUSE at all: `./regbot-*.AppImage --appimage-extract-and-run`.

Ubuntu 24.04 and later let only the programs AppArmor names create user
namespaces, which is how Chromium sandboxes its pages. Its fallback, the
setuid `chrome-sandbox`, cannot work in an AppImage (the mount is `nosuid`),
and the .deb's install script leaves it unprivileged wherever root can make a
user namespace, as root can there. With neither, Chromium aborts at start:
"The SUID sandbox helper binary was found, but is not configured correctly".
So on Linux `scripts/linux-launcher.js` (`afterPack`) moves Electron to
`regbot` and makes the executable, `regbot-desktop`, a small launcher. It
starts `regbot` as is where a user namespace can be made or the helper is
setuid root, and with `--no-sandbox` otherwise, which the log then says.
electron-builder's own `--no-sandbox` is only in the menu entry it writes
into the AppImage, which running the file never reads. To keep the sandbox on
such a system, give the app an AppArmor profile that allows `userns`, as
Ubuntu does for Chrome in `/etc/apparmor.d/chrome`.

The workflow in `.github/workflows/desktop-release.yml` does all three: push
a tag such as `desktop-v0.1.1` (it must match `package.json`) and the
installers and their update manifests land on a GitHub Release. Two things to
know before pushing one:

* electron-builder publishes to the release tagged **`v<version>`**, and a tag
  it has to create goes on the default branch, not on the commit the workflow
  built. Push `v<version>` on the same commit first, then `desktop-v<version>`.
* The macOS leg needs the signing secrets below. Without `MAC_CERT_P12`,
  `CSC_LINK` arrives empty and electron-builder reads it as a certificate path
  and fails; the Windows and Linux legs publish regardless.

Releases can equally be built by hand — `npx electron-builder --linux
--publish never` here, `npm run dist:win` on Windows — and published with
`gh release create v<version>` and the files from `dist/`: the installers, their
`.blockmap`s and the `latest*.yml` manifests, which the update feed reads.

## Updates

`electron-updater`, wired in `src/updater.js`. An installed copy checks the
feed fifteen seconds after launch and every six hours, downloads in the
background, shows **Update ready — restart** in the app's bar, and installs
on quit or on that click. **Help → Check for updates** looks now.

Two feeds, one chosen at runtime:

* **GitHub Releases** — the default. The `publish` block in
  `electron-builder.yml` (owner `grandrew`, repo `lineright-client`) is embedded in
  the app at build time as `app-update.yml`, and the release workflow
  publishes there. A public repository needs no token at runtime. A feed that
  answers 404 — no release yet, or a repository that is not public — is
  reported as "no release published yet", not as a fault.
* **Self-hosted** — any static HTTP directory holding `latest.yml`,
  `latest-mac.yml`, `latest-linux.yml` and the installers they name, which is
  what `npm run dist` leaves in `dist/`. `npm run update-server releases 8788`
  serves such a directory (with the range requests the Windows differential
  download wants). Point the app at it in Settings → *Update feed*, in
  `config.json`, or with `REGBOT_UPDATE_URL` before first launch.

Two things about updates that are not this app's to fix:

* macOS refuses to install an update into an unsigned app, so the macOS feed
  only works once the workflow has signing and notarisation secrets
  (`MAC_CERT_P12`, `MAC_CERT_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`). Windows updates work unsigned, with a SmartScreen warning
  on first install.
* Updates are off in an unpackaged checkout, because there is nothing
  installed to replace. `REGBOT_FORCE_UPDATES=1` turns the checks on anyway,
  for trying a feed against `npm start` with a `dev-app-update.yml`.

## Environment

| Variable | Meaning |
|---|---|
| `REGBOT_SERVER_URL` | Another regbot server, for one run. Otherwise Settings, then `config.json`; none named is the app's own |
| `REGBOT_SERVER_MODE` | `builtin` to practise on this computer for one run (`--practice`) |
| `REGBOT_DEVELOPER` | `1` for developer mode, for one run (`--developer`) |
| `REGBOT_CLIENT_TOKEN` | A device token for the server named for the run, instead of signing in (tests use this) |
| `REGBOT_NO_EXTERNAL` | `1` to log the pages the app would open in your browser instead of opening them (tests) |
| `LINERIGHT_SERVER_DIR` | A lineright-server checkout for practice mode, instead of one beside this repository |
| `REGBOT_PYTHON` | The Python to run practice mode's server with, instead of that checkout's `regbot/.venv` |
| `REGBOT_VENDOR_DIR` | Where `scripts/bundle.js` stages (`vendor/`) |
| `REGBOT_UPDATE_URL` | A generic update feed instead of the embedded one, for one run |
| `REGBOT_CLIENT_NAME` | What this device calls itself when it signs in (default: the hostname) |
| `REGBOT_FORCE_UPDATES` | `1` to run update checks unpackaged |
| `REGBOT_TRACE` | A file to append a synchronous debugging log of the main process to, for when stdout is not to hand (nothing to do with the trace the site asks for) |
| `REGBOT_NO_GPU` | `1` to turn hardware acceleration off (smoke runs always do) |
| `REGBOT_ROBOT_SIMULATE` | `1`, in a checkout only: the robots answer in their simulate mode, with no browser and no network (tests) |
| `REGBOT_ROBOT_OUTCOME` / `REGBOT_ROBOT_DELAY_MS` | What a simulated booking ends with and how long it takes (`RQP_SIMULATE_OUTCOME`, `RQP_SIMULATE_DELAY_MS` in `../dmq`) |
| `REGBOT_PING_DELAY_MS` | In a checkout only: hold back the echo the site times by this long, to try a slow connection |
| `REGBOT_RUNTIME_CACHE` | Where `scripts/appimage-runtime.js` keeps the AppImage runtime it fetched (`~/.cache/regbot-desktop`) |
| `REGBOT_NO_NOTIFY` / `REGBOT_NO_FLASH` | `1` to skip desktop notifications / frame flashing |

Flags: `--server=<url>` uses that server for one run without saving it, and
`--practice` the app's own; `--developer` turns developer mode on for the run;
`--user-data=<dir>` keeps this run's state apart — the built-in server's
database and logs included; `--page=<screen>` and
`--open=<url>` start somewhere in particular; `--smoke --exit-after=<ms>`
prints one JSON line about what happened and exits, which is what the smoke
test reads.
