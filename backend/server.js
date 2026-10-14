const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { validateDevicePayload } = require('./device-payload');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const deviceStaleAfterMs = Number(process.env.DEVICE_STALE_AFTER_MS || 120000);
const maxHistoryEntries = 1000;
if (!Number.isSafeInteger(deviceStaleAfterMs) || deviceStaleAfterMs < 1000 || deviceStaleAfterMs > 86400000) {
  throw new Error('DEVICE_STALE_AFTER_MS must be an integer from 1000 to 86400000.');
}
const configuredOrigins = new Set(
  (process.env.VITABAND_ALLOWED_ORIGIN || '').split(',').map(origin => origin.trim()).filter(Boolean)
);
const maxBodyBytes = 8192;
const maxProfilePhotoRequestBytes = 96 * 1024;
const maxProfilePhotoBytes = 48 * 1024;
const frontendRoot = path.join(__dirname, '..', 'frontend');
const registrationAttempts = new Map();
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendError(response, statusCode, message) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(message);
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  response.end(JSON.stringify(value));
}

function isAllowedRequestOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (process.env.NODE_ENV === 'production') return configuredOrigins.has(origin);
  return origin === `http://${host}:${port}`;
}

function readJsonBody(request, maxBytes = maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        request.resume();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function hasValidDeviceToken(request) {
  const expected = process.env.VITABAND_DEVICE_TOKEN;
  const provided = (request.headers.authorization || '').match(/^Bearer (.+)$/i)?.[1];
  if (!expected || !provided) return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length &&
    timingSafeEqual(expectedBytes, providedBytes);
}

function matchesReading(left, right) {
  return left?.deviceId === right.deviceId &&
    left?.heartRateBpm === right.heartRateBpm &&
    left?.movementStatus === right.movementStatus &&
    left?.loraStatus === right.loraStatus &&
    left?.gps?.status === right.gps.status &&
    left?.gps?.latitude === right.gps.latitude &&
    left?.gps?.longitude === right.gps.longitude &&
    new Date(left?.updatedAt).getTime() === new Date(right.updatedAt).getTime();
}

async function ingestDeviceReading(request, response) {
  const configuredDeviceToken = process.env.VITABAND_DEVICE_TOKEN;
  if (!configuredDeviceToken || Buffer.byteLength(configuredDeviceToken) < 32 ||
      configuredDeviceToken.startsWith('replace-with-')) {
    sendJson(response, 503, { error: 'Device ingestion requires a configured random token of at least 32 bytes.' });
    return;
  }
  if (!hasValidDeviceToken(request)) {
    sendJson(response, 401, { error: 'A valid device bearer token is required.' });
    return;
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'Device readings must be sent as JSON.' });
    return;
  }

  let reading;
  try {
    reading = validateDevicePayload(await readJsonBody(request));
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  try {
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const readingTimestamp = Date.parse(reading.updatedAt);
    const historyKey = String(readingTimestamp);
    const messageHash = createHash('sha256').update(JSON.stringify(reading)).digest('hex');
    let duplicate = false;
    let conflict = false;
    let historicalOnly = false;
    let invalidCurrentRecord = false;
    const result = await getDatabase(app).ref(`devices/${reading.deviceId}`).transaction(current => {
      duplicate = false;
      conflict = false;
      historicalOnly = false;
      invalidCurrentRecord = false;
      const history = { ...(current?.history || {}) };
      const existing = history[historyKey];
      if (existing) {
        if ((existing.messageHash && existing.messageHash === messageHash) ||
            (!existing.messageHash && matchesReading(current, reading))) {
          duplicate = true;
        } else {
          conflict = true;
        }
        return;
      }

      history[historyKey] = {
        timestamp: reading.updatedAt,
        heartRateBpm: reading.heartRateBpm,
        messageHash
      };
      const orderedHistory = Object.entries(history)
        .sort((left, right) => Date.parse(left[1]?.timestamp) - Date.parse(right[1]?.timestamp));
      for (const [key] of orderedHistory.slice(0, -maxHistoryEntries)) {
        delete history[key];
      }

      const currentTimestamp = current ? new Date(current.updatedAt).getTime() : Number.NaN;
      if (current && !Number.isFinite(currentTimestamp)) {
        invalidCurrentRecord = true;
        return;
      }
      if (Number.isFinite(currentTimestamp) && currentTimestamp > readingTimestamp) {
        historicalOnly = true;
        return { ...current, history };
      }
      return { ...reading, history };
    }, undefined, false);

    if (duplicate) {
      sendJson(response, 200, { status: 'duplicate', deviceId: reading.deviceId, updatedAt: reading.updatedAt });
      return;
    }
    if (conflict) {
      sendJson(response, 409, { error: 'A different reading already uses this updatedAt timestamp.' });
      return;
    }
    if (invalidCurrentRecord) {
      sendJson(response, 409, { error: 'The existing device record has an invalid updatedAt timestamp.' });
      return;
    }
    if (!result.committed) {
      sendJson(response, 503, { error: 'The reading could not be stored. Retry the request.' });
      return;
    }
    sendJson(response, 201, {
      status: historicalOnly ? 'stored_historical' : 'stored',
      deviceId: reading.deviceId,
      updatedAt: reading.updatedAt
    });
  } catch (error) {
    console.error('Device reading ingestion failed:', error.code || error.message);
    sendJson(response, 503, { error: 'Could not store the device reading.' });
  }
}

