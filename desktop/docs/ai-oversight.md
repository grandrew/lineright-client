# AI booking oversight

The app books your slot with its robot: a browser of its own, out of sight,
that follows the DMV's pages the way they were when the robot was written. A
booking site changes now and then — a button renamed, a label reworded, a
confirmation laid out anew — and a robot that looks for the old words stops.
Without oversight the app then opens the page for you to finish by hand, if you
are there to see it in time.

**AI booking oversight** is a senior pair of eyes on that robot. The app keeps
a channel open to the robot as it books and hears each step it takes. When the
robot is stuck it asks, before it gives up, whether the app takes over. If you
have oversight on and have bought credits, the app does:

1. it opens a session on the LineRight Regbot site (the site's `agent.py`);
2. it takes the robot's browser as it is — mid-booking, the time already held;
3. an AI (a language model, DeepSeek's `deepseek-flash`, asked through the
   site) reads the page as text and works it: presses, types, chooses,
   until the booking is made, the slot is found gone, or it needs you;
4. the robot ends with what the AI made of it, as if it had done it itself —
   a booking the AI says it made is believed only with its confirmation number
   on the page in front of it;
5. the app tells the site what happened: where the robot was stuck and why,
   each step the AI took, and how it ended — the telemetry of an intervention,
   so the robot gets fixed before the next person's booking fails the same way.

## When it steps in

| The robot was | What the AI does | What it may do |
|---|---|---|
| **stuck before the booking went** — a button or a field it could not find, a page that did not load as it expected, no "Confirm" after choosing the time | finishes the booking from where the robot stopped | everything a person could on that site |
| **about to call the slot gone because the page showed nothing to choose at all** — no open day on the calendar, no time on the day | looks again; books it if it is there, says gone if not | everything |
| **done sending, with no confirmation number seen** | reads the page for the confirmation | only look: nothing is pressed once a booking was sent |

Never for a human check (a captcha): that is yours, and the page opens for you
as it always has. Never more than once in one booking, and only with at least
30 seconds of the booking's time left.

## What it may and may not do

- It books exactly the office, day and time the site gave you, never another.
- It presses the button that finally books at most once. A booking that may
  have been sent and shows no confirmation is reported **unconfirmed** — check
  your email before booking again — never retried.
- It never cancels, reschedules, signs in, pays, or leaves the booking site
  (the robot refuses an address on another site, whatever asks).
- It has the time the robot has left (at most four minutes a booking) and at
  most 30 steps.

## Your details

None of your details go to the AI, nor to the LineRight Regbot site. The page
is read with you taken out of it — your name becomes `[first_name]`, your phone
`[phone]`, the same rules the trace uses (`src/scrub.js`). When the AI types one
of your details into the form it writes the placeholder, `[first_name]`, and
the app puts the real value in, on your computer, just before it goes into the
form — and only the details that line's booking form needs (the hand-off's
`robot.requires`), whatever the AI asks for. The site checks every call again
for an email, a Social Security or card number, your account's email, and
strikes out what it finds (and counts it: a miss to fix here).

## What it costs

It runs on **bought credits** only: an account that has never bought credits
does not have it, and it spends no more than you bought — the free weekly
credits and those earned checking lines never pay for it, because the model is
the one thing that costs LineRight Regbot money each time it is used.

A step — one look at the page and one action — costs about **2 credits** at the
site's prices now (the site says the exact figure; Settings shows it), and one
booking at most **⧗150**. A session charges whole credits as it goes, rounded
up, as one line in your credit history ("AI oversight"). Most bookings never
need it, and cost nothing for it.

## Turning it on and off

**Settings → AI booking oversight → Let an AI finish a booking the robot gets
stuck on.** On by default once the site offers it to your account — that is,
once you have bought credits; the app says so once, when it first becomes
available. The panel says what a step costs, what it may spend now, and what
it did the last time. Off, a booking the robot gets stuck on opens for you to
finish, as before.

While it works, the booking's tab says so, with the steps and credits so far,
and the status line reads *AI finishing the booking of …*. A booking it finished
says so when it is done.

## A site described in plain words (developer mode)

The DMV has a robot that knows its pages, and the AI is only its overseer. For
a site nobody has written a robot for, the beginning of another way: describe
the site in plain words — where booking starts, what its pages ask, what it
says when it is done — and the AI works a browser of its own on it, to **check
what is open** (nothing is held or booked) or to **book** with your name, email
and phone. In developer mode, **Help → Advanced → Try the AI on a site**. It is
charged the same way, and the site keeps the report.

