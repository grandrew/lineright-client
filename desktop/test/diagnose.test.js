'use strict';
/**
 * The AI's check of a line the robots cannot read (agent/diagnose.js): on the
 * site's grant, a bare browser and a scripted model; what it is told, what it
 * may do, and what it reports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runDiagnosis } = require('../src/agent/diagnose');
const { diagnoseTask } = require('../src/agent/prompts');
const { toolsFor } = require('../src/agent/tools');

const BASE = 'https://www.dmv.ca.gov';
const GRANT = { session_id: 41, issue_id: 3, paid_by: 'site', max_calls: 20, seconds: 300, site_name: 'California DMV',
  queue_name: 'REAL ID', offices: ['Redding'], window: ['2026-11-02', '2026-12-10'], trouble: 'Timeout waiting for "Select Location"',
  start_url: `${BASE}/portal/appointments/select-appointment-type?option=RID`, base_url: BASE,
  guide: '2. Office search: … press "Select Location".' };
const PAGE = { url: `${BASE}/portal/appointments/select-location`, title: 'Choose an office',
  text: '# Choose an office\n[4] textbox "City or ZIP"\n[5] button "Choose this office"', height: 900, viewport: 900 };

const call = (name, args = {}) => ({ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A runner whose browse robot is a pretend page, worked over the control channel as the real one is. */
function browser({ available = true } = {}) {
  const ran = [];
  return {
    ran,
    available: () => available,
    run: async (kind, envelope, { watch }) => {
      ran.push({ kind, envelope });
      const child = new EventEmitter();
      child.connected = true;
      child.send = (m) => {
        if (m.type === 'cmd') setImmediate(() => child.emit('message', { lr: 'robot', type: 'result', id: m.id, ok: true, value: m.op === 'eval' ? PAGE : {} }));
      };
      watch.attach(child);
      child.emit('message', { lr: 'robot', type: 'ready', url: envelope.start_url });
      await watch.result;
      watch.detach();
      return { kind: 'browse.result', status: 'confirmed' };
    },
  };
}

function site(steps) {
  const heard = [];
  const reports = [];
  return {
    heard, reports,
    agentChat: async (id, body) => {
      heard.push({ id, body });
      return { message: { role: 'assistant', content: null, tool_calls: steps.shift() }, charged: 0 };
    },
    agentReport: async (id, body) => { reports.push({ id, body }); return { ok: true }; },
  };
}

test('the brief: the line, the offices, the guide, what the robot said, and only looking', () => {
  const task = diagnoseTask({ grant: GRANT, result: { message: 'No slots readable', checked: [{ office: 'Redding', error: 'Timeout' }] },
    robotLog: ['OFFICE_ERROR Redding: Timeout'] });
  assert.equal(task.kind, 'diagnose');
  assert.match(task.system, /Never press Confirm/);
  assert.match(task.system, /human_check/);
  assert.match(task.user, /Offices to look at: Redding/);
  assert.match(task.user, /Select Location/);
  assert.match(task.user, /- Redding: Timeout/);
  assert.match(task.user, /OFFICE_ERROR Redding: Timeout/);
  const finish = toolsFor({ kind: 'diagnose' }).find((t) => t.function.name === 'finish').function.parameters;
  assert.deepEqual(finish.properties.outcome.enum, ['read', 'site_changed', 'human_check', 'site_down', 'no_times', 'failed']);
  assert.deepEqual(finish.required, ['outcome', 'cause', 'fix', 'summary']);
});

test('it works the booking site on the grant and reports the cause and the fix', async () => {
  const runner = browser();
  const client = site([
    [call('look_at_page')],
    [call('finish', { outcome: 'site_changed', cause: 'The button says "Choose this office" now.',
      fix: 'Look for "Choose this office" as well as "Select Location".', times_seen: 0, summary: 'Renamed button.' })],
  ]);
  const done = await runDiagnosis({ runner, client, grant: GRANT, result: { message: 'No slots readable' },
    robotLog: ['OFFICE_ERROR Redding: Timeout'] });
  assert.equal(runner.ran[0].kind, 'browse');
  assert.equal(runner.ran[0].envelope.start_url, GRANT.start_url);
  assert.ok(client.heard.every((h) => h.id === 41), 'every call on the granted session');
  assert.ok(client.heard[0].body.tools.some((t) => t.function.name === 'open_page'));
  assert.equal(done.diagnosis.outcome, 'site_changed');
  assert.match(done.diagnosis.fix, /Choose this office/);
  const [report] = client.reports;
  assert.equal(report.id, 41);
  assert.equal(report.body.stage, 'watch.check');
  assert.equal(report.body.outcome, 'checked');
  assert.equal(report.body.diagnosis.outcome, 'site_changed');
  assert.deepEqual(report.body.robot.log, ['OFFICE_ERROR Redding: Timeout']);
});

test('a model that never finishes still reports, as a failed check', async () => {
  const client = site([]);
  client.agentChat = async () => { const e = new Error('This session ran out of time; open another.'); e.status = 409; throw e; };
  const done = await runDiagnosis({ runner: browser(), client, grant: GRANT });
  assert.equal(done.diagnosis.outcome, 'failed');
  assert.match(done.diagnosis.cause, /did not finish/);
  assert.equal(client.reports[0].body.outcome, 'stopped');
});

test('it will not start on another site than the read\'s, or without robots', async () => {
  await assert.rejects(runDiagnosis({ runner: browser(), client: site([]), grant: { ...GRANT, start_url: 'https://evil.test/' } }),
    /not on https:\/\/www.dmv.ca.gov/);
  await assert.rejects(runDiagnosis({ runner: browser({ available: false }), client: site([]), grant: GRANT }), /no robots/);
});
