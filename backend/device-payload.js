const deviceId = 'VB-01';
const validMovementStatuses = new Set(['stationary', 'moving', 'unknown']);
const validGpsStatuses = new Set(['fix', 'no_fix']);
const validLoraStatuses = new Set(['receiving', 'disconnected']);
const allowedPayloadFields = new Set([
  'deviceId',
  'heartRateBpm',
  'movementStatus',
  'gps',
  'loraStatus',
  'updatedAt'
]);

function normalizeTimestamp(value, now = Date.now()) {
  if (typeof value === 'string' &&
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error('updatedAt must be an ISO 8601 timestamp with a timezone.');
  }
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) {
    throw new Error('updatedAt must be an ISO 8601 string or integer Unix timestamp in milliseconds.');
  }

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('updatedAt must be a valid timestamp.');
  }
  if (timestamp.getTime() > now + 30000) {
    throw new Error('updatedAt cannot be more than 30 seconds in the future.');
  }
  return timestamp.toISOString();
}

function validateDevicePayload(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object.');
  }
  const unknownFields = Object.keys(payload).filter(field => !allowedPayloadFields.has(field));
  if (unknownFields.length) {
    throw new Error(`Unsupported payload field: ${unknownFields[0]}.`);
  }
  if (payload.deviceId !== deviceId) {
    throw new Error(`deviceId must be ${deviceId}.`);
  }
  if (!Number.isInteger(payload.heartRateBpm) ||
      payload.heartRateBpm < 30 || payload.heartRateBpm > 220) {
    throw new Error('heartRateBpm must be an integer from 30 to 220.');
  }
  if (!validMovementStatuses.has(payload.movementStatus)) {
    throw new Error('movementStatus must be stationary, moving, or unknown.');
  }
  if (!payload.gps || typeof payload.gps !== 'object' || Array.isArray(payload.gps)) {
    throw new Error('gps must be an object.');
  }
  const unknownGpsFields = Object.keys(payload.gps).filter(field =>
    !['status', 'latitude', 'longitude'].includes(field)
  );
  if (unknownGpsFields.length) {
    throw new Error(`Unsupported GPS field: ${unknownGpsFields[0]}.`);
  }
  if (!validGpsStatuses.has(payload.gps.status)) {
    throw new Error('gps.status must be fix or no_fix.');
  }
  const hasLatitude = Object.hasOwn(payload.gps, 'latitude');
  const hasLongitude = Object.hasOwn(payload.gps, 'longitude');
  if (hasLatitude !== hasLongitude) {
    throw new Error('GPS latitude and longitude must be supplied together.');
  }
  if (payload.gps.status === 'fix' && !hasLatitude) {
    throw new Error('A GPS fix requires latitude and longitude.');
  }
  if (hasLatitude &&
      (typeof payload.gps.latitude !== 'number' || !Number.isFinite(payload.gps.latitude) ||
       payload.gps.latitude < -90 || payload.gps.latitude > 90 ||
       typeof payload.gps.longitude !== 'number' || !Number.isFinite(payload.gps.longitude) ||
       payload.gps.longitude < -180 || payload.gps.longitude > 180)) {
    throw new Error('GPS coordinates are outside valid latitude or longitude ranges.');
  }
  if (!validLoraStatuses.has(payload.loraStatus)) {
    throw new Error('loraStatus must be receiving or disconnected.');
  }

  const normalized = {
    deviceId,
    heartRateBpm: payload.heartRateBpm,
    movementStatus: payload.movementStatus,
    gps: { status: payload.gps.status },
    loraStatus: payload.loraStatus,
    updatedAt: normalizeTimestamp(payload.updatedAt, now)
  };
  if (hasLatitude) {
    normalized.gps.latitude = payload.gps.latitude;
    normalized.gps.longitude = payload.gps.longitude;
  }
  return normalized;
}

module.exports = { validateDevicePayload };