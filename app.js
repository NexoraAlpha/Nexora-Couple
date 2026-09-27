const C = window.NEXORA_COUPLE_CONFIG || {};

let sb = null;
let map = null;
let meMarker = null;
let partnerMarker = null;
let watchId = null;
let lastPos = null;
let sharing = false;
let myUser = null;
let myPair = null;
let partnerTimer = null;
let presenceTimer = null;
let durationTimer = null;
let presenceChannel = null;
let myProfile = null;

const $ = id => document.getElementById(id);

const toast = message => {
  const t = $('toast');
  if (!t) return;
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(t._x);
  t._x = setTimeout(() => t.classList.remove('show'), 2600);
};

function pageName() {
  const raw = (location.pathname.split('/').filter(Boolean).pop() || 'index').toLowerCase();
  const clean = raw.replace(/\.html$/, '');
  if (clean === 'location') return 'location';
  if (clean === 'couple') return 'couple';
  if (clean === 'settings') return 'settings';
  if (clean === 'auth') return 'auth';
  return 'home';
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function setOnline(id, online) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle('online', !!online);
  el.classList.toggle('on', !!online);
}

function setSharingUI(active) {
  sharing = !!active;
  document.querySelectorAll('#locationToggle').forEach(el => el.classList.toggle('on', sharing));
}

function isPaired() {
  // A pending pairing row (user_b = null) is NOT a paired account.
  // Only two distinct users count as connected.
  return !!(
    myPair?.user_a &&
    myPair?.user_b &&
    myPair.user_a !== myPair.user_b
  );
}

function initMap() {
  const el = $('map');
  if (!el || !window.L || map) return false;

  map = L.map(el, { zoomControl: false, attributionControl: true }).setView([-6.89, 109.38], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    minZoom: 2,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  setTimeout(() => map?.invalidateSize(), 100);
  return true;
}

function ensureLeaflet() {
  if (!$('map')) return;
  if (window.L) {
    initMap();
    return;
  }

  // Fallback CDN in case the first Leaflet CDN is temporarily unavailable.
  const cssId = 'leaflet-fallback-css';
  if (!document.getElementById(cssId)) {
    const link = document.createElement('link');
    link.id = cssId;
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(link);
  }

  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
  script.onload = () => {
    initMap();
    setTimeout(() => map?.invalidateSize(), 100);
  };
  script.onerror = () => toast('Map tidak dapat dimuat. Coba refresh jaringan.');
  document.head.appendChild(script);
}

function setConfig() {
  if (!window.supabase || !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return;
  const projectUrl = String(C.SUPABASE_URL)
    .replace(/\/rest\/v1\/?$/, '')
    .replace(/\/+$/, '');
  sb = supabase.createClient(projectUrl, C.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    }
  });
}

async function ensureAuth() {
  if (!sb) return false;

  try {
    const { data: sessionData } = await sb.auth.getSession();
    const user = sessionData?.session?.user;

    // NOVERA requires a permanent email account before any couple feature
    // can be used. Anonymous sessions are intentionally not accepted here.
    if (!user || user.is_anonymous) {
      location.href = './auth.html';
      return false;
    }

    myUser = user;
    return true;
  } catch (error) {
    console.warn('Auth failed:', error);
    location.href = './auth.html';
    return false;
  }
}

async function loadProfile() {
  if (!sb || !myUser) return;

  const { data, error } = await sb
    .from('couple_profiles')
    .select('display_name,avatar_data,email')
    .eq('user_id', myUser.id)
    .maybeSingle();

  if (error) {
    console.warn('Profile load failed:', error.message);
    return;
  }

  myProfile = data || { display_name: '', avatar_data: '', email: myUser.email || '' };
  const name = myProfile.display_name || myUser.user_metadata?.display_name || 'You';
  const avatar = myProfile.avatar_data || '';
  setText('meName', name);
  setText('settingsProfileName', name);
  setText('settingsProfileEmail', myUser.email || 'Akun tamu');
  setText('profileTriggerName', name);
  setText('profileMenuName', name);
  setText('profileMenuEmail', myUser.email || 'Akun tamu');
  setText('settingsAccountType', myUser.is_anonymous ? 'Guest' : 'Email account');
  setText('settingsAuthLabel', myUser.is_anonymous ? 'Akun tamu' : 'Email account');

  const initials = name.trim().slice(0, 1).toUpperCase() || 'J';
  document.querySelectorAll('[data-profile-avatar]').forEach(el => {
    el.textContent = avatar ? '' : initials;
    el.style.backgroundImage = avatar ? `url("${avatar}")` : '';
    el.classList.toggle('has-image', !!avatar);
  });

  const authLink = $('authLink');
  const logout = $('logoutAccount');
  const guestHint = $('guestAccountHint');
  if (authLink) authLink.style.display = myUser.is_anonymous ? 'inline-flex' : 'none';
  if (logout) logout.style.display = myUser.is_anonymous ? 'none' : 'inline-flex';
  if (guestHint) guestHint.textContent = myUser.is_anonymous
    ? 'Akun tamu tersimpan di perangkat ini. Login membuat akun yang bisa dipakai kembali.'
    : `Login sebagai ${myUser.email || 'akun email'}.`;
}

