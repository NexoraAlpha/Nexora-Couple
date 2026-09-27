const C = window.NEXORA_COUPLE_CONFIG || {};
let sb = null, map = null, meMarker = null, partnerMarker = null, watchId = null, lastPos = null, sharing = false;
let myUser = null, myPair = null, partnerTimer = null, presenceTimer = null;
const $ = id => document.getElementById(id);
const toast = m => { const t=$('toast'); if(!t) return; t.textContent=m; t.classList.add('show'); clearTimeout(t._x); t._x=setTimeout(()=>t.classList.remove('show'),2400); };

function initMap(){
  map=L.map('map',{zoomControl:false}).setView([-6.9,109.37],13);
  L.control.zoom({position:'bottomright'}).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
}
function setConfig(){
  if(C.SUPABASE_URL && C.SUPABASE_ANON_KEY && window.supabase) sb=supabase.createClient(C.SUPABASE_URL,C.SUPABASE_ANON_KEY);
}
async function ensureAuth(){
  if(!sb) return false;
  const {data:{session}}=await sb.auth.getSession();
  if(session?.user){ myUser=session.user; return true; }
  const {data,error}=await sb.auth.signInAnonymously();
  if(error){ toast('Aktifkan Anonymous Sign-ins di Supabase.'); return false; }
  myUser=data.user; return true;
}
function updateSpeed(pos){
  let s=pos.coords.speed;
  if(typeof s==='number'&&s>=0) s*=3.6;
  else if(lastPos){
    const R=6371000,a=(pos.coords.latitude-lastPos.lat)*Math.PI/180,b=(pos.coords.longitude-lastPos.lng)*Math.PI/180;
    const d=2*R*Math.asin(Math.sqrt(Math.sin(a/2)**2+Math.cos(lastPos.lat*Math.PI/180)*Math.cos(pos.coords.latitude*Math.PI/180)*Math.sin(b/2)**2));
    s=d/Math.max(1,(pos.timestamp-lastPos.time)/1000)*3.6;
  } else s=0;
  $('speed').textContent=s.toFixed(1);
  $('movementState').textContent=s<1?'Stationary':s<7?'Walking':'Moving';
  lastPos={lat:pos.coords.latitude,lng:pos.coords.longitude,time:pos.timestamp};
  return s;
}
async function saveLocation(pos,speed){
  if(!sb||!myUser) return;
  await sb.from('couple_locations').upsert({user_id:myUser.id,latitude:pos.coords.latitude,longitude:pos.coords.longitude,speed_kmh:speed,updated_at:new Date().toISOString()},{onConflict:'user_id'});
  await savePresence();
}
function usePosition(pos){
  const {latitude,longitude}=pos.coords; const speed=updateSpeed(pos);
  if(!meMarker) meMarker=L.marker([latitude,longitude]).addTo(map).bindPopup('You'); else meMarker.setLatLng([latitude,longitude]);
  map.setView([latitude,longitude],15);
  $('locationText').textContent=`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  saveLocation(pos,speed).catch(()=>{});
}
function toggleLocation(){
  sharing=!sharing; $('locationToggle').classList.toggle('on',sharing);
  if(sharing){
    if(!navigator.geolocation) return toast('Browser tidak mendukung lokasi.');
    watchId=navigator.geolocation.watchPosition(usePosition,()=>toast('Izin lokasi belum diberikan.'),{enableHighAccuracy:true,maximumAge:5000,timeout:15000});
    toast('Location sharing aktif');
  } else { if(watchId!==null) navigator.geolocation.clearWatch(watchId); watchId=null; toast('Location sharing dimatikan'); }
}
async function createCode(){
  if(!await ensureAuth()) return;
  const code=Math.random().toString(36).slice(2,8).toUpperCase();
  const {error}=await sb.rpc('create_pair',{p_code:code});
  if(error) return toast(error.message.includes('already')?'Akun ini sudah terhubung.':error.message);
  $('generatedCode').textContent=code; navigator.clipboard?.writeText(code); toast('Kode pairing dibuat & disalin.'); await loadPair();
}
async function joinCode(){
  const code=$('pairCode').value.trim().toUpperCase();
  if(code.length!==6) return toast('Masukkan kode 6 karakter.');
  if(!await ensureAuth()) return;
  const {error}=await sb.rpc('join_pair',{p_code:code});
  if(error) return toast(error.message);
  toast('Pasangan berhasil terhubung.'); await loadPair(); await loadPartner();
}
async function loadPair(){
  if(!sb) return;
  const {data,error}=await sb.rpc('my_pair'); if(error) return;
  myPair=data?.[0]||null;
  const paired=!!(myPair?.user_a&&myPair?.user_b);
  $('pairStatus').textContent=paired?'Paired':'Waiting for partner';
  $('partnerStatus').textContent=paired?'Connected':'Belum terhubung';
  if(myPair?.pair_code && !paired) $('generatedCode').textContent=myPair.pair_code;
}
async function savePresence(){
  if(!sb||!myUser) return;
  await sb.from('couple_presence').upsert({user_id:myUser.id,is_online:true,last_seen:new Date().toISOString()},{onConflict:'user_id'});
  $('meStatus').textContent='Online'; $('meDot').classList.add('on'); $('meLast').textContent='baru saja';
}
function haversine(a,b){const R=6371,la=(b.lat-a.lat)*Math.PI/180,lo=(b.lng-a.lng)*Math.PI/180,x=Math.sin(la/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(lo/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
async function loadPartner(){
  if(!sb||!myPair?.user_a||!myPair?.user_b) return;
  const {data,error}=await sb.rpc('partner_snapshot'); if(error||!data?.[0]) return;
  const p=data[0]; $('partnerStatus').textContent=p.is_online?'Online':'Offline'; $('partnerDot').classList.toggle('on',!!p.is_online); $('partnerLast').textContent=p.last_seen?timeAgo(p.last_seen):'—';
  if(p.latitude!=null&&p.longitude!=null){
    $('partnerLocation').textContent=`${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`;
    if(!partnerMarker) partnerMarker=L.marker([p.latitude,p.longitude]).addTo(map).bindPopup('Partner'); else partnerMarker.setLatLng([p.latitude,p.longitude]);
    if(lastPos){$('distance').textContent=haversine({lat:lastPos.lat,lng:lastPos.lng},{lat:p.latitude,lng:p.longitude}).toFixed(2)+' km';}
  }
}
function timeAgo(v){const sec=Math.max(0,Math.floor((Date.now()-new Date(v).getTime())/1000)); if(sec<60)return `${sec}s lalu`; const min=Math.floor(sec/60); if(min<60)return `${min}m lalu`; const h=Math.floor(min/60); return `${h}j lalu`;}
function startTimers(){
  savePresence().catch(()=>{});
  presenceTimer=setInterval(()=>savePresence().catch(()=>{}),30000);
  partnerTimer=setInterval(()=>loadPartner().catch(()=>{}),5000);
}
function setupNav(){
  const path=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  const page=path==='location.html'?'location':path==='couple.html'?'couple':path==='settings.html'?'settings':'home';
  document.querySelectorAll('.bottom-nav .nav-link').forEach(a=>{
    a.classList.toggle('active',a.dataset.page===page);
  });
}
async function start(){
  const path=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  const page=path==='location.html'?'location':path==='couple.html'?'couple':path==='settings.html'?'settings':'home';
  setConfig(); setupNav();

  if(page==='location' && $('map')) initMap();

  if($('locationToggle')) $('locationToggle').onclick=toggleLocation;
  if($('createPair')) $('createPair').onclick=createCode;
  if($('joinPair')) $('joinPair').onclick=joinCode;
  if($('refreshBtn')) $('refreshBtn').onclick=async()=>{
    await loadPair(); await loadPartner();
    if(map) map.invalidateSize();
    toast('Data diperbarui.');
  };
  if($('centerMap')) $('centerMap').onclick=()=>{
    if(meMarker && map) map.setView(meMarker.getLatLng(),15);
    else toast('Aktifkan lokasi dulu.');
  };

  if(!sb){
    toast('Mode preview aktif — config Supabase belum terisi.');
    return;
  }

  if(await ensureAuth()){
    await loadPair();
    if(page==='location' || page==='home' || page==='couple') startTimers();
    if(page==='location') await loadPartner();
    if(page==='home') await loadPartner();
    if(page==='settings' && $('settingsPairStatus')) $('settingsPairStatus').textContent=$('pairStatus')?.textContent||'Not paired';
  }
}
start();
