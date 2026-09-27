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

const $ = id => document.getElementById(id);
const toast = m => {
  const t = $('toast');
  if (!t) return;
  t.textContent = m;
  t.classList.add('show');
  clearTimeout(t._x);
  t._x = setTimeout(() => t.classList.remove('show'), 2400);
};

function pageName() {
  const p = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (p === 'location.html') return 'location';
  if (p === 'couple.html') return 'couple';
  if (p === 'settings.html') return 'settings';
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
  el.classList.toggle('on', !!online); // backward compatibility with the original CSS/markup
}

function initMap() {
  const el = $('map');
  if (!el || !window.L) return;
  map = L.map(el, { zoomControl: false }).setView([-6.9, 109.37], 13);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
}

function setConfig() {
  if (!window.supabase || !C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return;
  // Supabase JS expects the project URL, not the REST endpoint.
  const projectUrl = String(C.SUPABASE_URL).replace(/\/rest\/v1\/?$/, '');
  sb = supabase.createClient(projectUrl, C.SUPABASE_ANON_KEY);
}

async function ensureAuth() {
  if (!sb) return false;
  const sessionResult = await sb.auth.getSession();
  const session = sessionResult?.data?.session;
  if (session?.user) {
    myUser = session.user;
    return true;
  }
  const { data, error } = await sb.auth.signInAnonymously();
  if (error) {
    toast('Anonymous Sign-ins belum aktif di Supabase.');
    return false;
  }
  myUser = data.user;
  return true;
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

  setText('speed', s.toFixed(1));
  setText('movementState', s < 1 ? 'Stationary' : s < 7 ? 'Walking' : 'Moving');
  setText('movementHint', 'Kecepatan dihitung dari data lokasi perangkat.');
  lastPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, time: pos.timestamp };
  return s;
}

