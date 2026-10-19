function validatePhoneLocation(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object.');
  }
  const unknownFields = Object.keys(payload).filter(field =>
    !['latitude', 'longitude', 'accuracyM', 'capturedAt'].includes(field)
  );
  if (unknownFields.length) {
    throw new Error(`Unsupported phone location field: ${unknownFields[0]}.`);
  }
  if (typeof payload.latitude !== 'number' || !Number.isFinite(payload.latitude) ||
      payload.latitude < -90 || payload.latitude > 90 ||
      typeof payload.longitude !== 'number' || !Number.isFinite(payload.longitude) ||
      payload.longitude < -180 || payload.longitude > 180) {
    throw new Error('Phone coordinates must be valid latitude and longitude numbers.');
  }
  if (typeof payload.accuracyM !== 'number' || !Number.isFinite(payload.accuracyM) ||
      payload.accuracyM < 0 || payload.accuracyM > 100000) {
    throw new Error('Phone accuracyM must be a number from 0 to 100000.');
  }
  if (!Number.isSafeInteger(payload.capturedAt)) {
    throw new Error('Phone capturedAt must be an integer Unix timestamp in milliseconds.');
  }
  const age = now - payload.capturedAt;
  if (!Number.isFinite(new Date(payload.capturedAt).getTime()) || age < -30000 || age > 300000) {
    throw new Error('Phone capturedAt must be within 5 minutes of the current time.');
  }
  return {
    latitude: payload.latitude,
    longitude: payload.longitude,
    accuracyM: payload.accuracyM,
    capturedAt: new Date(payload.capturedAt).toISOString()
  };
}

module.exports = { validatePhoneLocation };