async function saveProfile() {
  if (!sb || !myUser) return;
  const name = ($('profileName')?.value || '').trim().slice(0, 40);
  const avatarInput = $('profilePhoto');
  let avatarData = myProfile?.avatar_data || '';

  if (avatarInput?.files?.[0]) {
    try { avatarData = await resizeAvatar(avatarInput.files[0]); }
    catch (_) { toast('Foto tidak dapat diproses.'); return; }
  }

  const { error } = await sb.from('couple_profiles').upsert({
    user_id: myUser.id,
    display_name: name || 'You',
    avatar_data: avatarData,
    email: myUser.email || null,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (error) { toast(error.message || 'Profil gagal disimpan.'); return; }
  await loadProfile();
  if (avatarInput) avatarInput.value = '';
  toast('Profil diperbarui.');
}

function resizeAvatar(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Invalid image'));
      img.onload = () => {
        const size = 512;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function logoutAccount() {
  if (!sb) return;
  await markOffline();
  const { error } = await sb.auth.signOut();
  if (error) { toast(error.message || 'Logout gagal.'); return; }
  location.href = './auth.html';
}

async function requestLeavePair() {
  if (!sb || !myUser) return;
  if (!isPaired()) { toast('Belum ada pasangan yang terhubung.'); return; }

  const { data, error } = await sb.rpc('request_leave_pair');
  if (error) { toast(error.message || 'Permintaan belum dapat dikirim.'); return; }

  if (data?.already_pending) {
    toast('Permintaan putus sudah menunggu persetujuan pasangan.');
  } else {
    toast('Permintaan putus dikirim. Menunggu persetujuan pasangan.');
  }
  await loadPair();
  await loadNotifications();
}

async function cancelLeaveRequest() {
  if (!sb || !myUser) return;
  const { error } = await sb.rpc('cancel_leave_pair');
  if (error) { toast(error.message || 'Permintaan gagal dibatalkan.'); return; }
  toast('Permintaan putus dibatalkan.');
  await loadPair();
}

async function respondLeaveRequest(approve) {
  if (!sb || !myUser) return;
  const { data, error } = await sb.rpc(approve ? 'approve_leave_pair' : 'reject_leave_pair');
  if (error) { toast(error.message || 'Respons gagal diproses.'); return; }
  toast(approve ? 'Pasangan berhasil diputus setelah persetujuan kedua pihak.' : 'Permintaan putus ditolak.');
  await loadPair();
  await loadPartner();
  await loadNotifications();
}

function setupProfileUI() {
  const trigger = $('profileTrigger');
  const menu = $('profileMenu');
  if (trigger && menu) {
    trigger.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !trigger.contains(e.target)) menu.classList.remove('open');
    }, { passive: true });
  }
  if ($('profileName')) $('profileName').value = myProfile?.display_name || '';
  if ($('saveProfile')) $('saveProfile').onclick = async () => {
    await saveProfile();
    menu?.classList.remove('open');
  };
  if ($('logoutAccount')) $('logoutAccount').onclick = logoutAccount;
}

function setupAuthPage() {
  if (!sb) return;
  const loginForm = $('loginForm');
  const registerForm = $('registerForm');
  const showLogin = $('showLogin');
  const showRegister = $('showRegister');
  const message = $('authMessage');

  const setMode = mode => {
    loginForm?.classList.toggle('hidden', mode !== 'login');
    registerForm?.classList.toggle('hidden', mode !== 'register');
    showLogin?.classList.toggle('active', mode === 'login');
    showRegister?.classList.toggle('active', mode === 'register');
    if (message) message.textContent = '';
  };

  showLogin?.addEventListener('click', () => setMode('login'));
  showRegister?.addEventListener('click', () => setMode('register'));

  loginForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('loginEmail')?.value.trim();
    const password = $('loginPassword')?.value || '';
    if (!email || !password) return;

    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (message) message.textContent = error.message;
      return;
    }
    location.href = './index.html';
  });

  registerForm?.addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('registerName')?.value.trim();
    const email = $('registerEmail')?.value.trim();
    const password = $('registerPassword')?.value || '';
    if (!name || !email || !password) return;
    if (password.length < 6) {
      if (message) message.textContent = 'Password minimal 6 karakter.';
      return;
    }

    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: name },
        emailRedirectTo: `${location.origin}/index.html`
      }
    });

    if (error) {
      if (message) message.textContent = error.message;
      return;
    }

    if (data?.session) {
      location.href = './index.html';
    } else if (message) {
      message.textContent = 'Akun dibuat. Cek email untuk verifikasi sebelum login.';
    }
  });
}

