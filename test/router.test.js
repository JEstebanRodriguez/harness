import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLane, validateClassification } from '../src/router.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { SMALL } from './helpers.js';

const t = DEFAULT_CONFIG.router;
const lane = (over) => decideLane({ ...SMALL, ...over }, t).lane;

test('tiny, clear change goes to ODD', () => {
  assert.equal(lane({}), 'odd');
});

test('scoped change whose design must be discovered goes to ODD', () => {
  assert.equal(lane({ files_estimate: 4, design_certainty: 'unknown' }), 'odd');
});

test('medium change with known requirements goes to RDD', () => {
  assert.equal(lane({ files_estimate: 5, design_certainty: 'some_options' }), 'rdd');
  assert.equal(lane({ files_estimate: 3, requirements_clarity: 'partial' }), 'rdd');
});

test('unclear requirements go to RDD even when small', () => {
  assert.equal(lane({ files_estimate: 1, requirements_clarity: 'unclear' }), 'rdd');
});

test('any hard risk signal forces SDD regardless of size', () => {
  assert.equal(lane({ touches_contract: true }), 'sdd');
  assert.equal(lane({ sensitive_area: true }), 'sdd');
  assert.equal(lane({ multi_repo: true }), 'sdd');
});

test('large or broadly uncertain change goes to SDD', () => {
  assert.equal(lane({ files_estimate: 9 }), 'sdd');
  assert.equal(lane({ files_estimate: 7, design_certainty: 'unknown' }), 'sdd');
});

test('thresholds come from config', () => {
  const custom = { ...t, oddMaxFiles: 5 };
  assert.equal(decideLane({ ...SMALL, files_estimate: 5 }, custom).lane, 'odd');
});

test('every decision explains itself', () => {
  const { reasons } = decideLane({ ...SMALL, touches_contract: true, sensitive_area: true }, t);
  assert.equal(reasons.length, 2);
});

test('validation rejects malformed classifications', () => {
  assert.equal(validateClassification(SMALL).ok, true);
  const bad = validateClassification({ ...SMALL, files_estimate: -1, requirements_clarity: 'meh', summary: '' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors.length, 3);
  assert.equal(validateClassification([]).ok, false);
});
