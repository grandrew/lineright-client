/**
 * The DMV stand-in, as the desktop app's practice mode runs it.
 *
 * Practice mode runs this server from a checkout of this repository, and the
 * stand-in beside it: the app's robots practise on it and its hand-offs open
 * its pages, so the whole California DMV line works end to end on one machine
 * without a single request reaching dmv.ca.gov. This is `node server.js` with
 * what an application needs added: a port that falls back to any free one,
 * one line announcing where it is, and an exit when the app lets go of stdin.
 *
 *     node standin.mjs [--port=N]
 *
 * The app runs it through its own executable as Node (ELECTRON_RUN_AS_NODE),
 * so nothing needs Node installed; the site's long-run CI runs it the same way. The
 * stand-in's own knobs — TESTSITE_GATE, TESTSITE_CANCEL_MS and the rest in
 * its README — pass through the environment unchanged.
 */
import { createServer, createState, startWorld } from './server.js';
import { DEMO_ACCOUNT } from './world.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/);
  return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
}));

// A person is going to look at this one, so it answers at the speed a
// website answers, as server.js does when run by hand. And it serves every
// office, not the dozen a test needs: this is a run against the demand the
// server seeds, which names offices all over the state, and a robot sent to
// an office the stand-in does not have fails before it reaches a calendar
// (see TESTSITE_OFFICES in its README).
const state = createState({
  apiDelayMs: Number(process.env.TESTSITE_API_DELAY_MS ?? 220),
  officeCount: Number(process.env.TESTSITE_OFFICES ?? 0),
});
const server = createServer(state);

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port) return listen(0);
    console.error(`stand-in: ${err.message}`);
    return process.exit(1);
  });
  server.listen(port, '127.0.0.1');
}

server.once('listening', () => {
  const { port } = server.address();
  startWorld(state);
  console.error(`DMV stand-in on http://127.0.0.1:${port}  gate=${state.gate}  MyDMV ${DEMO_ACCOUNT.email} / ${DEMO_ACCOUNT.password}`);
  process.stdout.write(`REGBOT-READY ${JSON.stringify({ service: 'standin', pid: process.pid, port, gate: state.gate })}\n`);
});

// The lifeline: the app holds stdin open for as long as it wants this running.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();

listen(Number(args.port) || 0);