function updateSpeed(pos) {
  let s = pos.coords.speed;

  if (typeof s === 'number' && s >= 0) {
    s *= 3.6;
  } else if (lastPos) {
    const R = 6371000;
    const a = (pos.coords.latitude - lastPos.lat) * Math.PI / 180;
    const b = (pos.coords.longitude - lastPos.lng) * Math.PI / 180;
    const d = 2 * R * Math.asin(Math.sqrt(
      Math.sin(a / 2) ** 2 +
      Math.cos(lastPos.lat * Math.PI / 180) *
      Math.cos(pos.coords.latitude * Math.PI / 180) *
      Math.sin(b / 2) ** 2
    ));
    s = d / Math.max(1, (pos.timestamp - lastPos.time) / 1000) * 3.6;
  } else {
    s = 0;
  }

  s = Math.max(0, Number(s) || 0);
  setText('speed', s.toFixed(1));
  setText('movementState', s < 1 ? 'Stationary' : s < 7 ? 'Walking' : 'Moving');
  setText('movementHint', 'Kecepatan dihitung dari data lokasi perangkat.');

  lastPos = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    time: pos.timestamp
  };

  return s;
}

async function saveLocation(pos, speed) {
  if (!sb || !myUser || !isPaired()) return;

  const { error } = await sb.from('couple_locations').upsert({
    user_id: myUser.id,
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    speed_kmh: speed,
    updated_at: new Date().toISOString()
  }, { onConflict: 'user_id' });

  if (error) console.warn('Location save failed:', error.message);
  await savePresence();
}

