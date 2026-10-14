const { cert, getApps, initializeApp } = require('firebase-admin/app');
const fs = require('node:fs');
const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!keyPath) {
  throw Object.assign(
    new Error('Set GOOGLE_APPLICATION_CREDENTIALS to a Firebase service-account file stored outside this project.'),
    { code: 'VITABAND_FIREBASE_CONFIG_MISSING' }
  );
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
} catch (error) {
  throw Object.assign(
    new Error('Could not read or parse the configured Firebase service-account file.'),
    { code: 'VITABAND_FIREBASE_CONFIG_INVALID' }
  );
}
if (serviceAccount.project_id !== 'vitaband-d0f19') {
  throw Object.assign(
    new Error('Firebase service-account credentials must belong to project vitaband-d0f19.'),
    { code: 'VITABAND_FIREBASE_CONFIG_PROJECT_MISMATCH' }
  );
}

const app = getApps()[0] || initializeApp({
  credential: cert(serviceAccount),
  projectId: 'vitaband-d0f19',
  databaseURL: 'https://vitaband-d0f19-default-rtdb.asia-southeast1.firebasedatabase.app'
});

module.exports = { app };
