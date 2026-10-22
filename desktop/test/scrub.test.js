'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Scrubber, shape, luhn } = require('../src/scrub');

const PROFILE = {
  first_name: 'Ada', middle_name: 'King', last_name: 'Lovelace', full_name: 'Ada King Lovelace',
  dob: '12/10/1985', ssn: '123-45-6789', dl_number: 'X1234567', passport: 'P9876543', email: 'ada.lovelace@example.com',
  phone: '(408) 555-0123', street: '12 Analytical Engine Way', city: 'Santa Clara', state: 'CA', zip: '95050',
};

const scrubber = () => {
  const s = new Scrubber({ home: '/home/ada', user: 'adalove' });
  s.setProfile(PROFILE);
  return s;
};

test('every detail the profile holds is taken out, in every spelling a page or an address uses', () => {
  const s = scrubber();
  const cases = [
    ['Booking for Ada King Lovelace', 'Booking for [name]'],
    ['ADA LOVELACE / ada lovelace', '[first_name] [last_name] / [first_name] [last_name]'],
    ['Ada%20King%20Lovelace and Ada+King+Lovelace', '[name] and [name]'],
    ['O&#39;Lovelace, Lovelace’s', 'O&#39;[last_name], [last_name]’s'],
    ['born 12/10/1985, 1985-12-10, 12-10-85, 12101985, 12%2F10%2F1985', 'born [dob], [dob], [dob], [dob], [dob]'],
    ['December 10, 1985 or Dec. 10 1985', '[dob] or [dob]'],
    ['call 408-555-0123, (408) 555 0123, +1 408 555 0123, 4085550123, %28408%29%20555-0123', 'call [phone], [phone], [phone], [phone], [phone]'],
    ['call%204085550123 or name%3AAda%20Lovelace%2C%20born%2012%2F10%2F1985', 'call%20[phone] or name%3A[first_name]%20[last_name]%2C%20born%20[dob]'],
    ['ssn 123-45-6789 or 123456789', 'ssn [ssn] or [ssn]'],
    ['licence X1234567, x1234567, X 123 4567', 'licence [dl_number], [dl_number], [dl_number]'],
    ['passport P9876543', 'passport [passport]'],
    ['ada.lovelace@example.com, ADA.LOVELACE%40EXAMPLE.COM, user ada.lovelace', '[email], [email], user [email_name]'],
    ['at 12 Analytical Engine Way, Santa Clara 95050-1234', 'at [street], Santa Clara [zip]'],
  ];
  for (const [input, want] of cases) assert.equal(s.text(input), want, input);
});

test('a city and a state stay: an office is named after its city', () => {
  const s = scrubber();
  assert.equal(s.text('Santa Clara: passed to #1'), 'Santa Clara: passed to #1');
  assert.equal(s.text('CA DMV'), 'CA DMV');
});

test('a word that only contains a name is left alone; numbers that are not the person\'s stay', () => {
  const s = new Scrubber({ home: '', user: '' });
  s.setProfile({ first_name: 'Ann', last_name: 'Gray', zip: '95050', phone: '4085550123' });
  assert.equal(s.text('Annual review at Grayson; Ann Gray'), 'Annual review at Grayson; [first_name] [last_name]');
  assert.equal(s.text('ts 1760000000000 offices 9505012 zip 95050'), 'ts 1760000000000 offices 9505012 zip [zip]');
});

test('the shapes of private things are taken out even when the profile does not hold them', () => {
  const s = new Scrubber({ home: '', user: '' });
  assert.equal(s.text('mail someone@else.org or other%40x.co'), 'mail [email] or [email]');
  assert.equal(s.text('call (650) 555-0199 or 650.555.0199'), 'call [phone] or [phone]');
  assert.equal(s.text('ssn 987-65-4321'), 'ssn [ssn]');
  assert.equal(s.text('card 4111 1111 1111 1111 and 4111111111111111'), 'card [card] and [card]');
  assert.equal(s.text('not a card 1234 5678 9012 3456'), 'not a card 1234 5678 9012 3456');
  assert.equal(s.text('licence B7654321'), 'licence [dl]');
  assert.equal(s.text('auth Bearer abcdefghijklmnop and eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK'), 'auth Bearer [token] and [token]');
  assert.equal(s.text('2026-11-03 at 09:40, 3 offices, rank #12, 1760000000'), '2026-11-03 at 09:40, 3 offices, rank #12, 1760000000');
  assert.ok(luhn('4111111111111111'));
});