function renderMyPosition(pos, speed) {
  const { latitude, longitude } = pos.coords;

  if (map) {
    if (!meMarker) {
      meMarker = L.marker([latitude, longitude]).addTo(map).bindPopup('You');
    } else {
      meMarker.setLatLng([latitude, longitude]);
    }

    if (!partnerMarker) map.setView([latitude, longitude], 15);
  }

  setText('locationText', `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
  setText('locationMeStatus', 'Online');
  setText('locationMeLast', 'Last active baru saja');
  setText('speed', speed.toFixed(1));
}

function usePosition(pos) {
  const speed = updateSpeed(pos);
  renderMyPosition(pos, speed);
  saveLocation(pos, speed).catch(error => console.warn(error));
}

function startLocationSharing(showToast = true) {
  if (sharing) return;

  if (!isPaired()) {
    toast('Hubungkan pasangan dulu sebelum membagikan lokasi.');
    return;
  }

  if (!navigator.geolocation) {
    toast('Browser tidak mendukung lokasi.');
    return;
  }

  sharing = true;
  localStorage.setItem('nexora_couple_location_sharing', '1');
  setSharingUI(true);

  watchId = navigator.geolocation.watchPosition(
    usePosition,
    error => {
      console.warn('Geolocation error:', error);
      stopLocationSharing(false);

      if (error?.code === 1) toast('Izin lokasi ditolak. Izinkan lokasi untuk fitur ini.');
      else if (error?.code === 2) toast('Lokasi perangkat belum tersedia.');
      else toast('Lokasi tidak dapat diperbarui. Coba lagi.');
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000
    }
  );

  if (showToast) toast('Location sharing aktif.');
}

function stopLocationSharing(showToast = true) {
  if (watchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
  }

  watchId = null;
  sharing = false;
  localStorage.removeItem('nexora_couple_location_sharing');
  setSharingUI(false);

  if (showToast) toast('Location sharing dimatikan.');
}

function toggleLocation() {
  if (sharing) stopLocationSharing();
  else startLocationSharing();
}

let pairTimerInterval = null;

function stopPairTimer() {
  if (pairTimerInterval) {
    clearInterval(pairTimerInterval);
    pairTimerInterval = null;
  }
}

function renderPairTimer(createdAt, code) {
  const timer = $('pairTimer');
  const codeEl = $('generatedCode');
  if (!timer || !codeEl) return;

  stopPairTimer();

  if (!createdAt || !code) {
    timer.hidden = true;
    return;
  }

  const update = () => {
    const elapsed = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);
    const remaining = Math.max(0, 300 - elapsed);
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    timer.textContent = remaining > 0 ? `Berakhir dalam ${minutes}:${seconds}` : 'Kode expired';
    timer.hidden = false;

    if (remaining <= 0) {
      stopPairTimer();
      codeEl.textContent = 'KODE EXPIRED';
      timer.classList.add('expired');
      const create = $('createPair');
      if (create) {
        create.disabled = false;
        create.textContent = 'Buat kode baru';
      }
    } else {
      timer.classList.remove('expired');
    }
  };

  update();
  pairTimerInterval = setInterval(update, 1000);
}

function generatePairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, n => alphabet[n % alphabet.length]).join('');
}

async function createCode() {
  if (!await ensureAuth()) return;

  if (isPaired()) {
    toast('Akun ini sudah terhubung.');
    return;
  }

  const code = generatePairCode();
  const { error } = await sb.rpc('create_pair', { p_code: code });

  if (error) {
    console.warn('create_pair failed:', error);
    toast(error.message || 'Kode pairing gagal dibuat.');
    return;
  }

  setText('generatedCode', code);
  renderPairTimer(new Date().toISOString(), code);
  const input = $('pairCode');
  if (input) input.value = '';

  try {
    await navigator.clipboard?.writeText(code);
  } catch (_) {}

  toast('Kode pairing dibuat.');
  await loadPair();
}

async function joinCode() {
  const input = $('pairCode');
  const code = input ? input.value.trim().toUpperCase() : '';

  if (code.length !== 6) {
    toast('Masukkan kode 6 karakter.');
    return;
  }

  if (!await ensureAuth()) return;

  if (isPaired()) {
    toast('Akun ini sudah terhubung.');
    return;
  }

  const { error } = await sb.rpc('join_pair', { p_code: code });

  if (error) {
    console.warn('join_pair failed:', error);
    toast(error.message || 'Kode pairing tidak dapat digunakan.');
    return;
  }

  toast('Pasangan berhasil terhubung.');
  if (input) input.value = '';

  await loadPair();
  await loadPartner();
}

async function loadPair() {
  if (!sb || !myUser) return;

  const { data, error } = await sb.rpc('my_pair');

  if (error) {
    console.warn('my_pair failed:', error.message);
    return;
  }

  myPair = data?.[0] || null;
  const paired = isPaired();
  const pending = myPair?.disconnect_status === 'pending';
  const requestedByMe = pending && myPair?.disconnect_requested_by === myUser?.id;

  setText('pairStatus', paired ? (pending ? 'Disconnect pending' : 'Paired') : 'Not paired');
  setText('partnerStatus', paired ? 'Offline' : 'Belum terhubung');
  setText('settingsPairStatus', paired ? (pending ? 'Disconnect pending' : 'Paired') : 'Not paired');
  setText('disconnectStatus', !pending ? '' : (requestedByMe ? 'Menunggu persetujuan pasangan.' : 'Pasangan meminta mengakhiri pairing.'));

  document.querySelectorAll('[data-disconnect-request]').forEach(el => {
    el.hidden = !pending;
  });
  const leaveBtn = $('leavePair');
  const cancelBtn = $('cancelLeavePair');
  if (leaveBtn) {
    leaveBtn.hidden = pending;
    leaveBtn.textContent = 'Ajukan putus';
  }
  if (cancelBtn) cancelBtn.hidden = !requestedByMe;

  if (myPair?.pair_code && !paired) {
    const createdAt = myPair.pair_code_created_at || myPair.created_at;
    const age = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;
    if (age >= 300000) {
      stopPairTimer();
      setText('generatedCode', 'KODE EXPIRED');
      const timer = $('pairTimer');
      if (timer) { timer.hidden = false; timer.textContent = 'Kode expired'; timer.classList.add('expired'); }
    } else {
      setText('generatedCode', myPair.pair_code);
      renderPairTimer(createdAt, myPair.pair_code);
    }
  } else {
    stopPairTimer();
    const timer = $('pairTimer');
    if (timer) timer.hidden = true;
  }

  const create = $('createPair');
  const join = $('joinPair');
  const input = $('pairCode');

  if (create) {
    create.disabled = paired;
    create.textContent = paired ? 'Sudah paired' : (myPair?.pair_code && myPair?.pair_code_created_at && (Date.now() - new Date(myPair.pair_code_created_at).getTime()) >= 300000 ? 'Buat kode baru' : 'Buat kode');
  }

  if (join) {
    join.disabled = paired;
  }

  if (input) {
    input.disabled = paired;
  }

  if (!paired && sharing) stopLocationSharing(false);
}

async function savePresence() {
  if (!sb || !myUser) return;

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const state = readPresenceActivity();

  // Accumulate only time between successful dashboard heartbeats. This makes
  // Phone presence persist across Home/Couple/Location navigation instead of
  // resetting to 0m every time a page is opened.
  if (state.lastTickAt) {
    const gap = Math.max(0, Math.min(30000, nowMs - state.lastTickAt));
    state.totalSeconds += gap / 1000;
  }
  state.day = presenceDayKey();
  state.lastTickAt = nowMs;
  writePresenceActivity(state);
  updateActiveDuration();

  const { error } = await sb.from('couple_presence').upsert({
    user_id: myUser.id,
    is_online: true,
    last_seen: now
  }, { onConflict: 'user_id' });

  if (error) {
    console.warn('Presence save failed:', error.message);
    return;
  }

  setText('meStatus', 'Online');
  setOnline('meDot', true);
  setText('meLast', 'baru saja');
  setText('locationMeStatus', 'Online');
  setText('locationMeLast', 'Last active baru saja');
}

async function markOffline() {
  if (!sb || !myUser) return;
  await sb.from('couple_presence').upsert({
    user_id: myUser.id,
    is_online: false,
    last_seen: new Date().toISOString()
  }, { onConflict: 'user_id' });
}

function haversine(a, b) {
  const R = 6371;
  const la = (b.lat - a.lat) * Math.PI / 180;
  const lo = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(la / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) *
    Math.cos(b.lat * Math.PI / 180) *
    Math.sin(lo / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(x));
}

function fitMapToMarkers() {
  if (!map) return;

  const points = [];
  if (meMarker) points.push(meMarker.getLatLng());
  if (partnerMarker) points.push(partnerMarker.getLatLng());

  if (points.length === 2) {
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
  } else if (points.length === 1) {
    map.setView(points[0], 15);
  }
}

async function loadPartner() {
  if (!sb || !myPair?.user_a || !myPair?.user_b) {
    setText('partnerName', 'Partner');
    setText('partnerStatus', 'Belum terhubung');
    setText('locationPartnerStatus', 'Belum terhubung');
    setText('partnerLast', '—');
    setText('locationPartnerLast', 'Last active —');
    setOnline('partnerDot', false);
    document.querySelectorAll('[data-partner-avatar]').forEach(el => {
      el.textContent = '?';
      el.style.backgroundImage = '';
      el.classList.remove('has-image');
    });
    return;
  }

  const { data, error } = await sb.rpc('partner_snapshot');

  if (error || !data?.[0]) {
    console.warn('partner_snapshot failed:', error?.message);
    return;
  }

  const p = data[0];
  const status = p.is_online ? 'Online' : 'Offline';

  const partnerName = p.display_name || 'Partner';
  setText('partnerName', partnerName);
  setText('partnerStatus', status);
  setOnline('partnerDot', p.is_online);
  setText('partnerLast', p.last_seen ? timeAgo(p.last_seen) : '—');
  setText('locationPartnerStatus', status);
  setText('locationPartnerLast', p.last_seen ? `Last active ${timeAgo(p.last_seen)}` : 'Last active —');
  document.querySelectorAll('[data-partner-avatar]').forEach(el => {
    el.textContent = p.avatar_data ? '' : (partnerName.trim().slice(0, 1).toUpperCase() || '?');
    el.style.backgroundImage = p.avatar_data ? `url("${p.avatar_data}")` : '';
    el.classList.toggle('has-image', !!p.avatar_data);
  });

  if (p.latitude != null && p.longitude != null) {
    setText('partnerLocation', `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`);

    if (map) {
      if (!partnerMarker) {
        partnerMarker = L.marker([p.latitude, p.longitude]).addTo(map).bindPopup('Partner');
      } else {
        partnerMarker.setLatLng([p.latitude, p.longitude]);
      }

      if (!meMarker) map.setView([p.latitude, p.longitude], 15);
    }

    if (lastPos) {
      setText('distance', haversine(
        { lat: lastPos.lat, lng: lastPos.lng },
        { lat: p.latitude, lng: p.longitude }
      ).toFixed(2) + ' km');
    }
  }

  fitMapToMarkers();
}

function timeAgo(value) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));

  if (sec < 60) return `${sec}s lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m lalu`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}j lalu`;
  return `${Math.floor(h / 24)}h lalu`;
}

function presenceDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function presenceStorageKey() {
  return myUser?.id ? `nexora_presence_${myUser.id}` : null;
}

function readPresenceActivity() {
  const key = presenceStorageKey();
  if (!key) return { day: presenceDayKey(), totalSeconds: 0, lastTickAt: 0 };

  try {
    const raw = JSON.parse(localStorage.getItem(key) || 'null');
    if (!raw || raw.day !== presenceDayKey()) {
      return { day: presenceDayKey(), totalSeconds: 0, lastTickAt: 0 };
    }
    return {
      day: raw.day,
      totalSeconds: Math.max(0, Number(raw.totalSeconds) || 0),
      lastTickAt: Math.max(0, Number(raw.lastTickAt) || 0)
    };
  } catch (_) {
    return { day: presenceDayKey(), totalSeconds: 0, lastTickAt: 0 };
  }
}

function writePresenceActivity(state) {
  const key = presenceStorageKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch (_) {}
}

function updateActiveDuration() {
  const state = readPresenceActivity();
  let seconds = state.totalSeconds;

  // Only count a short gap since the last heartbeat. A closed/backgrounded
  // tab must not keep accumulating "active" time while the app is unused.
  if (state.lastTickAt) {
    const gap = Math.max(0, Math.min(30000, Date.now() - state.lastTickAt));
    seconds += gap / 1000;
  }

  const mins = Math.floor(seconds / 60);
  setText('activeDuration', `${mins}m`);
}

function startTimers() {
  clearInterval(presenceTimer);
  clearInterval(partnerTimer);
  clearInterval(durationTimer);

  savePresence().catch(() => {});
  updateActiveDuration();

  presenceTimer = setInterval(() => {
    savePresence().catch(() => {});
  }, 15000);

  // Keep the Phone presence counter in sync even when no database write is
  // needed yet (the displayed value is still based on the heartbeat clock).
  durationTimer = setInterval(updateActiveDuration, 1000);

  partnerTimer = setInterval(() => {
    loadPair().then(loadPartner).catch(() => {});
  }, 5000);
}

async function loadNotifications() {
  if (!sb || !myUser) return;
  const { data, error } = await sb
    .from('couple_notifications')
    .select('id,type,title,body,data,read_at,created_at')
    .eq('user_id', myUser.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { console.warn('Notifications load failed:', error.message); return; }

  const list = $('notificationList');
  const badge = $('notificationBadge');
  const unread = (data || []).filter(n => !n.read_at).length;
  if (badge) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.hidden = unread === 0; }
  if (!list) return;

  if (!data?.length) {
    list.innerHTML = '<div class="notification-empty">Belum ada notifikasi.</div>';
    return;
  }

  list.innerHTML = data.map(n => {
    const action = n.type === 'disconnect_request' ? `
      <div class="notification-actions">
        <button class="btn small notification-approve" data-notification-id="${n.id}">Setujui</button>
        <button class="btn small notification-reject" data-notification-id="${n.id}">Tolak</button>
      </div>` : '';
    return `<article class="notification-item ${n.read_at ? '' : 'unread'}">
      <div><strong>${escapeHtml(n.title || 'Notifikasi')}</strong><p>${escapeHtml(n.body || '')}</p><small>${timeAgo(n.created_at)}</small></div>${action}
    </article>`;
  }).join('');

  list.querySelectorAll('.notification-approve').forEach(btn => btn.onclick = async () => { await respondLeaveRequest(true); });
  list.querySelectorAll('.notification-reject').forEach(btn => btn.onclick = async () => { await respondLeaveRequest(false); });
}

async function markNotificationsRead() {
  if (!sb || !myUser) return;
  await sb.from('couple_notifications').update({ read_at: new Date().toISOString() }).eq('user_id', myUser.id).is('read_at', null);
  await loadNotifications();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;',"\"":'&quot;'}[c]));
}

function setupNotifications() {
  const button = $('notificationButton');
  const panel = $('notificationPanel');
  button?.addEventListener('click', async e => {
    e.stopPropagation();
    panel?.classList.toggle('open');
    if (panel?.classList.contains('open')) await markNotificationsRead();
  });
  document.addEventListener('click', e => {
    if (panel && !panel.contains(e.target) && !button?.contains(e.target)) panel.classList.remove('open');
  });
  $('notificationMarkRead')?.addEventListener('click', markNotificationsRead);
}

function setupNav() {
  const path = pageName();

  document.querySelectorAll('.bottom-nav .nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.page === path);
  });
}