async function manageOperatorProfilePhoto(request, response) {
  if (request.method === 'PUT' && !isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Profile update origin is not allowed.' });
    return;
  }

  const authResult = await getAuthenticatedUser(request);
  if (authResult.statusCode) {
    sendJson(response, authResult.statusCode, { error: authResult.error });
    return;
  }

  const user = authResult.user;
  const isAdmin = Boolean(configuredAdminEmail()) &&
    user.email?.toLowerCase() === configuredAdminEmail();
  try {
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const database = getDatabase(app);
    if (!isAdmin) {
      const approved = await database.ref(`approvedOperators/${user.uid}`).get();
      if (approved.val() !== true) {
        sendJson(response, 403, { error: 'Only approved dashboard users can update a profile picture.' });
        return;
      }
    }

    const profileRef = database.ref(`operatorProfiles/${user.uid}`);
    if (request.method === 'GET') {
      const snapshot = await profileRef.get();
      const profile = snapshot.val() || {};
      sendJson(response, 200, {
        photo: typeof profile.photo === 'string' ? profile.photo : null,
        birthday: typeof profile.birthday === 'string' ? profile.birthday : '',
        position: typeof profile.position === 'string' ? profile.position : '',
        gender: typeof profile.gender === 'string' ? profile.gender : ''
      });
      return;
    }

    if (request.method !== 'PUT') {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      sendJson(response, 415, { error: 'Profile pictures must be sent as JSON.' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(request, maxProfilePhotoRequestBytes);
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.message });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(response, 400, { error: 'Profile details must be a JSON object.' });
      return;
    }

    const updates = {};
    if (Object.hasOwn(body, 'photo')) {
      const match = typeof body.photo === 'string'
        ? body.photo.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/)
        : null;
      if (!match) {
        sendJson(response, 400, { error: 'Choose a valid JPEG profile picture.' });
        return;
      }

      const image = Buffer.from(match[1], 'base64');
      if (image.length > maxProfilePhotoBytes ||
          image.toString('base64') !== match[1] ||
          image[0] !== 0xff || image[1] !== 0xd8 ||
          image[image.length - 2] !== 0xff || image[image.length - 1] !== 0xd9) {
        sendJson(response, 400, { error: 'The profile picture must be a valid JPEG under 48 KB.' });
        return;
      }
      updates.photo = body.photo;
    }

    if (Object.hasOwn(body, 'birthday')) {
      const birthday = body.birthday;
      const date = typeof birthday === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(birthday)
        ? new Date(`${birthday}T00:00:00.000Z`)
        : null;
      if (birthday !== '' && (!date || date.toISOString().slice(0, 10) !== birthday ||
          date.getTime() > Date.now())) {
        sendJson(response, 400, { error: 'Enter a valid birthday that is not in the future.' });
        return;
      }
      updates.birthday = birthday;
    }
    if (Object.hasOwn(body, 'position')) {
      if (typeof body.position !== 'string' || body.position.trim().length > 80) {
        sendJson(response, 400, { error: 'Position must be 80 characters or fewer.' });
        return;
      }
      updates.position = body.position.trim();
    }
    if (Object.hasOwn(body, 'gender')) {
      if (!['', 'female', 'male', 'other'].includes(body.gender)) {
        sendJson(response, 400, { error: 'Choose a valid gender option.' });
        return;
      }
      updates.gender = body.gender;
    }
    if (!Object.keys(updates).length) {
      sendJson(response, 400, { error: 'Provide at least one profile field to update.' });
      return;
    }

    await profileRef.update(updates);
    sendJson(response, 200, updates);
  } catch (error) {
    console.error('Could not update operator profile:', error.code || error.message);
    sendJson(response, 503, { error: 'Could not load or save the profile. Check Firebase access and try again.' });
  }
}

