# Reporting a security problem

Please do not open a public issue for a security problem in the app or the
robots. Report it privately instead, through this repository's **Security** tab
→ **Report a vulnerability**, and say what you found and how to reproduce it.
You will get an answer there, and a fix will be released before the details are
made public.

The app keeps a person's details on their own computer, encrypted where the
operating system allows (`desktop/src/profile.js`), brings sign-ins across from
their browser only when they tick them (`desktop/src/import.js`), and talks to
the LineRight Regbot site with one device token. Anything that would let a web
page, a booking site or another program read those, act as that device, or get
the robots to book without the person's say-so is exactly what we want to hear
about.

Problems with the site itself, lineright.org, go the same way.
