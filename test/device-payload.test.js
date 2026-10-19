const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDevicePayload } = require('../backend/device-payload');

const now = Date.parse('2026-10-13T00:00:00.000Z');

function payload(overrides = {}) {
  return {
    deviceId: 'VB-01',
    heartRateBpm: 72,
    movementStatus: 'stationary',
    gps: { status: 'no_fix' },
    loraStatus: 'receiving',
    updatedAt: '2026-10-12T23:59:59.000Z',
    ...overrides
  };
}

test('normalizes a valid reading using the existing VB-01 schema', () => {
  const result = validateDevicePayload(payload(), now);
  assert.equal(result.deviceId, 'VB-01');
  assert.equal(result.updatedAt, '2026-10-12T23:59:59.000Z');
  assert.deepEqual(result.gps, { status: 'no_fix' });
});

test('accepts a boolean SOS button event and rejects non-boolean values', () => {
  assert.equal(validateDevicePayload(payload({ sosPressed: true }), now).sosPressed, true);
  assert.equal(validateDevicePayload(payload({ sosPressed: false }), now).sosPressed, undefined);
  assert.throws(() => validateDevicePayload(payload({ sosPressed: 'true' }), now), /sosPressed/);
});

test('rejects unsupported devices, fields, and measurement ranges', () => {
  assert.throws(() => validateDevicePayload(payload({ deviceId: 'VB-02' }), now), /deviceId/);
  assert.throws(() => validateDevicePayload(payload({ heartRateBpm: 221 }), now), /heartRateBpm/);
  assert.throws(() => validateDevicePayload(payload({ sample: true }), now), /Unsupported payload field/);
});

test('requires valid coordinates for a GPS fix', () => {
  assert.throws(() => validateDevicePayload(payload({ gps: { status: 'fix' } }), now), /requires latitude/);
  assert.throws(() => validateDevicePayload(payload({
    gps: { status: 'fix', latitude: 91, longitude: 0 }
  }), now), /coordinate/);
});

test('rejects missing, invalid, and future timestamps', () => {
  assert.throws(() => validateDevicePayload(payload({ updatedAt: 'not-a-date' }), now), /ISO 8601/);
  assert.throws(() => validateDevicePayload(payload({ updatedAt: '2026-10-14T00:00:00.000Z' }), now), /future/);
});