test('this computer\'s home folder and account name are not said', () => {
  const s = scrubber();
  assert.equal(s.text('Error at /home/ada/.config/regbot/app.js:12 (adalove)'), 'Error at ~/.config/regbot/app.js:12 ([user])');
});

test('an address keeps its host and path, its query keys, and only the values that are plainly no one\'s', () => {
  const s = scrubber();
  assert.equal(
    s.url('https://www.dmv.ca.gov/portal/appointments/select-location?firstName=Ada&zip=95050&date=2026-11-03&branch=632&ver=eb980f462d1edb3d2f7a161ce338cc5f&q=near%20me&mode=fast'),
    'https://www.dmv.ca.gov/portal/appointments/select-location?firstName=[redacted]&zip=[redacted]&date=2026-11-03&branch=632&ver=:id&q=[redacted]&mode=fast');
  assert.equal(s.url('https://dmv.example/api/applicant/ada.lovelace%40example.com/confirm/AB12CD34EF56GH78IJ'),
    'https://dmv.example/api/applicant/[email]/confirm/:id');
  assert.equal(s.url('https://dmv.example/a?note=Hello%20there%20friend&x=1'), 'https://dmv.example/a?note=[redacted]&x=1');
  assert.equal(s.url('https://dmv.example/a?free=two%20words'), 'https://dmv.example/a?free=[9-chars]');
  assert.equal(s.url('https://user:secret@dmv.example/a#token=abc&step=2'), 'https://dmv.example/a#token=[redacted]&step=2');
  assert.equal(s.url('data:image/png;base64,AAAA'), 'data:image/png,…');
  assert.equal(s.url('https://cdn.example/assets/frontend-content-slider-styles.css'), 'https://cdn.example/assets/frontend-content-slider-styles.css');
  assert.equal(s.url('not a url, from Ada'), 'not a url, from [first_name]');
});

test('scrubbing twice changes nothing more: a trace is scrubbed as it is written and again as it is sent', () => {
  const s = scrubber();
  const inputs = [
    'https://dmv.example/a?free=two%20words&firstName=Ada&date=2026-11-03',
    'Booking for Ada King Lovelace at 12 Analytical Engine Way, 408-555-0123',
    'https://dmv.example/api/applicant/ada.lovelace%40example.com/confirm/AB12CD34EF56GH78IJ',
  ];
  for (const input of inputs) {
    const once = s.url(input);
    assert.equal(s.url(once), once, input);
    const text = s.text(input);
    assert.equal(s.text(text), text, input);
  }
});

test('a whole event is scrubbed all the way down: addresses as addresses, secrets struck, numbers kept', () => {
  const s = scrubber();
  const out = s.value({
    url: 'https://x.test/?email=a@b.co&page=2', text: 'Hi Ada', ms: 12.5, ok: true, nothing: null,
    nested: { password: 'hunter2', list: ['Lovelace', 3, { href: 'https://x.test/p?q=Ada' }] },
    deep: { a: { b: { c: { d: 'too deep' } } } },
  });
  assert.deepEqual(out, {
    url: 'https://x.test/?email=[redacted]&page=2', text: 'Hi [first_name]', ms: 12.5, ok: true, nothing: null,
    nested: { password: '[redacted]', list: ['[last_name]', 3, { href: 'https://x.test/p?q=[redacted]' }] },
    deep: { a: { b: { c: '[…]' } } },
  });
  assert.equal(s.value('x'.repeat(5000)).length, 501, 'free text is cut short');
});

