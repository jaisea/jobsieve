/**
 * A gate's vocabulary and a person's are answering different questions.
 *
 * `REJECT_CATEGORIES` is shared by both so the two can never drift, and that
 * sharing hid a mismatch. A gate says "I dropped this because of X". A person
 * says "I do not want this because of Y" — and only some of Y is mechanical.
 * `role` was carrying both, so `advert` gives "I read it and did not want it"
 * somewhere honest to go, and the picker is six buttons over the gates.
 *
 * (The `stats` audit that counted judgement apart from a missed gate has been
 * removed; the stored reasons and the picker are what remain.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REJECT_CATEGORIES, PICKER_GROUPS } from '../src/filter.js';

test('there is a category for "I read it and did not want it"', () => {
  // Without one, that answer has to go somewhere, and it went into `role`.
  assert.ok(REJECT_CATEGORIES.advert, 'the picker needs an honest option for taste');
  assert.match(REJECT_CATEGORIES.advert, /read it/i);
});

test('the picker asks what you know, not which detector to blame', () => {
  const keys = PICKER_GROUPS.map((g) => g.key);
  assert.deepEqual(keys,
    ['language', 'location', 'skills', 'role', 'closed', 'notImpressed'],
    'six buttons, in this order');

  const gatesOf = (k) => PICKER_GROUPS.find((g) => g.key === k).gates;

  // Part-time and 639km-away are different gates and stay different gates, but
  // from where you are sitting they are one question: does the shape of this
  // job work at all.
  assert.deepEqual(gatesOf('location'), ['location', 'employment']);
  assert.deepEqual(gatesOf('skills'), ['programming', 'aws', 'stack']);
  assert.deepEqual(gatesOf('notImpressed'), ['advert', 'other']);
});
