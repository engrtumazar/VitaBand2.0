import { onAuthStateChanged, signOut, updateProfile } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js';
import { get, onValue, ref } from 'https://www.gstatic.com/firebasejs/11.10.0/firebase-database.js';
import { auth, database } from './firebase.js';

function parseDeviceRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Firebase device record must be an object.');
  }
  if (value.deviceId && value.deviceId !== 'VB-01') {
    throw new Error('Firebase deviceId must be VB-01.');
  }
  if (!Number.isInteger(value.heartRateBpm) || value.heartRateBpm < 30 || value.heartRateBpm > 220) {
    throw new Error('Firebase heartRateBpm must be an integer from 30 to 220.');
  }
  if (!['stationary', 'moving', 'unknown'].includes(value.movementStatus)) {
    throw new Error('Firebase movementStatus must be stationary, moving, or unknown.');
  }
  if (!value.gps || typeof value.gps !== 'object' ||
      !['fix', 'no_fix'].includes(value.gps.status)) {
    throw new Error('Firebase gps.status must be fix or no_fix.');
  }
  if (value.gps.status === 'fix' &&
      (typeof value.gps.latitude !== 'number' || !Number.isFinite(value.gps.latitude) ||
       value.gps.latitude < -90 || value.gps.latitude > 90 ||
       typeof value.gps.longitude !== 'number' || !Number.isFinite(value.gps.longitude) ||
       value.gps.longitude < -180 || value.gps.longitude > 180)) {
    throw new Error('Firebase GPS fix must include valid latitude and longitude.');
  }
  if (!['receiving', 'disconnected'].includes(value.loraStatus)) {
    throw new Error('Firebase loraStatus must be receiving or disconnected.');
  }
  let sosEvent;
  if (value.sosEvent !== undefined && value.sosEvent !== null) {
    if (!value.sosEvent || typeof value.sosEvent !== 'object' || Array.isArray(value.sosEvent) ||
        value.sosEvent.status !== 'received') {
      throw new Error('Firebase sosEvent must describe a received SOS request.');
    }
    const requestedAt = new Date(value.sosEvent.requestedAt);
    const receivedAt = new Date(value.sosEvent.receivedAt);
    if (!Number.isFinite(requestedAt.getTime()) || !Number.isFinite(receivedAt.getTime())) {
      throw new Error('Firebase sosEvent must include valid request and receipt timestamps.');
    }
    sosEvent = {
      status: 'received',
      requestedAt: requestedAt.toISOString(),
      receivedAt: receivedAt.toISOString()
    };
  }
  if (typeof value.updatedAt !== 'string' && typeof value.updatedAt !== 'number') {
    throw new Error('Firebase updatedAt must be a date string or timestamp.');
  }
  const updatedAt = new Date(value.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    throw new Error('Firebase updatedAt must be a valid date or timestamp.');
  }
  let receivedAt;
  if (value.receivedAt !== undefined && value.receivedAt !== null) {
    if (typeof value.receivedAt !== 'string' && typeof value.receivedAt !== 'number') {
      throw new Error('Firebase receivedAt must be a date string or timestamp.');
    }
    receivedAt = new Date(value.receivedAt);
    if (!Number.isFinite(receivedAt.getTime())) {
      throw new Error('Firebase receivedAt must be a valid date or timestamp.');
    }
  }

  const historyValues = value.history && typeof value.history === 'object' && !Array.isArray(value.history)
    ? Object.values(value.history)
    : [];
  const history = historyValues.map(reading => {
    if (!reading || typeof reading !== 'object') return null;
    const timestamp = new Date(reading.timestamp);
    if (!Number.isInteger(reading.heartRateBpm) ||
        reading.heartRateBpm < 30 || reading.heartRateBpm > 220 ||
        !Number.isFinite(timestamp.getTime())) {
      return null;
    }
    return { timestamp: timestamp.toISOString(), heartRateBpm: reading.heartRateBpm };
  }).filter(Boolean)
    .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
    .slice(-1000);

  return {
    device: {
      deviceId: 'VB-01',
      heartRateBpm: value.heartRateBpm,
      movementStatus: value.movementStatus,
      gps: value.gps,
      loraStatus: value.loraStatus,
      ...(sosEvent ? { sosEvent } : {}),
      ...(receivedAt ? { receivedAt: receivedAt.toISOString() } : {}),
      updatedAt: updatedAt.toISOString()
    },
    history
  };
}

function parsePhoneLocation(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.source !== 'phone' ||
      typeof value.latitude !== 'number' || !Number.isFinite(value.latitude) ||
      value.latitude < -90 || value.latitude > 90 ||
      typeof value.longitude !== 'number' || !Number.isFinite(value.longitude) ||
      value.longitude < -180 || value.longitude > 180 ||
      typeof value.accuracyM !== 'number' || !Number.isFinite(value.accuracyM) ||
      value.accuracyM < 0 || value.accuracyM > 100000) {
    throw new Error('Firebase phone location must include valid coordinates and accuracy.');
  }
  const capturedAt = new Date(value.capturedAt);
  const receivedAt = new Date(value.receivedAt);
  if (!Number.isFinite(capturedAt.getTime()) || !Number.isFinite(receivedAt.getTime())) {
    throw new Error('Firebase phone location must include valid capture and receipt times.');
  }
  return {
    latitude: value.latitude,
    longitude: value.longitude,
    accuracyM: value.accuracyM,
    capturedAt: capturedAt.toISOString(),
    receivedAt: receivedAt.toISOString()
  };
}