test('a value learnt along the way — a confirmation number — is taken out from then on', () => {
  const s = scrubber();
  assert.equal(s.text('confirmation TS-9F3K2'), 'confirmation TS-9F3K2');
  s.learn('confirmation', 'TS-9F3K2');
  assert.equal(s.text('confirmation TS-9F3K2 (ts-9f3k2)'), 'confirmation [confirmation] ([confirmation])');
  s.setProfile({});
  assert.equal(s.text('TS-9F3K2 for Ada'), '[confirmation] for Ada', 'a new profile does not forget it, and the old profile is gone');
});

test('what somebody typed is said only as its length and its shape', () => {
  assert.deepEqual(shape('Ada Lovelace'), { len: 12, kind: 'words' });
  assert.deepEqual(shape('95050'), { len: 5, kind: 'digits' });
  assert.deepEqual(shape('a@b.co'), { len: 6, kind: 'email' });
  assert.deepEqual(shape('(408) 555'), { len: 9, kind: 'number' });
  assert.deepEqual(shape('X1234567'), { len: 8, kind: 'mixed' });
  assert.deepEqual(shape(''), { len: 0 });
});

// A profile made up at random, each value put where a page, an address, a form
// body or a log line would carry it, in each spelling: none of it may come out.
test('no detail of a random profile survives, wherever it is put and however it is spelt', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const letters = (n) => Array.from({ length: n }, () => pick('abcdefghijklmnopqrstuvwxyz')).join('');
  const digits = (n) => Array.from({ length: n }, () => pick('0123456789')).join('');
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  for (let round = 0; round < 60; round += 1) {
    const first = cap(letters(3 + Math.floor(rand() * 6)));
    const last = cap(letters(4 + Math.floor(rand() * 8)));
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const year = 1940 + Math.floor(rand() * 60);
    const phone = `${2 + Math.floor(rand() * 7)}${digits(9)}`;
    const p = {
      first_name: first, last_name: last, full_name: `${first} ${last}`,
      dob: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
      ssn: `${digits(3)}-${digits(2)}-${digits(4)}`, dl_number: `${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ')}${digits(7)}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@${letters(6)}.com`, phone,
      street: `${1 + Math.floor(rand() * 9999)} ${cap(letters(7))} Street`,
    };
    const s = new Scrubber({ home: '', user: '' });
    s.setProfile(p);
    const spellings = (v) => [v, v.toUpperCase(), v.toLowerCase(), encodeURIComponent(v), encodeURIComponent(v).replace(/%20/g, '+')];
    const phoneSpellings = [phone, `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`, `${phone.slice(0, 3)}.${phone.slice(3, 6)}.${phone.slice(6)}`, `+1 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`];
    const dobSpellings = [p.dob, `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, `${month}/${day}/${year}`, encodeURIComponent(p.dob)];
    const values = [...['first_name', 'last_name', 'full_name', 'email', 'street', 'dl_number', 'ssn'].flatMap((k) => spellings(p[k])),
      ...phoneSpellings, ...dobSpellings];
    for (const v of values) {
      const places = [
        `Name: ${v}.`, `https://dmv.example/x/${encodeURIComponent(v)}/y?z=1`, `https://dmv.example/x?a=${encodeURIComponent(v)}`,
        `{"value":"${v}"}`, `<td>${v}</td>`, `first=${v}&b=2`,
      ];
      for (const place of places) {
        const out = `${s.text(place)} ${s.url(place)}`;
        for (const raw of [p.first_name, p.last_name, p.email, p.dl_number, p.street, phone, p.ssn.replace(/-/g, '')]) {
          assert.ok(!out.toLowerCase().includes(raw.toLowerCase()), `${raw} came out of ${place} as ${out}`);
        }
        assert.ok(!out.replace(/\D/g, ' ').split(' ').includes(phone), `the phone came out of ${place}`);
      }
    }
  }
});
