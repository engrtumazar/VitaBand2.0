const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePhoneLocation } = require('../backend/phone-location');

const now = Date.parse('2026-10-19T10:00:00.000Z');

function location(overrides = {}) {
  return {
    latitude: 14.5995,
    longitude: 120.9842,
    accuracyM: 12,
    capturedAt: now - 1000,
    ...overrides
  };
}

test('normalizes a valid phone location', () => {
  assert.deepEqual(validatePhoneLocation(location(), now), {
    latitude: 14.5995,
    longitude: 120.9842,
    accuracyM: 12,
    capturedAt: '2026-10-19T09:59:59.000Z'
  });
});

test('rejects invalid coordinates, accuracy, and unknown fields', () => {
  assert.throws(() => validatePhoneLocation(location({ latitude: 91 }), now), /coordinates/);
  assert.throws(() => validatePhoneLocation(location({ accuracyM: -1 }), now), /accuracyM/);
  assert.throws(() => validatePhoneLocation(location({ source: 'phone' }), now), /Unsupported phone location field/);
});

test('rejects phone timestamps outside the allowed window', () => {
  assert.throws(() => validatePhoneLocation(location({ capturedAt: now + 31000 }), now), /within 5 minutes/);
  assert.throws(() => validatePhoneLocation(location({ capturedAt: now - 300001 }), now), /within 5 minutes/);
});