document.addEventListener('DOMContentLoaded', () => {
  const themeToggle = document.getElementById('themeToggle');
  const savedTheme = localStorage.getItem('vitaband-theme');
  if (savedTheme === 'dark') document.documentElement.dataset.theme = 'dark';
  if (themeToggle) {
    const updateThemeButton = () => {
      const isDark = document.documentElement.dataset.theme === 'dark';
      const action = isDark ? 'light' : 'dark';
      themeToggle.setAttribute('aria-label', `Switch to ${action} mode`);
      themeToggle.setAttribute('title', `Switch to ${action} mode`);
      themeToggle.setAttribute('aria-pressed', String(isDark));
      themeToggle.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}"></i>`;
      if (window.lucide) window.lucide.createIcons();
      const chart = window.Chart?.getChart('heartChart');
      if (chart) {
        const chartText = isDark ? '#c0c9b8' : '#899084';
        const chartGrid = isDark ? '#354131' : '#e8ebe3';
        chart.data.datasets[0].borderColor = isDark ? '#c8dc77' : '#34734a';
        chart.data.datasets[0].backgroundColor = isDark ? 'rgba(200,220,119,.12)' : 'rgba(52,115,74,.10)';
        chart.data.datasets[0].pointBorderColor = isDark ? '#c8dc77' : '#34734a';
        chart.data.datasets[0].pointBackgroundColor = isDark ? '#1b2419' : '#fffefa';
        chart.options.plugins.tooltip.backgroundColor = isDark ? '#11180f' : '#202d1b';
        chart.options.scales.x.ticks.color = chartText;
        chart.options.scales.y.ticks.color = chartText;
        chart.options.scales.y.grid.color = chartGrid;
        chart.update();
      }
    };
    updateThemeButton();
    themeToggle.addEventListener('click', () => {
      const isDark = document.documentElement.dataset.theme !== 'dark';
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
      localStorage.setItem('vitaband-theme', isDark ? 'dark' : 'light');
      updateThemeButton();
    });
  }

  if (window.lucide) window.lucide.createIcons();

  const toast = document.getElementById('toast');
  let toastTimer;
  let locationMap = null;
  let isAdmin = false;
  let pendingRequestIds = null;
  let adminRequestTimer = null;
  let isLoadingAdminRequests = false;
  let isDecidingAdminRequest = false;
  let reloadAdminRequestsAfterLoad = false;
  function notify(message) {
    toast.innerHTML = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
  }

  const adminNotificationButton = document.getElementById('adminNotificationButton');
  const adminNotificationBadge = document.getElementById('adminNotificationBadge');
  const adminRequestsBackdrop = document.getElementById('adminRequestsBackdrop');
  const adminRequestsList = document.getElementById('adminRequestsList');
  const adminRequestNotice = document.getElementById('adminRequestNotice');
  const profileDialogBackdrop = document.getElementById('profileDialogBackdrop');
  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const helpBackdrop = document.getElementById('helpBackdrop');
  const profileDialogForm = document.getElementById('profileDialogForm');
  const profileDialogName = document.getElementById('profileDialogName');
  const profileBirthday = document.getElementById('profileBirthday');
  const profilePosition = document.getElementById('profilePosition');
  const profileGender = document.getElementById('profileGender');
  const profileDialogError = document.getElementById('profileDialogError');
  const saveProfileDialog = document.getElementById('saveProfileDialog');
  const profilePhotoInput = document.getElementById('profilePhotoInput');
  const chooseProfilePhoto = document.getElementById('chooseProfilePhoto');
  const chooseProfilePhotoAvatar = document.getElementById('chooseProfilePhotoAvatar');
  const profilePhotoPreview = document.getElementById('profilePhotoPreview');
  const profilePhotoInitials = document.getElementById('profilePhotoInitials');
  const operatorPhoto = document.getElementById('operatorPhoto');
  const operatorInitials = document.getElementById('operatorInitials');
  let currentProfilePhoto = null;
  let currentProfileDetails = { birthday: '', position: '', gender: '' };
  let pendingProfilePhoto = null;
  let dialogReturnFocus = null;
  let activeUtilitySection = null;

  function openDialog(backdrop, focusTarget) {
    dialogReturnFocus = document.activeElement;
    backdrop.hidden = false;
    document.body.classList.add('modal-open');
    focusTarget.focus();
  }

  function closeDialog(backdrop) {
    if (backdrop.hidden) return;
    backdrop.hidden = true;
    if (adminRequestsBackdrop.hidden && profileDialogBackdrop.hidden &&
        settingsBackdrop.hidden && helpBackdrop.hidden) {
      document.body.classList.remove('modal-open');
    }
    if (backdrop === settingsBackdrop || backdrop === helpBackdrop) {
      activeUtilitySection = null;
      updateActiveNavigation();
    }
    if (dialogReturnFocus instanceof HTMLElement && dialogReturnFocus.isConnected) {
      dialogReturnFocus.focus();
    }
    dialogReturnFocus = null;
  }

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!adminRequestsBackdrop.hidden) closeDialog(adminRequestsBackdrop);
    else if (!profileDialogBackdrop.hidden) closeDialog(profileDialogBackdrop);
    else if (!settingsBackdrop.hidden) closeDialog(settingsBackdrop);
    else if (!helpBackdrop.hidden) closeDialog(helpBackdrop);
  });

  for (const backdrop of [adminRequestsBackdrop, profileDialogBackdrop, settingsBackdrop, helpBackdrop]) {
    backdrop.addEventListener('click', event => {
      if (event.target === backdrop) closeDialog(backdrop);
    });
  }

  async function adminRequest(url, options = {}) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in again with the administrator account.');
    const token = await user.getIdToken();
    const response = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'Could not complete the admin action.');
      error.status = response.status;
      error.requestStatus = result.status;
      throw error;
    }
    return result;
  }

  async function requestOperatorProfile(method, profile) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in again before changing your profile.');
    const token = await user.getIdToken();
    const response = await fetch('/api/operator/profile-photo', {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(profile ? { 'Content-Type': 'application/json' } : {})
      },
      ...(profile ? { body: JSON.stringify(profile) } : {})
    });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json')
      ? await response.json()
      : { error: 'Profile service is unavailable. Restart the dashboard server and try again.' };
    if (!response.ok) throw new Error(result.error || 'Could not load or save your profile.');
    return result;
  }

  function initialsForName(name) {
    return (name?.trim() || 'Operator')
      .split(/\s+/)
      .slice(0, 2)
      .map(part => part[0])
      .join('')
      .toUpperCase();
  }

  function setProfilePhotoPreview(photo) {
    profilePhotoPreview.hidden = !photo;
    profilePhotoInitials.hidden = Boolean(photo);
    if (photo) profilePhotoPreview.src = photo;
  }

  async function encodeProfilePhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      throw new Error('Choose a JPG, PNG, or WebP image.');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new Error('Choose an image smaller than 5 MB.');
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      let scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
        if (!blob) throw new Error('Could not process this picture. Try another image.');
        if (blob.size <= 48 * 1024) {
          return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read this picture.'));
            reader.readAsDataURL(blob);
          });
        }
        scale *= 0.8;
      }
      throw new Error('This image could not be compressed enough. Choose a simpler or smaller picture.');
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function setAdminRequestNotice(message, isError = true) {
    adminRequestNotice.textContent = message;
    adminRequestNotice.hidden = !message;
    adminRequestNotice.classList.toggle('is-error', isError);
  }

  function showAdminRequestState(message) {
    const state = document.createElement('div');
    state.className = 'admin-request-state';
    state.textContent = message;
    adminRequestsList.replaceChildren(state);
  }

  async function decideAdminRequest(uid, decision, buttons, retriedConflict = false) {
    if (isDecidingAdminRequest) return;
    isDecidingAdminRequest = true;
    buttons.forEach(button => { button.disabled = true; });
    setAdminRequestNotice('');
    try {
      await adminRequest(`/api/admin/requests/${encodeURIComponent(uid)}/${decision}`, { method: 'POST' });
      isDecidingAdminRequest = false;
      await loadAdminRequests();
      setAdminRequestNotice(decision === 'approve' ? 'Operator account approved.' : 'Account request declined.', false);
    } catch (error) {
      if (error.status === 409) {
        isDecidingAdminRequest = false;
        if (error.requestStatus === 'approved' || error.requestStatus === 'rejected') {
          await loadAdminRequests();
          setAdminRequestNotice(
            error.requestStatus === 'approved'
              ? 'This operator is approved and can sign in now.'
              : 'This request was declined and removed from the pending list.',
            false
          );
        } else if (!retriedConflict) {
          await loadAdminRequests();
          if ([...adminRequestsList.querySelectorAll('.admin-request-item')].some(item => item.dataset.requestUid === uid)) {
            await decideAdminRequest(uid, decision, buttons, true);
          } else {
            setAdminRequestNotice('The request is no longer pending. The list has been refreshed.', false);
          }
        } else {
          buttons.forEach(button => { button.disabled = false; });
          const status = error.requestStatus || 'unknown';
          setAdminRequestNotice(`Approval did not finish. Current request status: ${status}. Check the server output and refresh.`);
          console.error('Operator request approval conflict:', error);
        }
      } else {
        buttons.forEach(button => { button.disabled = false; });
        setAdminRequestNotice(error.message);
      }
      console.error(`Could not ${decision} operator account request:`, error);
    } finally {
      isDecidingAdminRequest = false;
    }
  }

  async function loadAdminRequests() {
    if (!isAdmin || isDecidingAdminRequest) return false;
    if (isLoadingAdminRequests) {
      reloadAdminRequestsAfterLoad = true;
      return false;
    }
    isLoadingAdminRequests = true;
    try {
      const result = await adminRequest('/api/admin/requests');
      const requests = result.requests;
      const requestIds = new Set(requests.map(request => request.uid));
      const hasNewRequests = pendingRequestIds && [...requestIds].some(uid => !pendingRequestIds.has(uid));
      pendingRequestIds = requestIds;
      adminNotificationBadge.textContent = String(requests.length);
      adminNotificationBadge.hidden = requests.length === 0;
      adminNotificationButton.setAttribute('aria-label', `${requests.length} pending operator account requests`);
      adminRequestsList.replaceChildren();
      if (!requests.length) {
        showAdminRequestState('No pending operator account requests.');
        return true;
      }

      requests.forEach(request => {
        const card = document.createElement('article');
        card.className = 'admin-request-item';
        card.dataset.requestUid = request.uid;
        const details = document.createElement('div');
        details.className = 'admin-request-details';
        const name = document.createElement('strong');
        name.textContent = request.displayName || 'Operator';
        const email = document.createElement('span');
        email.textContent = request.email;
        const date = document.createElement('small');
        date.textContent = `Requested ${new Date(request.requestedAt).toLocaleString()}`;
        details.append(name, email, date);

        const actions = document.createElement('div');
        actions.className = 'admin-request-actions';
        const buttons = [];
        for (const decision of ['approve', 'reject']) {
          const button = document.createElement('button');
          button.className = `subtle-button ${decision}-request-button`;
          button.type = 'button';
          button.textContent = decision === 'approve' ? 'Approve' : 'Decline';
          button.addEventListener('click', () => decideAdminRequest(request.uid, decision, buttons));
          actions.append(button);
          buttons.push(button);
        }
        card.append(details, actions);
        adminRequestsList.append(card);
      });
      if (window.lucide) window.lucide.createIcons();
      if (hasNewRequests && adminRequestsBackdrop.hidden) {
        openDialog(adminRequestsBackdrop, document.getElementById('closeAdminRequests'));
      }
      return true;
    } catch (error) {
      showAdminRequestState('Could not load requests. Refresh to try again.');
      setAdminRequestNotice(error.message);
      console.error('Could not load operator account requests:', error);
      return false;
    } finally {
      isLoadingAdminRequests = false;
      if (reloadAdminRequestsAfterLoad) {
        reloadAdminRequestsAfterLoad = false;
        loadAdminRequests();
      }
    }
  }

  adminNotificationButton.addEventListener('click', () => {
    if (adminRequestsBackdrop.hidden) {
      openDialog(adminRequestsBackdrop, document.getElementById('closeAdminRequests'));
      loadAdminRequests();
    } else {
      closeDialog(adminRequestsBackdrop);
    }
  });
  document.getElementById('closeAdminRequests').addEventListener('click', () => closeDialog(adminRequestsBackdrop));
  document.getElementById('refreshRequests').addEventListener('click', loadAdminRequests);
  document.getElementById('closeProfileDialog').addEventListener('click', () => closeDialog(profileDialogBackdrop));
  document.getElementById('cancelProfileDialog').addEventListener('click', () => closeDialog(profileDialogBackdrop));

  function renderOperatorName(name) {
    const operatorName = name?.trim() || 'Operator';
    document.getElementById('operatorName').textContent = operatorName;
    const initials = initialsForName(operatorName);
    operatorInitials.textContent = initials;
    operatorPhoto.hidden = !currentProfilePhoto;
    if (currentProfilePhoto) operatorPhoto.src = currentProfilePhoto;
    profilePhotoInitials.textContent = initials;
    if (!pendingProfilePhoto) setProfilePhotoPreview(currentProfilePhoto);
  }

  let heartChart = null;
  const chartCanvas = document.getElementById('heartChart');
  if (chartCanvas && window.Chart) {
    const darkChart = document.documentElement.dataset.theme === 'dark';
    heartChart = new Chart(chartCanvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Heart rate',
          data: [],
          borderColor: darkChart ? '#c8dc77' : '#34734a',
          backgroundColor: darkChart ? 'rgba(200,220,119,.12)' : 'rgba(52,115,74,.10)',
          fill: true,
          borderWidth: 2.5,
          tension: .38,
          pointRadius: 3,
          pointHoverRadius: 5,
          pointBackgroundColor: darkChart ? '#1b2419' : '#fffefa',
          pointBorderColor: darkChart ? '#c8dc77' : '#34734a',
          pointBorderWidth: 2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: darkChart ? '#11180f' : '#202d1b',
            padding: 10,
            displayColors: false,
            callbacks: { label: context => ` ${context.parsed.y} BPM` }
          }
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: darkChart ? '#c0c9b8' : '#899084', font: { family: 'DM Sans', size: 10 } } },
          y: { min: 50, max: 110, ticks: { stepSize: 20, color: darkChart ? '#c0c9b8' : '#899084', font: { family: 'DM Sans', size: 10 } }, grid: { color: darkChart ? '#354131' : '#e8ebe3', drawTicks: false }, border: { display: false } }
        }
      }
    });
  }

  const mapArea = document.getElementById('mapArea');
  const mapCanvas = document.getElementById('mapCanvas');
  const mapTrackingStatus = document.getElementById('mapTrackingStatus');
  let deviceMarker = null;
  let routeCoordinates = [];
  let lastGpsCoordinate = null;
  let markerAnimationFrame = null;
  let isMapLoaded = false;
  if (mapArea && mapCanvas && window.maplibregl) {
    locationMap = new maplibregl.Map({
      container: mapCanvas,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [120.9842, 14.5995],
      zoom: 12,
      attributionControl: true
    });
    locationMap.addControl(new maplibregl.NavigationControl(), 'top-right');
    locationMap.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    locationMap.on('load', () => {
      isMapLoaded = true;
      locationMap.addSource('tracking-route', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      });
      updateTrackingRoute();
      locationMap.addLayer({
        id: 'tracking-route-glow',
        type: 'line',
        source: 'tracking-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#11180f', 'line-opacity': 0.58, 'line-width': 8, 'line-blur': 1 }
      });
      locationMap.addLayer({
        id: 'tracking-route',
        type: 'line',
        source: 'tracking-route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#c8dc77', 'line-opacity': 0.98, 'line-width': 4 }
      });
    });
  } else if (mapArea) {
    const mapError = document.createElement('div');
    mapError.className = 'map-error';
    mapError.setAttribute('role', 'alert');
    mapError.textContent = 'The map could not load. Check your internet connection and reload.';
    mapArea.prepend(mapError);
  }

  function updateTrackingRoute() {
    if (!isMapLoaded) return;
    const features = routeCoordinates.length > 1
      ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: routeCoordinates }
        }]
      : [];
    locationMap.getSource('tracking-route')?.setData({ type: 'FeatureCollection', features });
  }

  function animateDeviceMarker(targetCoordinates) {
    if (!deviceMarker) return;
    if (markerAnimationFrame !== null) cancelAnimationFrame(markerAnimationFrame);
    const start = deviceMarker.getLngLat();
    const target = { lng: targetCoordinates[0], lat: targetCoordinates[1] };
    const duration = 700;
    const startedAt = performance.now();
    function step(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const easedProgress = 1 - (1 - progress) ** 3;
      deviceMarker.setLngLat([
        start.lng + (target.lng - start.lng) * easedProgress,
        start.lat + (target.lat - start.lat) * easedProgress
      ]);
      if (progress < 1) {
        markerAnimationFrame = requestAnimationFrame(step);
      } else {
        markerAnimationFrame = null;
      }
    }
    markerAnimationFrame = requestAnimationFrame(step);
  }

  let latestPhoneLocation = null;
  let lastMapLocationSource = null;
  let phoneLocationWatchId = null;
  let lastPhoneLocationSentAt = 0;
  let isPhoneLocationSharing = false;
  let phoneLocationSendPromise = null;
  function getMapLocation() {
    const now = Date.now();
    const deviceUpdatedAt = latestDevice ? Date.parse(latestDevice.updatedAt) : Number.NaN;
    const deviceAge = now - deviceUpdatedAt;
    const hasDeviceFix = latestDevice?.gps.status === 'fix';
    const deviceFixFresh = hasDeviceFix && Number.isFinite(deviceAge) &&
      deviceAge >= -30000 && deviceAge <= deviceStaleAfterMs;
    if (deviceFixFresh) {
      return {
        source: 'gps',
        latitude: latestDevice.gps.latitude,
        longitude: latestDevice.gps.longitude,
        timestamp: latestDevice.updatedAt,
        freshness: 'live'
      };
    }

    const fallbackLocations = [];
    const phoneCapturedAt = latestPhoneLocation ? Date.parse(latestPhoneLocation.capturedAt) : Number.NaN;
    const phoneAge = now - phoneCapturedAt;
    if (latestPhoneLocation && Number.isFinite(phoneAge) && phoneAge >= -30000) {
      const phoneFallback = {
        source: 'phone',
        latitude: latestPhoneLocation.latitude,
        longitude: latestPhoneLocation.longitude,
        timestamp: latestPhoneLocation.capturedAt,
        accuracyM: latestPhoneLocation.accuracyM,
        freshness: phoneAge <= deviceStaleAfterMs ? 'live' : 'stale'
      };
      if (phoneFallback.freshness === 'live') return phoneFallback;
      fallbackLocations.push(phoneFallback);
    }

    if (hasDeviceFix) {
      fallbackLocations.push({
        source: 'gps',
        latitude: latestDevice.gps.latitude,
        longitude: latestDevice.gps.longitude,
        timestamp: latestDevice.updatedAt,
        freshness: 'stale'
      });
    }
    return fallbackLocations.sort((left, right) =>
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
    )[0] || null;
  }

  function renderMapLocation() {
    const selectedLocation = getMapLocation();
    const mapFooter = document.querySelector('.map-coords');
    if (!selectedLocation) {
      mapTrackingStatus.className = 'map-tracking-status waiting';
      mapTrackingStatus.lastElementChild.textContent = 'GPS SIGNAL UNAVAILABLE';
      mapFooter.textContent = 'WAITING FOR LOCATION';
      document.getElementById('mapLegendLabel').textContent = 'VB-01 position unavailable';
      if (deviceMarker) deviceMarker.getElement().hidden = true;
      lastMapLocationSource = null;
      return null;
    }

    mapTrackingStatus.className = `map-tracking-status ${selectedLocation.freshness}`;
    mapTrackingStatus.lastElementChild.textContent = selectedLocation.freshness === 'live'
      ? selectedLocation.source === 'phone' ? 'LIVE PHONE LOCATION' : 'LIVE GPS LOCK'
      : selectedLocation.source === 'phone' ? 'STALE PHONE LOCATION' : 'STALE GPS LOCATION';
    mapFooter.textContent = selectedLocation.source === 'phone'
      ? `PHONE LOCATION · ±${Math.round(selectedLocation.accuracyM)} M`
      : 'DEVICE GPS LOCATION';
    document.getElementById('mapLegendLabel').textContent = selectedLocation.source === 'phone'
      ? 'VB-01 · Phone location'
      : 'VB-01 · Device GPS';

    if (!locationMap) return selectedLocation;
    const coordinates = [selectedLocation.longitude, selectedLocation.latitude];
    const sourceChanged = selectedLocation.source !== lastMapLocationSource;
    const popupText = selectedLocation.source === 'phone'
      ? `VB-01 · Phone-reported location (±${Math.round(selectedLocation.accuracyM)} m)`
      : 'VB-01 · Device GPS location';
    if (!deviceMarker) {
      const markerElement = document.createElement('div');
      markerElement.className = 'unit-marker';
      markerElement.setAttribute('role', 'img');
      markerElement.innerHTML = `<span class="unit-marker__reticle" aria-hidden="true"><span class="unit-marker__pulse"></span><span class="unit-marker__ring"></span><span class="unit-marker__crosshair"></span><span class="unit-marker__center"></span></span><span class="unit-marker__label">VB-01</span>`;
      deviceMarker = new maplibregl.Marker({ element: markerElement, anchor: 'left' })
        .setLngLat(coordinates)
        .setPopup(new maplibregl.Popup({ offset: 28 }).setText(popupText))
        .addTo(locationMap);
      locationMap.easeTo({ center: coordinates, zoom: 16, duration: 700, essential: true });
      markerElement.hidden = false;
      routeCoordinates = [coordinates];
      lastGpsCoordinate = coordinates;
    } else {
      deviceMarker.getElement().hidden = false;
      if (sourceChanged) {
        deviceMarker.setPopup(new maplibregl.Popup({ offset: 28 }).setText(popupText));
      }
      const hasMoved = !lastGpsCoordinate ||
        lastGpsCoordinate[0] !== coordinates[0] ||
        lastGpsCoordinate[1] !== coordinates[1];
      if (hasMoved) {
        routeCoordinates.push(coordinates);
        if (routeCoordinates.length > 200) routeCoordinates.shift();
        updateTrackingRoute();
        lastGpsCoordinate = coordinates;
        animateDeviceMarker(coordinates);
        locationMap.easeTo({ center: coordinates, duration: 700, essential: true });
      }
    }
    if (sourceChanged && deviceMarker) {
      deviceMarker.getElement().setAttribute('aria-label',
        selectedLocation.source === 'phone' ? 'VB-01 phone-reported location' : 'VitaBand VB-01 device GPS location');
    }
    lastMapLocationSource = selectedLocation.source;
    return selectedLocation;
  }

  const apiStatus = document.getElementById('apiStatus');
  const apiStatusDot = document.getElementById('apiStatusDot');
  const deviceActivityList = document.getElementById('deviceActivityList');
  let latestDevice = null;
  let hasRenderedDeviceRecord = false;
  let stopDeviceListener = null;
  let deviceStaleAfterMs = 120000;
  let deviceFreshnessTimer = null;
  let stopPhoneLocationListener = null;
  function setFirebaseStatus(message, online) {
    apiStatus.textContent = message;
    apiStatus.parentElement.setAttribute('aria-label', message);
    apiStatusDot.classList.toggle('api-offline', !online);
    document.getElementById('firebaseSidebarDot').classList.toggle('api-offline', !online);
    const sidebarStatus = document.querySelector('.sidebar-bottom strong');
    const sidebarDetail = document.querySelector('.sidebar-bottom small');
    sidebarStatus.textContent = message;
    sidebarDetail.textContent = online ? 'Realtime Database available' : 'Check Firebase connection';
    if (!online) {
      document.getElementById('dataModeTag').textContent = message.includes('CONNECTING')
        ? 'CONNECTING TO DATABASE'
        : 'DATA SOURCE UNAVAILABLE';
    } else if (!latestDevice) {
      document.getElementById('dataModeTag').textContent = 'WAITING FOR DEVICE DATA';
    }
  }

  function updateDeviceFreshness() {
    const connectionStatus = document.getElementById('deviceConnectionStatus');
    const healthStatus = document.getElementById('deviceHealthStatus');
    const dataModeTag = document.getElementById('dataModeTag');
    const activityStatus = document.getElementById('activityStatus');
    const selectedLocation = renderMapLocation();
    if (selectedLocation?.source === 'phone') {
      document.getElementById('gpsValue').textContent =
        selectedLocation.freshness === 'live' ? 'Phone location' : 'Stale phone location';
      document.getElementById('gpsFoot').textContent =
        `±${Math.round(selectedLocation.accuracyM)} m · ${new Date(selectedLocation.timestamp).toLocaleTimeString()}`;
    } else if (latestDevice?.gps.status === 'fix') {
      document.getElementById('gpsValue').textContent = 'Fix acquired';
      document.getElementById('gpsFoot').textContent =
        `${latestDevice.gps.latitude.toFixed(4)}, ${latestDevice.gps.longitude.toFixed(4)}`;
    } else {
      document.getElementById('gpsValue').textContent = latestDevice ? 'No GPS fix' : 'Waiting';
      document.getElementById('gpsFoot').textContent = latestDevice
        ? 'Waiting for GPS signal'
        : 'Waiting for location data';
    }
    if (!latestDevice) {
      connectionStatus.className = 'status-chip unknown-chip';
      connectionStatus.lastChild.textContent = ' UNKNOWN';
      healthStatus.className = 'status-chip unknown-chip';
      healthStatus.lastChild.textContent = ' UNKNOWN';
      dataModeTag.textContent = 'WAITING FOR DEVICE DATA';
      activityStatus.textContent = 'WAITING FOR DATA';
      return;
    }

    const updatedAt = Date.parse(latestDevice.updatedAt);
    const age = Date.now() - updatedAt;
    const timestampUsable = Number.isFinite(updatedAt) && age >= -30000;
    const isFresh = timestampUsable && age <= deviceStaleAfterMs;
    const isOnline = isFresh && latestDevice.loraStatus === 'receiving';
    const connectionLabel = isOnline ? 'ONLINE' : timestampUsable ? 'OFFLINE' : 'UNKNOWN';
    const statusClass = isOnline ? 'normal-chip' : timestampUsable ? 'offline-chip' : 'unknown-chip';
    connectionStatus.className = `status-chip ${statusClass}`;
    connectionStatus.lastChild.textContent = ` ${connectionLabel}`;
    healthStatus.className = `status-chip ${isFresh ? 'normal-chip' : statusClass}`;
    healthStatus.lastChild.textContent = ` ${!timestampUsable ? 'UNKNOWN' : isFresh ? 'FRESH' : 'STALE'}`;
    document.getElementById('deviceLinkSummary').textContent = `VB-01 · ${connectionLabel.toLowerCase()}`;
    document.getElementById('deviceLastSeen').textContent =
      `Last seen ${new Date(updatedAt).toLocaleString()}${isFresh ? '' : ' · stale'}`;
    dataModeTag.textContent = isOnline ? 'LIVE READING' : isFresh ? 'RECEIVER OFFLINE' : 'STALE DATA';
    activityStatus.textContent = isFresh ? 'READING RECEIVED' : 'STALE READING';
  }

  const startPhoneLocationButton = document.getElementById('startPhoneLocationButton');
  const stopPhoneLocationButton = document.getElementById('stopPhoneLocationButton');
  const phoneLocationHelp = document.getElementById('phoneLocationHelp');
  async function sendPhoneLocation(position) {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in again before sharing phone location.');
    const token = await user.getIdToken();
    const response = await fetch('/api/device/phone-location', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: position.coords.accuracy,
        capturedAt: Math.round(position.timestamp)
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not share this phone location.');
    phoneLocationHelp.textContent =
      `Sharing this phone's location · accuracy ±${Math.round(position.coords.accuracy)} m · last sent ${new Date(position.timestamp).toLocaleTimeString()}.`;
  }

  async function clearPhoneLocationOnServer() {
    const user = auth.currentUser;
    if (!user) throw new Error('Sign in again before stopping phone location sharing.');
    const token = await user.getIdToken();
    const response = await fetch('/api/device/phone-location', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not stop phone location sharing.');
  }

  function stopPhoneLocationWatch() {
    if (phoneLocationWatchId !== null) {
      navigator.geolocation.clearWatch(phoneLocationWatchId);
      phoneLocationWatchId = null;
    }
    isPhoneLocationSharing = false;
    startPhoneLocationButton.hidden = false;
    stopPhoneLocationButton.hidden = true;
  }

  startPhoneLocationButton.addEventListener('click', () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      notify('<strong>Secure connection required.</strong> Open the dashboard over HTTPS on the Android phone to use location.');
      return;
    }
    if (!auth.currentUser) {
      notify('<strong>Sign in required.</strong> Sign in with an approved dashboard account first.');
      return;
    }
    isPhoneLocationSharing = true;
    startPhoneLocationButton.hidden = true;
    stopPhoneLocationButton.hidden = false;
    lastPhoneLocationSentAt = 0;
    phoneLocationHelp.textContent = 'Waiting for an Android GPS reading. Keep this dashboard open while sharing.';
    phoneLocationWatchId = navigator.geolocation.watchPosition(position => {
      if (!isPhoneLocationSharing) return;
      const now = Date.now();
      if (phoneLocationSendPromise || now - lastPhoneLocationSentAt < 15000) return;
      lastPhoneLocationSentAt = now;
      phoneLocationSendPromise = sendPhoneLocation(position)
        .catch(error => {
          if (!isPhoneLocationSharing) return;
          stopPhoneLocationWatch();
          phoneLocationHelp.textContent = error.message;
          notify('<strong>Phone location was not sent.</strong> Check connection and account access.');
        })
        .finally(() => { phoneLocationSendPromise = null; });
    }, error => {
      stopPhoneLocationWatch();
      const message = error.code === error.PERMISSION_DENIED
        ? 'Location permission was denied. Allow location for this site in Android settings and try again.'
        : error.code === error.TIMEOUT
          ? 'The phone could not get a location fix in time. Move outdoors and try again.'
          : 'The phone could not read its location. Check that Android Location is enabled.';
      phoneLocationHelp.textContent = message;
      notify(`<strong>Phone location unavailable.</strong> ${message}`);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });

  stopPhoneLocationButton.addEventListener('click', async () => {
    stopPhoneLocationWatch();
    startPhoneLocationButton.disabled = true;
    phoneLocationHelp.textContent = 'Phone location sharing stopped.';
    try {
      if (phoneLocationSendPromise) await phoneLocationSendPromise;
      await clearPhoneLocationOnServer();
    } catch (error) {
      phoneLocationHelp.textContent = `Sharing stopped on this phone, but the last point could not be cleared: ${error.message}`;
      notify('<strong>Could not clear the last phone location.</strong> It will become stale after the location timeout.');
    } finally {
      startPhoneLocationButton.disabled = false;
    }
  });

  function clearDeviceData() {
    latestDevice = null;
    document.getElementById('sosAlert').hidden = true;
    document.getElementById('heartRateValue').textContent = '—';
    document.getElementById('rosterHeartRate').textContent = '—';
    document.getElementById('movementValue').textContent = 'Waiting';
    document.getElementById('movementFoot').textContent = 'Waiting for Firebase data';
    document.getElementById('gpsValue').textContent = 'Waiting';
    document.getElementById('gpsFoot').textContent = 'Waiting for Firebase data';
    document.getElementById('loraValue').textContent = 'Waiting';
    document.getElementById('loraFoot').textContent = 'Waiting for Firebase data';
    document.getElementById('deviceLinkSummary').textContent = 'VB-01 · unknown';
    const sensorSentAt = document.getElementById('sensorSentAt');
    sensorSentAt.textContent = 'Waiting for data';
    sensorSentAt.removeAttribute('datetime');
    sensorSentAt.removeAttribute('title');
    const serverReceivedAt = document.getElementById('serverReceivedAt');
    serverReceivedAt.textContent = 'Not recorded';
    serverReceivedAt.removeAttribute('datetime');
    serverReceivedAt.removeAttribute('title');
    deviceActivityList.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'activity-empty',
      textContent: 'No readings available yet.'
    }));
    document.getElementById('deviceLastSeen').textContent = 'No readings received';
    document.getElementById('trendStatus').textContent = 'No historical readings available yet';
    document.getElementById('historyEmptyState').hidden = false;
    updateDeviceFreshness();
    if (heartChart) {
      heartChart.data.labels = [];
      heartChart.data.datasets[0].data = [];
      heartChart.update('none');
    }
    document.querySelector('.vitals-line').setAttribute('d', '');
    document.querySelector('.vitals-area').setAttribute('d', '');
    document.querySelector('.vitals-point').setAttribute('visibility', 'hidden');
    document.getElementById('trendStart').textContent = '—';
    document.getElementById('trendEnd').textContent = '—';
    if (deviceMarker) deviceMarker.getElement().hidden = true;
    if (markerAnimationFrame !== null) {
      cancelAnimationFrame(markerAnimationFrame);
      markerAnimationFrame = null;
    }
    routeCoordinates = [];
    lastGpsCoordinate = null;
    updateTrackingRoute();
  }

  function renderDeviceRecord(value) {
    const { device, history } = parseDeviceRecord(value);
    const previousSosRequestedAt = latestDevice?.sosEvent?.requestedAt;
    latestDevice = device;
    const sosAlert = document.getElementById('sosAlert');
    sosAlert.hidden = !device.sosEvent;
    if (device.sosEvent) {
      document.getElementById('sosReceivedAt').textContent =
        new Date(device.sosEvent.receivedAt).toLocaleString();
      if (hasRenderedDeviceRecord && previousSosRequestedAt !== device.sosEvent.requestedAt) {
        notify('<strong>SOS RECEIVED.</strong> A help request was received from VB-01.');
      }
    }
    hasRenderedDeviceRecord = true;
    document.getElementById('heartRateValue').textContent = device.heartRateBpm;
    document.getElementById('rosterHeartRate').textContent = device.heartRateBpm;
    document.getElementById('movementValue').textContent = ({
      stationary: 'No movement',
      moving: 'Moving',
      unknown: 'Unknown'
    })[device.movementStatus];
    document.getElementById('movementFoot').textContent = device.movementStatus === 'stationary'
      ? 'No movement detected'
      : `Movement status: ${device.movementStatus}`;
    document.getElementById('gpsValue').textContent = device.gps.status === 'fix' ? 'Fix acquired' : 'No GPS fix';
    document.getElementById('gpsFoot').textContent = device.gps.status === 'fix'
      ? `${device.gps.latitude.toFixed(4)}, ${device.gps.longitude.toFixed(4)}`
      : 'Waiting for GPS signal';
    document.getElementById('loraValue').textContent = device.loraStatus === 'receiving' ? 'Receiving' : 'Disconnected';
    document.getElementById('loraFoot').textContent = 'Last status reported by device';

    const updatedAt = new Date(device.updatedAt);
    const timestampOptions = {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    };
    const sensorSentAt = document.getElementById('sensorSentAt');
    sensorSentAt.textContent = updatedAt.toLocaleString([], timestampOptions);
    sensorSentAt.dateTime = updatedAt.toISOString();
    const serverReceivedAt = document.getElementById('serverReceivedAt');
    if (device.receivedAt) {
      const receivedAt = new Date(device.receivedAt);
      serverReceivedAt.textContent = receivedAt.toLocaleString([], timestampOptions);
      serverReceivedAt.dateTime = receivedAt.toISOString();
      serverReceivedAt.title = `Server received at ${receivedAt.toISOString()}`;
    } else {
      serverReceivedAt.textContent = 'Not recorded for this reading';
      serverReceivedAt.removeAttribute('datetime');
      serverReceivedAt.removeAttribute('title');
    }
    sensorSentAt.title = `Sensor timestamp: ${updatedAt.toISOString()}`;
    const recentHistory = history.slice(-12);
    if (heartChart) {
      heartChart.data.labels = recentHistory.map(reading =>
        new Date(reading.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      heartChart.data.datasets[0].data = recentHistory.map(reading => reading.heartRateBpm);
      heartChart.update('none');
    }
    document.getElementById('historyEmptyState').hidden = recentHistory.length > 0;
    document.getElementById('trendStart').textContent = recentHistory.length
      ? new Date(recentHistory[0].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
    document.getElementById('trendEnd').textContent = recentHistory.length
      ? new Date(recentHistory[recentHistory.length - 1].timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';

    const heartRates = recentHistory.map(reading => reading.heartRateBpm);
    const minimum = heartRates.length ? Math.min(...heartRates) - 5 : 30;
    const maximum = heartRates.length ? Math.max(...heartRates) + 5 : 220;
    if (heartChart) {
      heartChart.options.scales.y.min = heartRates.length ? Math.max(30, Math.floor(minimum / 10) * 10) : 30;
      heartChart.options.scales.y.max = heartRates.length ? Math.min(220, Math.ceil(maximum / 10) * 10) : 220;
      heartChart.update('none');
    }
    const trendPoints = recentHistory.map((reading, index) => {
      const x = recentHistory.length === 1 ? 480 : index * 480 / (recentHistory.length - 1);
      const y = 95 - (reading.heartRateBpm - minimum) / Math.max(1, maximum - minimum) * 80;
      return `${x.toFixed(1)} ${y.toFixed(1)}`;
    });
    const linePath = trendPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point}`).join(' ');
    document.querySelector('.vitals-line').setAttribute('d', linePath);
    document.querySelector('.vitals-area').setAttribute('d', linePath ? `${linePath} L480 110 L0 110 Z` : '');
    const trendMarker = document.querySelector('.vitals-point');
    if (trendPoints.length) {
      const lastPoint = trendPoints[trendPoints.length - 1].split(' ');
      trendMarker.setAttribute('cx', lastPoint[0]);
      trendMarker.setAttribute('cy', lastPoint[1]);
      trendMarker.setAttribute('visibility', 'visible');
    } else {
      trendMarker.setAttribute('visibility', 'hidden');
    }

    document.getElementById('deviceLastSeen').textContent = `Last seen ${updatedAt.toLocaleString()}`;
    const activity = document.createElement('p');
    activity.className = 'activity-empty';
    activity.textContent = `Latest reading from ${device.deviceId} at ${updatedAt.toLocaleString()}.`;
    deviceActivityList.replaceChildren(activity);
    document.getElementById('trendStatus').textContent = history.length
      ? 'Historical readings from Firebase'
      : 'No historical readings available yet';
    updateDeviceFreshness();
    setFirebaseStatus('DATABASE CONNECTED', true);
  }

  function reportDatabaseError(error) {
    if (!latestDevice) clearDeviceData();
    setFirebaseStatus('DATABASE UNAVAILABLE', false);
    console.error('Could not read VitaBand data from Firebase:', error);
  }

  async function refreshDeviceData() {
    try {
      const snapshot = await get(ref(database, 'devices/VB-01'));
      if (!snapshot.exists()) {
        clearDeviceData();
        setFirebaseStatus('DATABASE CONNECTED', true);
        return;
      }
      renderDeviceRecord(snapshot.val());
    } catch (error) {
      reportDatabaseError(error);
    }
  }

  async function checkOperatorDashboard(user) {
    const token = await user.getIdToken();
    const response = await fetch('/api/operator/status', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not verify account approval.');
    if (result.status !== 'admin' && result.status !== 'approved') {
      await signOut(auth);
      window.location.replace('/login.html?status=pending');
      return null;
    }
    return result.status;
  }

  onAuthStateChanged(auth, async user => {
    if (!user) {
      window.location.replace('/login.html');
      return;
    }
    renderOperatorName(user.displayName);
    try {
      const access = await checkOperatorDashboard(user);
      if (!access) return;
      isAdmin = access === 'admin';
      adminNotificationButton.hidden = !isAdmin;
      if (isAdmin) {
        await loadAdminRequests();

        if (adminRequestTimer) {
          clearInterval(adminRequestTimer);
        }

        adminRequestTimer = setInterval(loadAdminRequests, 30000);
      }
      try {
        const configResponse = await fetch('/api/config');
        if (!configResponse.ok) throw new Error('Could not load device freshness settings.');
        const config = await configResponse.json();
        if (Number.isSafeInteger(config.deviceStaleAfterMs) && config.deviceStaleAfterMs >= 1000) {
          deviceStaleAfterMs = config.deviceStaleAfterMs;
        }
      } catch (error) {
        console.error('Could not load device freshness settings:', error);
      }
      try {
        currentProfileDetails = await requestOperatorProfile('GET');
        currentProfilePhoto = currentProfileDetails.photo;
      } catch (error) {
        console.error('Could not load operator profile:', error);
      }
      renderOperatorName(user.displayName);
    } catch (error) {
      console.error('Could not check operator dashboard access:', error);
      window.location.replace('/login.html');
      return;
    }
    setFirebaseStatus('DATABASE CONNECTING', false);
    deviceFreshnessTimer = setInterval(updateDeviceFreshness, 5000);
    stopDeviceListener = onValue(ref(database, 'devices/VB-01'), snapshot => {
      if (!snapshot.exists()) {
        clearDeviceData();
        setFirebaseStatus('DATABASE CONNECTED', true);
        return;
      }
      try {
        renderDeviceRecord(snapshot.val());
      } catch (error) {
        reportDatabaseError(error);
      }
    }, reportDatabaseError);
    stopPhoneLocationListener = onValue(ref(database, 'deviceLocations/VB-01'), snapshot => {
      try {
        latestPhoneLocation = parsePhoneLocation(snapshot.exists() ? snapshot.val() : null);
        updateDeviceFreshness();
      } catch (error) {
        reportDatabaseError(error);
      }
    }, reportDatabaseError);
  }, error => {
    setFirebaseStatus('FIREBASE AUTH ERROR', false);
    console.error('Could not check Firebase operator session:', error);
  });
  window.addEventListener('pagehide', () => {
    if (stopDeviceListener) stopDeviceListener();
    if (stopPhoneLocationListener) stopPhoneLocationListener();
    if (adminRequestTimer) clearInterval(adminRequestTimer);
    if (deviceFreshnessTimer) clearInterval(deviceFreshnessTimer);
    if (isPhoneLocationSharing) stopPhoneLocationWatch();
  }, { once: true });

  document.getElementById('logoutButton')?.addEventListener('click', async () => {
    try {
      await signOut(auth);
      window.location.replace('/login.html');
    } catch (error) {
      notify('<strong>Could not sign out.</strong> Check your Firebase connection and try again.');
      console.error('Operator sign-out failed:', error);
    }
  });

  document.getElementById('editOperatorName')?.addEventListener('click', () => {
    const currentUser = auth.currentUser;
    if (!currentUser) {
      notify('<strong>Could not update name.</strong> Sign in again and retry.');
      return;
    }

    profileDialogName.value = currentUser.displayName || '';
    profileBirthday.value = currentProfileDetails.birthday || '';
    profilePosition.value = currentProfileDetails.position || '';
    profileGender.value = currentProfileDetails.gender || '';
    profilePhotoInput.value = '';
    pendingProfilePhoto = null;
    setProfilePhotoPreview(currentProfilePhoto);
    profileDialogError.hidden = true;
    openDialog(profileDialogBackdrop, document.getElementById('chooseProfilePhotoAvatar'));
  });

  profilePhotoInput.addEventListener('change', async () => {
    const file = profilePhotoInput.files?.[0];
    if (!file) return;
    profileDialogError.hidden = true;
    try {
      pendingProfilePhoto = await encodeProfilePhoto(file);
      setProfilePhotoPreview(pendingProfilePhoto);
    } catch (error) {
      pendingProfilePhoto = null;
      profilePhotoInput.value = '';
      setProfilePhotoPreview(currentProfilePhoto);
      profileDialogError.textContent = error.message;
      profileDialogError.hidden = false;
    }
  });
  chooseProfilePhoto.addEventListener('click', () => profilePhotoInput.click());
  chooseProfilePhotoAvatar.addEventListener('click', () => profilePhotoInput.click());

  profileDialogForm.addEventListener('submit', async event => {
    event.preventDefault();
    const currentUser = auth.currentUser;
    const trimmedName = profileDialogName.value.trim();
    if (!currentUser) {
      profileDialogError.textContent = 'Sign in again before changing your profile.';
      profileDialogError.hidden = false;
      return;
    }
    if (!trimmedName || trimmedName.length > 80) {
      profileDialogError.textContent = 'Enter a name between 1 and 80 characters.';
      profileDialogError.hidden = false;
      profileDialogName.focus();
      return;
    }

    saveProfileDialog.disabled = true;
    try {
      const updatedProfile = await requestOperatorProfile('PUT', {
        ...(pendingProfilePhoto ? { photo: pendingProfilePhoto } : {}),
        birthday: profileBirthday.value,
        position: profilePosition.value.trim(),
        gender: profileGender.value
      });
      currentProfileDetails = { ...currentProfileDetails, ...updatedProfile };
      currentProfilePhoto = currentProfileDetails.photo || null;
      pendingProfilePhoto = null;
      await updateProfile(currentUser, { displayName: trimmedName });
      renderOperatorName(trimmedName);
      closeDialog(profileDialogBackdrop);
      notify('<strong>Profile updated.</strong>');
    } catch (error) {
      profileDialogError.textContent = error.message || 'Could not update the profile. Check your connection and try again.';
      profileDialogError.hidden = false;
      console.error('Operator display name update failed:', error);
    } finally {
      saveProfileDialog.disabled = false;
    }
  });

  document.getElementById('refreshButton')?.addEventListener('click', refreshDeviceData);
  document.getElementById('settingsRefreshButton')?.addEventListener('click', () => {
    document.getElementById('refreshButton').click();
  });

  document.getElementById('mapViewButton')?.addEventListener('click', () => {
    const panel = document.querySelector('.map-panel');
    panel.classList.toggle('expanded');
    const expanded = panel.classList.contains('expanded');
    document.getElementById('mapViewButton').innerHTML = expanded
      ? '<i data-lucide="minimize-2"></i> Restore view'
      : '<i data-lucide="maximize-2"></i> Map view';
    if (window.lucide) window.lucide.createIcons();
    if (locationMap) requestAnimationFrame(() => locationMap.resize());
  });
  document.getElementById('settingsMapButton')?.addEventListener('click', () => {
    document.getElementById('mapViewButton').click();
    closeDialog(settingsBackdrop);
    requestAnimationFrame(() => document.getElementById('locations').scrollIntoView({ behavior: 'smooth' }));
  });
  document.getElementById('settingsThemeButton')?.addEventListener('click', () => {
    document.getElementById('themeToggle').click();
  });
  document.getElementById('closeSettings')?.addEventListener('click', () => closeDialog(settingsBackdrop));
  document.getElementById('closeHelp')?.addEventListener('click', () => closeDialog(helpBackdrop));

  document.getElementById('exportButton')?.addEventListener('click', () => {
    if (!latestDevice) {
      notify('<strong>No Firebase readings yet.</strong> There is no device status to export.');
      return;
    }
    const rows = [['Device ID','Heart Rate (BPM)','Movement','GPS','LoRa Link'],
      [latestDevice.deviceId, String(latestDevice.heartRateBpm), latestDevice.movementStatus,
        latestDevice.gps.status === 'fix'
          ? `${latestDevice.gps.latitude}, ${latestDevice.gps.longitude}`
          : 'No GPS fix',
        latestDevice.loraStatus]];
    const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'vitaband-device-status.csv';
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    notify('<strong>Device status exported.</strong> The download contains the latest Firebase reading.');
  });

  document.getElementById('showHistory')?.addEventListener('click', () => {
    document.getElementById('history').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  document.getElementById('menuToggle')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });

  const updateActiveNavigation = () => {
    const currentHash = window.location.hash;
    const isUtilityHash = currentHash === '#settings' || currentHash === '#help';
    const targetHash = activeUtilitySection ||
      (!isUtilityHash && currentHash && document.querySelector(currentHash) ? currentHash : '#overview');
    document.querySelectorAll('.nav-item').forEach(link => {
      const isActive = link.getAttribute('href') === targetHash;
      link.classList.toggle('active', isActive);
      if (isActive) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  };
  updateActiveNavigation();
  window.addEventListener('hashchange', updateActiveNavigation);

  document.querySelectorAll('.nav-item').forEach(link => {
    link.addEventListener('click', event => {
      const href = link.getAttribute('href');
      if (href === '#settings' || href === '#help') {
        event.preventDefault();
        const isSettings = href === '#settings';
        const backdrop = isSettings ? settingsBackdrop : helpBackdrop;
        activeUtilitySection = href;
        updateActiveNavigation();
        openDialog(backdrop, document.getElementById(isSettings ? 'closeSettings' : 'closeHelp'));
      }
      if (window.innerWidth <= 760) document.getElementById('sidebar').classList.remove('open');
    });
  });
});