async function saveLocation(pos, speed) {
  if (!sb || !myUser) return;
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

function usePosition(pos) {
  const { latitude, longitude } = pos.coords;
  const speed = updateSpeed(pos);

  if (map) {
    if (!meMarker) meMarker = L.marker([latitude, longitude]).addTo(map).bindPopup('You');
    else meMarker.setLatLng([latitude, longitude]);
    map.setView([latitude, longitude], 15);
  }

  setText('locationText', `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
  setText('locationMeStatus', 'Online');
  setText('locationMeLast', 'Last active baru saja');
  saveLocation(pos, speed).catch(err => console.warn(err));
}

function startLocationSharing(showToast = true) {
  if (sharing) return;
  if (!navigator.geolocation) {
    toast('Browser tidak mendukung lokasi.');
    return;
  }
  sharing = true;
  localStorage.setItem('nexora_couple_location_sharing', '1');
  document.querySelectorAll('#locationToggle').forEach(el => el.classList.add('on'));
  watchId = navigator.geolocation.watchPosition(
    usePosition,
    () => {
      sharing = false;
      localStorage.removeItem('nexora_couple_location_sharing');
      document.querySelectorAll('#locationToggle').forEach(el => el.classList.remove('on'));
      toast('Izin lokasi belum diberikan.');
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
  if (showToast) toast('Location sharing aktif');
}

function stopLocationSharing(showToast = true) {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  sharing = false;
  localStorage.removeItem('nexora_couple_location_sharing');
  document.querySelectorAll('#locationToggle').forEach(el => el.classList.remove('on'));
  if (showToast) toast('Location sharing dimatikan');
}

function toggleLocation() {
  if (sharing) stopLocationSharing();
  else startLocationSharing();
}

async function createCode() {
  if (!await ensureAuth()) return;
  const code = Math.random().toString(36).slice(2, 8).toUpperCase();
  const { error } = await sb.rpc('create_pair', { p_code: code });
  if (error) {
    return toast(error.message.includes('already') || error.message.includes('already paired')
      ? 'Akun ini sudah terhubung.'
      : error.message);
  }
  setText('generatedCode', code);
  navigator.clipboard?.writeText(code).catch(() => {});
  toast('Kode pairing dibuat & disalin.');
  await loadPair();
}

async function joinCode() {
  const input = $('pairCode');
  const code = input ? input.value.trim().toUpperCase() : '';
  if (code.length !== 6) return toast('Masukkan kode 6 karakter.');
  if (!await ensureAuth()) return;
  const { error } = await sb.rpc('join_pair', { p_code: code });
  if (error) return toast(error.message);
  toast('Pasangan berhasil terhubung.');
  await loadPair();
  await loadPartner();
}

async function loadPair() {
  if (!sb) return;
  const { data, error } = await sb.rpc('my_pair');
  if (error) {
    console.warn('my_pair failed:', error.message);
    return;
  }
  myPair = data?.[0] || null;
  const paired = !!(myPair?.user_a && myPair?.user_b);
  setText('pairStatus', paired ? 'Paired' : 'Not paired');
  setText('partnerStatus', paired ? 'Connected' : 'Belum terhubung');
  if (myPair?.pair_code && !paired) setText('generatedCode', myPair.pair_code);
  setText('settingsPairStatus', paired ? 'Paired' : 'Not paired');
}

async function savePresence() {
  if (!sb || !myUser) return;
  const { error } = await sb.from('couple_presence').upsert({
    user_id: myUser.id,
    is_online: true,
    last_seen: new Date().toISOString()
  }, { onConflict: 'user_id' });
  if (error) console.warn('Presence save failed:', error.message);
  setText('meStatus', 'Online');
  setOnline('meDot', true);
  setText('meLast', 'baru saja');
  setText('locationMeStatus', 'Online');
  setText('locationMeLast', 'Last active baru saja');
}

function haversine(a, b) {
  const R = 6371;
  const la = (b.lat - a.lat) * Math.PI / 180;
  const lo = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(la / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(lo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function loadPartner() {
  if (!sb || !myPair?.user_a || !myPair?.user_b) return;
  const { data, error } = await sb.rpc('partner_snapshot');
  if (error || !data?.[0]) return;
  const p = data[0];
  const status = p.is_online ? 'Online' : 'Offline';
  setText('partnerStatus', status);
  setOnline('partnerDot', p.is_online);
  setText('partnerLast', p.last_seen ? timeAgo(p.last_seen) : '—');
  setText('locationPartnerStatus', status);
  setText('locationPartnerLast', p.last_seen ? `Last active ${timeAgo(p.last_seen)}` : 'Last active —');

  if (p.latitude != null && p.longitude != null) {
    setText('partnerLocation', `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`);
    if (map) {
      if (!partnerMarker) partnerMarker = L.marker([p.latitude, p.longitude]).addTo(map).bindPopup('Partner');
      else partnerMarker.setLatLng([p.latitude, p.longitude]);
    }
    if (lastPos) setText('distance', haversine(
      { lat: lastPos.lat, lng: lastPos.lng },
      { lat: p.latitude, lng: p.longitude }
    ).toFixed(2) + ' km');
  }
}

function timeAgo(v) {
  const sec = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000));
  if (sec < 60) return `${sec}s lalu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m lalu`;
  const h = Math.floor(min / 60);
  return `${h}j lalu`;
}

function startTimers() {
  clearInterval(presenceTimer);
  clearInterval(partnerTimer);
  savePresence().catch(() => {});
  presenceTimer = setInterval(() => savePresence().catch(() => {}), 30000);
  partnerTimer = setInterval(() => loadPartner().catch(() => {}), 5000);
}

function setupNav() {
  const path = pageName();
  document.querySelectorAll('.bottom-nav .nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === path);
  });
}

function setupButtons() {
  document.querySelectorAll('#locationToggle').forEach(el => {
    el.onclick = toggleLocation;
  });
  if ($('createPair')) $('createPair').onclick = createCode;
  if ($('joinPair')) $('joinPair').onclick = joinCode;
  if ($('refreshBtn')) $('refreshBtn').onclick = async () => {
    await loadPair();
    await loadPartner();
    if (map) setTimeout(() => map.invalidateSize(), 50);
    toast('Data diperbarui.');
  };
  if ($('centerMap')) $('centerMap').onclick = () => {
    if (meMarker && map) map.setView(meMarker.getLatLng(), 15);
    else toast('Aktifkan lokasi dulu.');
  };
}

function restoreSharingState() {
  if (localStorage.getItem('nexora_couple_location_sharing') === '1') {
    // Do not silently request location permission on every page load.
    // The user can turn it on from the visible switch again.
    sharing = false;
    document.querySelectorAll('#locationToggle').forEach(el => el.classList.remove('on'));
  }
}

async function start() {
  const page = pageName();
  setConfig();
  setupNav();
  setupButtons();
  restoreSharingState();

  if (page === 'location' && $('map')) {
    initMap();
    setTimeout(() => map?.invalidateSize(), 100);
  }

  if (!sb) {
    toast('Mode preview aktif — config Supabase belum terisi.');
    return;
  }

  if (await ensureAuth()) {
    await loadPair();
    if (page === 'home' || page === 'location' || page === 'couple' || page === 'settings') {
      startTimers();
      await loadPartner();
    }
  }
}

start();