function setupButtons() {
  document.querySelectorAll('#locationToggle').forEach(el => {
    el.onclick = toggleLocation;
  });

  if ($('createPair')) $('createPair').onclick = createCode;
  if ($('joinPair')) $('joinPair').onclick = joinCode;

  if ($('pairCode')) {
    $('pairCode').addEventListener('input', e => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    });

    $('pairCode').addEventListener('keydown', e => {
      if (e.key === 'Enter') joinCode();
    });
  }

  if ($('refreshBtn')) {
    $('refreshBtn').onclick = async () => {
      await loadPair();
      await loadPartner();

      if (map) {
        setTimeout(() => map.invalidateSize(), 80);
        fitMapToMarkers();
      }

      toast('Data diperbarui.');
    };
  }

  if ($('centerMap')) {
    $('centerMap').onclick = () => {
      if (meMarker || partnerMarker) fitMapToMarkers();
      else toast('Belum ada lokasi yang dibagikan.');
    };
  }
}

function restoreSharingState() {
  // We remember the preference, but only resume after pairing and permission
  // are confirmed. This avoids silently requesting location on page load.
  if (localStorage.getItem('nexora_couple_location_sharing') !== '1') {
    setSharingUI(false);
    return;
  }

  setSharingUI(false);
}

function setupLifecycle() {
  window.addEventListener('beforeunload', () => {
    // Best effort only; the SQL snapshot also treats stale heartbeats as offline.
    markOffline();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      savePresence().catch(() => {});
      loadPair().then(loadPartner).catch(() => {});
    }
  });
}

async function start() {
  const page = pageName();

  setConfig();

  if (!sb) {
    toast('Config Supabase belum tersedia.');
    return;
  }

  if (page === 'auth') {
    setupAuthPage();
    const { data } = await sb.auth.getSession();
    if (data?.session?.user && !data.session.user.is_anonymous) {
      location.href = './index.html';
    }
    return;
  }

  setupNav();
  setupButtons();
  setupLifecycle();
  setupNotifications();
  restoreSharingState();

  if (!(await ensureAuth())) return;

  if (page === 'location' && $('map')) {
    ensureLeaflet();
  }

  await loadProfile();
  setupProfileUI();
  await loadPair();
  await loadPartner();
  await loadNotifications();
  startTimers();

  if (sharing && isPaired()) startLocationSharing(false);

  if (map) {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

start();