The site's own description of the DMV's pages (its `agent_guide`) is what the
overseer reads too: the same plain words are how a new site would be added.

## A line the robots cannot read: the site's AI check

The site has every app look at its lines now and then (lineright-server's
`linewatch.py`). When a look reads none of its offices, the site asks another
app to look again (a *check* read). If that app's robot fails too and the app
said it can run the AI (`ai` in what its reader says on every sync — only while
AI booking oversight is on), the site's answer carries a **grant**: an AI
session the site opened itself and pays for, bound to this app and that trouble.

The app (`src/reader.js` `check`, `src/agent/diagnose.js`) then opens a bare
browser on the booking site's start page (dmq's `rqp-browser.js`, which never
leaves that site) and the AI goes through the pages as a person would — the
site's guide to them, what the robots said, the scout's last log lines (the
runner keeps them: `robots.tail('scout')`) — up to the list of times for one of
the offices, never further. It may not press anything that holds or books a
time, and there is no detail of anyone's to type. It finishes with one of
`read`, `site_changed`, `human_check`, `site_down`, `no_times` or `failed`, the
**cause**, and the **fix** for the robot, and the app sends that as the
session's report (`stage: 'watch.check'`, `diagnosis`).

The grant is a session row on the site, not a token the app could pass on: only
this device may use it; it lapses unless its first call comes within a minute
and each later one within a minute of the last; it ends after 20 calls or five
minutes; nobody's credits are charged. The site grants at most three a day to
one app and a dozen in all, within a daily dollar budget. While the AI checks,
the app takes no new read; a booking hand-off is not held up by it. With
oversight off the app does not say it can, so it is never handed a check.

## How it is built

```
robot process (dmq)                     the app (desktop)                         the site (lineright-server)
  bin/rqp-handler.js                      src/robots.js   spawns it, with 'ipc'
    src/bot.js  ── step ──────────────▶   src/overseer.js  Watch: hears steps
                ── trouble ───────────▶                    decides; opens a session ──▶ POST /api/client/agent/sessions
                ◀── take / decline ─────                   src/agent/loop.js
    src/control.js serve(page)                               ask the model ──────────▶ …/sessions/<id>/chat ──▶ DeepSeek
                ◀── cmd (eval/click/…) ──    src/agent/tools.js + drivers.js          (metered, charged)
                ── result ─────────────▶     src/agent/pagekit.js (page as text)
                ◀── done {outcome} ─────
  answers booking.result (overseen)       report ────────────────────────────────▶ …/sessions/<id>/report
```

| File | What it is |
|---|---|
| `src/overseer.js` | When to step in, the session, the AI's run, what the robot is told, the report |
| `src/agent/pagekit.js` | Reading a page as short text with every control numbered (`data-lr-ref`) |
| `src/agent/drivers.js` | The same few actions on the robot's browser (over its channel) or on a tab of the app |
| `src/agent/tools.js` | The tools the model is given, and doing them; the placeholders put back |
| `src/agent/loop.js` | Ask, act, tell, until finished or out of time, steps or credits; older page readings left out of what is sent |
| `src/agent/prompts.js` | What the model is told, for each moment, and for a site described in words |
| `src/agent/sitetask.js` | A site described in plain words, and the AI alone on it (developer mode) |
| `src/agent/diagnose.js` | The site's AI check of a line the robots cannot read, on its grant |
| `../dmq/src/control.js` | The robot's side: steps, the ask, and serving the page to the overseer |
| `../dmq/bin/rqp-browser.js` | A browser with no robot's script in it, for a site task |

## Trying it

```bash
npm test                                         # tools, loop, overseer, page reading; and, with lineright-server
                                                 # beside this checkout, the robot on a stand-in that changed under it
node scripts/oversight-live.js --model=standin   # the whole chain with a private site and a stand-in model
node scripts/oversight-live.js                   # the same with DeepSeek (DEEPSEEK_API_KEY in the environment)
node scripts/oversight-live.js --drift=offices,labels,confirmation
node scripts/oversight-live.js --case=task       # the AI alone checks a calendar it is told about in words
node scripts/watch-live.js                       # watching lines: a private site, two apps, a stand-in whose office
                                                 # button was renamed; the check read, the grant, the AI's diagnosis
node scripts/watch-live.js --model=deepseek      # the same with DeepSeek (DEEPSEEK_API_KEY in the environment)
```

The DMV stand-in (`simulators/ca-dmv/`) changes under the robot on
request — `{"drift": "labels"}` to `/__admin/config`, or `TESTSITE_DRIFT` —
renaming the buttons and labels the robot looks for, the office button, or
how the confirmation is laid out.
