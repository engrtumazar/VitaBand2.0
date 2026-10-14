import {
  browserSessionPersistence,
  onAuthStateChanged,
  setPersistence,
  signOut,
  signInWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { auth } from './firebase.js';

document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('vitaband-theme') === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  }
  if (window.lucide) window.lucide.createIcons();

  const form = document.getElementById('loginForm');
  const displayName = document.getElementById('displayName');
  const displayNameField = document.getElementById('displayNameField');
  const email = document.getElementById('email');
  const password = document.getElementById('password');
  const confirmPassword = document.getElementById('confirmPassword');
  const confirmPasswordField = document.getElementById('confirmPasswordField');
  const errorMessage = document.getElementById('loginError');
  const submitButton = document.getElementById('signInButton');
  const buttonLabel = submitButton.querySelector('span');
  const authModeToggle = document.getElementById('authModeToggle');
  const loginTitle = document.getElementById('loginTitle');
  const loginDescription = document.getElementById('loginDescription');
  const authSwitchText = document.getElementById('authSwitchText');
  let mode = 'login';
  let isSubmitting = false;

  function showMessage(message, isError = true) {
    errorMessage.textContent = message;
    errorMessage.hidden = false;
    errorMessage.classList.toggle('is-success', !isError);
  }

  function setMode(nextMode) {
    mode = nextMode;
    const isCreatingAccount = mode === 'signup';
    if (isCreatingAccount) {
      email.value = '';
      password.value = '';
      confirmPassword.value = '';
    }
    displayNameField.hidden = !isCreatingAccount;
    displayName.disabled = !isCreatingAccount;
    displayName.required = isCreatingAccount;
    confirmPasswordField.hidden = !isCreatingAccount;
    confirmPassword.disabled = !isCreatingAccount;
    confirmPassword.required = isCreatingAccount;
    email.autocomplete = isCreatingAccount ? 'off' : 'username';
    password.autocomplete = isCreatingAccount ? 'new-password' : 'current-password';
    loginTitle.textContent = isCreatingAccount ? 'Create an account' : 'Sign in';
    loginDescription.textContent = isCreatingAccount
      ? 'Submit your details for administrator approval before accessing the dashboard.'
      : 'Sign in with your operator account to access the dashboard.';
    buttonLabel.textContent = isCreatingAccount ? 'Create account' : 'Login';
    authSwitchText.textContent = isCreatingAccount ? 'Already have an account?' : 'Need an account?';
    authModeToggle.textContent = isCreatingAccount ? 'Sign in' : 'Create an account';
    errorMessage.hidden = true;
    errorMessage.classList.remove('is-success');
    if (window.lucide) window.lucide.createIcons();
  }

  authModeToggle.addEventListener('click', () => {
    setMode(mode === 'login' ? 'signup' : 'login');
  });

  document.getElementById('passwordToggle').addEventListener('click', event => {
    const showPassword = password.type === 'password';
    password.type = showPassword ? 'text' : 'password';
    event.currentTarget.setAttribute('aria-label', showPassword ? 'Hide password' : 'Show password');
    event.currentTarget.setAttribute('title', showPassword ? 'Hide password' : 'Show password');
    event.currentTarget.innerHTML = `<i data-lucide="${showPassword ? 'eye-off' : 'eye'}"></i>`;
    if (window.lucide) window.lucide.createIcons();
  });

  async function routeSignedInUser(user) {
    const token = await user.getIdToken();
    const response = await fetch('/api/operator/status', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not check account approval.');
    if (result.status === 'admin') {
      window.location.replace('/index.html');
    } else if (result.status === 'approved') {
      window.location.replace('/index.html');
    } else {
      await signOut(auth);
      showMessage(result.status === 'rejected'
        ? 'Your account request was declined. Contact the administrator.'
        : 'Your account is waiting for administrator approval.');
    }
  }

  if (new URLSearchParams(window.location.search).get('status') === 'pending') {
    showMessage('Your account is waiting for administrator approval.');
  }

  onAuthStateChanged(auth, user => {
    if (user && !isSubmitting) {
      routeSignedInUser(user).catch(error => {
        showMessage('Could not check account approval. Please try again.');
        console.error('Could not check operator account approval:', error);
      });
    }
  }, error => {
    showMessage('Could not connect to Firebase Authentication. Check your internet connection and Firebase setup.');
    console.error('Could not check Firebase operator session:', error);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    errorMessage.hidden = true;
    submitButton.disabled = true;
    buttonLabel.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
    isSubmitting = true;

    try {
      await setPersistence(auth, browserSessionPersistence);
      if (mode === 'signup') {
        const trimmedName = displayName.value.trim();
        if (password.value !== confirmPassword.value) {
          throw new Error('passwords-do-not-match');
        }
        const response = await fetch('/api/registration-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: trimmedName,
            email: email.value.trim(),
            password: password.value
          })
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || 'Could not submit the account request.');
        }
        setMode('login');
        email.value = email.value.trim();
        password.value = '';
        confirmPassword.value = '';
        displayName.value = '';
        showMessage('Account request submitted. You can sign in after the administrator approves it.', false);
      } else {
        const credential = await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
        await routeSignedInUser(credential.user);
      }
    } catch (error) {
      const messages = {
        'passwords-do-not-match': 'The passwords do not match.',
        'auth/email-already-in-use': 'An account already exists for this email. Sign in instead.',
        'auth/invalid-credential': 'Email or password is incorrect.',
        'auth/invalid-email': 'Enter a valid operator email address.',
        'auth/weak-password': 'Choose a password with at least 6 characters.',
        'auth/too-many-requests': 'Too many sign-in attempts. Wait a while and try again.',
        'auth/network-request-failed': 'Unable to reach Firebase. Check your internet connection.',
        'auth/operation-not-allowed': 'Email/password sign-in is not enabled in Firebase Authentication.',
        'auth/unauthorized-domain': 'This website address is not authorized in Firebase Authentication.',
        'auth/user-disabled': 'Your account request is waiting for administrator approval.'
      };
      const message = messages[error.code] ||
        (mode === 'signup'
          ? error.message || 'Account request failed. Check your details and try again.'
          : 'Sign-in failed. Check your credentials and Firebase Authentication setup.');
      showMessage(message);
      isSubmitting = false;
      submitButton.disabled = false;
      buttonLabel.textContent = mode === 'signup' ? 'Create account' : 'Login';
      (mode === 'signup' ? displayName : password).focus();
      console.error(`Firebase operator ${mode} failed:`, error);
      return;
    }
    isSubmitting = false;
    submitButton.disabled = false;
    buttonLabel.textContent = mode === 'signup' ? 'Create account' : 'Login';
  });
});
