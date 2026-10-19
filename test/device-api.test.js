const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VITABAND_DEVICE_TOKEN = 'test-device-token-not-a-real-secret';
const server = require('../backend/server');
let baseUrl;

test.before(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('publishes only non-secret device configuration', async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deviceId: 'VB-01', deviceStaleAfterMs: 120000 });
});

test('rejects missing or incorrect device bearer tokens', async () => {
  for (const authorization of [undefined, 'Bearer wrong-token']) {
    const response = await fetch(`${baseUrl}/api/device/readings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {})
      },
      body: '{}'
    });
    assert.equal(response.status, 401);
  }
});

test('protects base-station phone-location reads with the device bearer token', async () => {
  const response = await fetch(`${baseUrl}/api/device/phone-location`, {
    headers: { Authorization: 'Bearer incorrect-device-token' }
  });
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /device bearer token/);
});

test('rejects phone location sharing requests without an allowed origin', async () => {
  for (const method of ['POST', 'DELETE']) {
    const response = await fetch(`${baseUrl}/api/device/phone-location`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({
        latitude: 14.5995,
        longitude: 120.9842,
        accuracyM: 10,
        capturedAt: Date.now()
      }) : undefined
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /origin is not allowed/);
  }
});

test('rejects malformed readings before accessing Firebase', async () => {
  const response = await fetch(`${baseUrl}/api/device/readings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VITABAND_DEVICE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ deviceId: 'VB-01', heartRateBpm: 'invalid' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /heartRateBpm/);
});

test('returns an explicit unavailable response when ingestion is not configured', async () => {
  const token = process.env.VITABAND_DEVICE_TOKEN;
  delete process.env.VITABAND_DEVICE_TOKEN;
  try {
    const response = await fetch(`${baseUrl}/api/device/readings`, { method: 'POST' });
    assert.equal(response.status, 503);
  } finally {
    process.env.VITABAND_DEVICE_TOKEN = token;
  }
});

test('keeps the server alive and reports missing Firebase Admin credentials', async () => {
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    const statusResponse = await fetch(`${baseUrl}/api/operator/status`, {
      headers: { Authorization: 'Bearer test-id-token' }
    });
    assert.equal(statusResponse.status, 503);

    const configResponse = await fetch(`${baseUrl}/api/config`);
    assert.equal(configResponse.status, 200);
  } finally {
    if (credentialPath === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
  }
});