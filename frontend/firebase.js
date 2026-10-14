import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { getDatabase } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';

const firebaseConfig = {
  apiKey: 'AIzaSyArDjyWnxWUjCFzrxOFXteFSqlhvrr_h0s',
  authDomain: 'vitaband-d0f19.firebaseapp.com',
  databaseURL: 'https://vitaband-d0f19-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'vitaband-d0f19',
  appId: '1:674267930038:web:5823fdcb17e74a1e703517'
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const database = getDatabase(app);