function allowRegistrationAttempt(address) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const limit = 8;
  const current = registrationAttempts.get(address);
  if (!current || now - current.startedAt >= windowMs) {
    registrationAttempts.set(address, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function configuredAdminEmail() {
  return process.env.VITABAND_ADMIN_EMAIL?.trim().toLowerCase() || '';
}

async function verifyAdmin(request) {
  const expectedEmail = configuredAdminEmail();
  if (!expectedEmail) return { statusCode: 503, error: 'Admin dashboard is not configured.' };

  const match = (request.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, error: 'Sign in with the administrator account.' };

  try {
    const { getAuth } = require('firebase-admin/auth');
    const { app } = require('./firebase-admin');
    const decodedToken = await getAuth(app).verifyIdToken(match[1]);
    if (decodedToken.email?.toLowerCase() !== expectedEmail) {
      return { statusCode: 403, error: 'Only the configured administrator can manage account requests.' };
    }
    return { decodedToken };
  } catch (error) {
    console.error('Administrator authentication failed:', error.code || error.message);
    return { statusCode: 503, error: 'Could not verify administrator sign-in. Check Firebase server credentials and try again.' };
  }
}

async function getAuthenticatedUser(request) {
  const match = (request.headers.authorization || '').match(/^Bearer (.+)$/i);
  if (!match) return { statusCode: 401, error: 'Sign in to continue.' };
  try {
    const { getAuth } = require('firebase-admin/auth');
    const { app } = require('./firebase-admin');
    return { user: await getAuth(app).verifyIdToken(match[1]) };
  } catch (error) {
    console.error('Operator authentication failed:', error.code || error.message);
    if (error.code?.startsWith('VITABAND_FIREBASE_CONFIG_')) {
      return { statusCode: 503, error: 'Firebase Admin is not configured. Check the server credential environment variable.' };
    }
    return { statusCode: 401, error: 'Could not verify sign-in. Please sign in again.' };
  }
}

async function submitRegistrationRequest(request, response) {
  if (!isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Account request origin is not allowed.' });
    return;
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'Account requests require a JSON request.' });
    return;
  }
  if (!allowRegistrationAttempt(request.socket.remoteAddress || 'unknown')) {
    sendJson(response, 429, { error: 'Too many account requests. Wait 15 minutes and try again.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(response, 400, { error: 'Account request details must be a JSON object.' });
    return;
  }
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!displayName || displayName.length > 80 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
      password.length < 6 || password.length > 128) {
    sendJson(response, 400, { error: 'Enter a valid name, email, and password.' });
    return;
  }

  let user;
  try {
    const { getAuth } = require('firebase-admin/auth');
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const adminAuth = getAuth(app);
    const database = getDatabase(app);
    user = await adminAuth.createUser({ email, password, displayName, disabled: true });
    await database.ref(`operatorRequests/${user.uid}`).set({
      displayName,
      email,
      requestedAt: Date.now(),
      status: 'pending'
    });
    sendJson(response, 201, { status: 'pending', message: 'Account request submitted for administrator approval.' });
  } catch (error) {
    if (user) {
      try {
        const { getAuth } = require('firebase-admin/auth');
        const { app } = require('./firebase-admin');
        await getAuth(app).deleteUser(user.uid);
      } catch (cleanupError) {
        console.error('Could not clean up an unsubmitted account request:', cleanupError.code || cleanupError.message);
      }
    }
    if (error.code === 'auth/email-already-exists') {
      sendJson(response, 409, { error: 'An account already exists for this email. Sign in or contact the administrator.' });
      return;
    }
    console.error('Could not submit operator account request:', error.code || error.message);
    sendJson(response, 503, { error: 'Could not submit the account request. Please try again later.' });
  }
}

async function getOperatorStatus(request, response) {
  const authResult = await getAuthenticatedUser(request);
  if (authResult.statusCode) {
    sendJson(response, authResult.statusCode, { error: authResult.error });
    return;
  }
  const user = authResult.user;
  if (user.email?.toLowerCase() === configuredAdminEmail() && configuredAdminEmail()) {
    sendJson(response, 200, { status: 'admin' });
    return;
  }
  try {
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const database = getDatabase(app);
    const approved = await database.ref(`approvedOperators/${user.uid}`).get();
    if (approved.val() === true) {
      sendJson(response, 200, { status: 'approved' });
      return;
    }
    sendJson(response, 403, { error: 'This account has not been approved for the operator dashboard.' });
  } catch (error) {
    console.error('Could not get operator account status:', error.code || error.message);
    sendJson(response, 503, { error: 'Could not check account approval status. Try again later.' });
  }
}

async function listOperatorRequests(request, response) {
  const admin = await verifyAdmin(request);
  if (admin.statusCode) {
    sendJson(response, admin.statusCode, { error: admin.error });
    return;
  }
  try {
    const { getAuth } = require('firebase-admin/auth');
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const adminAuth = getAuth(app);
    const database = getDatabase(app);
    const snapshot = await database.ref('operatorRequests').get();
    const values = snapshot.val() || {};
    const requests = [];
    for (const [uid, item] of Object.entries(values)) {
      if (!['pending', 'approving'].includes(item?.status)) continue;
      const [approvedSnapshot, user] = await Promise.all([
        database.ref(`approvedOperators/${uid}`).get(),
        adminAuth.getUser(uid)
      ]);
      if (approvedSnapshot.val() === true && !user.disabled) {
        await database.ref(`operatorRequests/${uid}`).update({
          status: 'approved',
          decidedAt: item.decidedAt || Date.now()
        });
        continue;
      }
      requests.push({
        uid,
        displayName: typeof item.displayName === 'string' ? item.displayName : '',
        email: typeof item.email === 'string' ? item.email : '',
        requestedAt: Number.isFinite(item.requestedAt) ? item.requestedAt : 0,
        status: item.status
      });
    }
    requests.sort((left, right) => left.requestedAt - right.requestedAt);
    sendJson(response, 200, { requests });
  } catch (error) {
    console.error('Could not list operator account requests:', error.code || error.message);
    sendJson(response, 503, { error: 'Could not load account requests. Check Firebase Admin database access.' });
  }
}

async function decideOperatorRequest(request, response, uid, decision) {
  if (!isAllowedRequestOrigin(request)) {
    sendJson(response, 403, { error: 'Admin request origin is not allowed.' });
    return;
  }
  const admin = await verifyAdmin(request);
  if (admin.statusCode) {
    sendJson(response, admin.statusCode, { error: admin.error });
    return;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) {
    sendJson(response, 400, { error: 'Invalid operator request ID.' });
    return;
  }
  try {
    const { getDatabase } = require('firebase-admin/database');
    const { app } = require('./firebase-admin');
    const database = getDatabase(app);
    const requestRef = database.ref(`operatorRequests/${uid}`);
    let requestSnapshot = await requestRef.get();
    let currentRequest = requestSnapshot.val();
    if (!currentRequest) {
      sendJson(response, 404, { error: 'Account request not found.' });
      return;
    }

    if (decision === 'rejected') {
      if (currentRequest.status === 'rejected') {
        sendJson(response, 409, { status: 'rejected', error: 'This request was declined.' });
        return;
      }
      if (currentRequest.status !== 'pending') {
        sendJson(response, 409, { status: currentRequest.status, error: 'This request is being approved or has already been approved.' });
        return;
      }
      const result = await requestRef.transaction(current => {
        if (current === null) return null;
        if (current.status !== 'pending') return;
        return { ...current, status: 'rejected', decidedAt: Date.now() };
      }, undefined, false);
      if (!result.committed) {
        requestSnapshot = await requestRef.get();
        if (requestSnapshot.val()?.status === 'rejected') {
          sendJson(response, 409, { status: 'rejected', error: 'This request was declined.' });
          return;
        }
        sendJson(response, 409, { status: requestSnapshot.val()?.status, error: 'This request is being approved or has already been approved.' });
        return;
      }
      sendJson(response, 200, { status: 'rejected' });
      return;
    }

    if (currentRequest.status === 'rejected') {
      sendJson(response, 409, { status: 'rejected', error: 'This request was declined and cannot be approved.' });
      return;
    }
    if (currentRequest.status === 'pending') {
      const result = await requestRef.transaction(current => {
        if (current === null) return null;
        if (current.status !== 'pending') return;
        return { ...current, status: 'approving', decidedAt: Date.now() };
      }, undefined, false);
      requestSnapshot = result.committed ? result.snapshot : await requestRef.get();
      currentRequest = requestSnapshot.val();
      if (!currentRequest || !['approving', 'approved'].includes(currentRequest.status)) {
        console.error('Could not claim operator request for approval:', {
          transactionCommitted: result.committed,
          currentStatus: currentRequest?.status || 'missing'
        });
        sendJson(response, 409, { status: currentRequest?.status, error: 'This request was already declined or is no longer available.' });
        return;
      }
    }
    if (!['approving', 'approved'].includes(currentRequest.status)) {
      sendJson(response, 409, { status: currentRequest.status, error: 'This request cannot be approved in its current state.' });
      return;
    }

    const { getAuth } = require('firebase-admin/auth');
    const adminAuth = getAuth(app);
    try {
      await adminAuth.updateUser(uid, { disabled: false });
      await database.ref(`approvedOperators/${uid}`).set(true);
      await requestRef.update({ status: 'approved', decidedAt: currentRequest.decidedAt || Date.now() });
    } catch (error) {
      try {
        await adminAuth.updateUser(uid, { disabled: true });
      } catch (rollbackError) {
        console.error('Could not disable an incompletely approved account:', rollbackError.code || rollbackError.message);
      }
      try {
        await database.ref(`approvedOperators/${uid}`).remove();
      } catch (rollbackError) {
        console.error('Could not roll back operator database approval:', rollbackError.code || rollbackError.message);
      }
      try {
        await requestRef.update({ status: 'pending' });
      } catch (rollbackError) {
        console.error('Could not restore the pending operator request:', rollbackError.code || rollbackError.message);
      }
      throw error;
    }
    sendJson(response, 200, { status: 'approved' });
  } catch (error) {
    console.error(`Could not ${decision} operator account request:`, error.code || error.message);
    sendJson(response, 503, { error: `Could not ${decision === 'approved' ? 'approve' : 'reject'} the request. Try again.` });
  }
}

async function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`).pathname);
  } catch {
    sendError(response, 400, 'Invalid URL path.');
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(frontendRoot, relativePath);
  if (filePath !== frontendRoot && !filePath.startsWith(frontendRoot + path.sep)) {
    sendError(response, 403, 'Path is outside the frontend directory.');
    return;
  }

  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) {
      sendError(response, 404, 'File not found.');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      sendError(response, 404, 'File not found.');
      return;
    }
    throw error;
  }
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/config' && request.method === 'GET') {
    sendJson(response, 200, { deviceId: 'VB-01', deviceStaleAfterMs });
    return;
  }
  if (request.url === '/api/device/readings' && request.method === 'POST') {
    ingestDeviceReading(request, response).catch(error => {
      console.error('Device reading ingestion failed:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Could not process the device reading.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.url === '/api/operator/status' && request.method === 'GET') {
    getOperatorStatus(request, response).catch(error => {
      console.error('Could not check operator approval:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Could not check operator approval.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.url === '/api/operator/profile-photo' && ['GET', 'PUT'].includes(request.method)) {
    manageOperatorProfilePhoto(request, response).catch(error => {
      console.error('Could not manage operator profile picture:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Could not manage the profile picture.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.url === '/api/admin/requests' && request.method === 'GET') {
    listOperatorRequests(request, response).catch(error => {
      console.error('Could not load admin account requests:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Could not load account requests.' });
      else response.destroy(error);
    });
    return;
  }
  const decisionMatch = request.url.match(/^\/api\/admin\/requests\/([^/]+)\/(approve|reject)$/);
  if (decisionMatch && request.method === 'POST') {
    decideOperatorRequest(request, response, decisionMatch[1], decisionMatch[2] === 'approve' ? 'approved' : 'rejected').catch(error => {
      console.error('Could not decide account request:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Could not update the account request.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.url === '/api/registration-requests' && request.method === 'POST') {
    submitRegistrationRequest(request, response).catch(error => {
      console.error('Account request submission failed:', error.code || error.message);
      if (!response.headersSent) sendJson(response, 500, { error: 'Account request could not be submitted.' });
      else response.destroy(error);
    });
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, 405, 'Method not allowed.');
    return;
  }
  serveStatic(request, response).catch(error => {
    console.error('Static file request failed:', error);
    if (!response.headersSent) sendError(response, 500, 'Internal server error.');
    else response.destroy(error);
  });
});

if (require.main === module) {
  server.listen(port, host, () => {
    console.log(`VitaBand server listening at http://${host}:${port}`);
  });
}

module.exports = server;
