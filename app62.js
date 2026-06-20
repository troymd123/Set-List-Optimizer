// ─────────────────────────────────────────────────────────────────────────────
// SETLIST OPTIMIZER — PWA  (with Spotify import)
// ─────────────────────────────────────────────────────────────────────────────

const VOCAL_OPTIONS = ['Male', 'Female', 'Mixed'];
const MUSICAL_KEYS = [
  'C','C#','D','D#','E','F','F#','G','G#','A','A#','B',
  'Cm','C#m','Dm','D#m','Em','Fm','F#m','Gm','G#m','Am','A#m','Bm'
];
const GENRE_COLORS = {
  Rock:'#e85d3a', Pop:'#e8a63a', 'R&B':'#a63ae8', Country:'#3ae8a6',
  Jazz:'#3a9ee8', Folk:'#8ee83a', Electronic:'#e83ab5', 'Hip-Hop':'#e8e83a',
  Soul:'#e8683a', Blues:'#3ae8e8', Other:'#888'
};
const CAMELOT = {
  'C':'8B','C#':'3B','D':'10B','D#':'5B','E':'12B','F':'7B','F#':'2B',
  'G':'9B','G#':'4B','A':'11B','A#':'6B','B':'1B',
  'Cm':'5A','C#m':'12A','Dm':'7A','D#m':'2A','Em':'9A','Fm':'4A',
  'F#m':'11A','Gm':'6A','G#m':'1A','Am':'8A','A#m':'3A','Bm':'10A'
};
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
// Cloudflare Worker proxy for Spotify token exchange (avoids CORS block on GitHub Pages)
// After deploying worker.js to Cloudflare, replace this URL with your worker URL
const SPOTIFY_PROXY  = 'https://setlist-spotify.troymd123.workers.dev';
const SPOTIFY_TOKEN  = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API    = 'https://api.spotify.com/v1';
const MODEL          = 'claude-sonnet-4-5';
const BANDS_KEY        = 'setlist_bands_v1'; // list of band names
const ACTIVE_BAND_KEY  = 'setlist_active_band_v1';
const BACKUP_KEY_PREFIX= 'setlist_backup_v1_'; // per-band backup

// Per-band storage keys
const songsKeyFor   = band => 'setlist_songs_v2_' + band;
const setlistsKeyFor= band => 'setlist_saved_v1_' + band;
const backupKeyFor  = band => BACKUP_KEY_PREFIX + band;

const loadBands = () => {
  try {
    const bands = JSON.parse(localStorage.getItem(BANDS_KEY));
    if (bands?.length) return bands;
  } catch(e) {}
  // Migrate legacy single-library data into a default "My Band"
  const legacySongs = (()=>{ try{return JSON.parse(localStorage.getItem('setlist_songs_v2'))||[];}catch(e){return[];} })();
  const legacySetlists = (()=>{ try{return JSON.parse(localStorage.getItem('setlist_saved_v1'))||[];}catch(e){return[];} })();
  const defaultBand = 'My Band';
  localStorage.setItem(BANDS_KEY, JSON.stringify([defaultBand]));
  if (legacySongs.length) localStorage.setItem(songsKeyFor(defaultBand), JSON.stringify(legacySongs));
  if (legacySetlists.length) localStorage.setItem(setlistsKeyFor(defaultBand), JSON.stringify(legacySetlists));
  return [defaultBand];
};
const saveBands = bands => { try{localStorage.setItem(BANDS_KEY,JSON.stringify(bands));}catch(e){} };
const getActiveBand = () => localStorage.getItem(ACTIVE_BAND_KEY) || loadBands()[0] || 'My Band';
const setActiveBand = name => { try{localStorage.setItem(ACTIVE_BAND_KEY,name);}catch(e){} };

const loadFromStorage = (band) => {
  band = band || getActiveBand();
  try {
    const primary = JSON.parse(localStorage.getItem(songsKeyFor(band)));
    if (primary?.length) return primary;
    const backup = JSON.parse(localStorage.getItem(backupKeyFor(band)));
    if (backup?.length) { localStorage.setItem(songsKeyFor(band), JSON.stringify(backup)); return backup; }
    return [];
  } catch(e) { return []; }
};
const saveToStorage = (songs, band) => {
  band = band || getActiveBand();
  try {
    const data = JSON.stringify(songs);
    localStorage.setItem(songsKeyFor(band), data);
    localStorage.setItem(backupKeyFor(band), data);
  } catch(e) {}
};
const loadSavedSetlists = (band) => { band=band||getActiveBand(); try{return JSON.parse(localStorage.getItem(setlistsKeyFor(band)))||[];}catch(e){return[];} };
const saveSavedSetlists = (sl, band) => { band=band||getActiveBand(); try{localStorage.setItem(setlistsKeyFor(band),JSON.stringify(sl));}catch(e){} };
const API_KEY_STORE  = 'setlist_api_key';
const SP_CLIENT_STORE= 'sp_client_id';
const SP_SECRET_STORE= 'sp_client_secret';

// ── Helpers ───────────────────────────────────────────────────────────────────
let _id = Date.now();
const mkId = () => `s_${_id++}`;

const parseDuration = str => {
  if (!str) return 0;
  const p = String(str).split(':').map(Number);
  return p.length === 2 ? p[0]*60+p[1] : parseInt(str)||0;
};
const formatTotal = s => {
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h>0 ? `${h}h ${m}m` : `${m}m ${sec}s`;
};
const totalDuration = songs => songs.reduce((a,s)=>a+parseDuration(s.duration),0);
const camelotCompat = (k1,k2) => {
  if (!k1||!k2) return 'unknown';
  const c1=CAMELOT[k1],c2=CAMELOT[k2];
  if (!c1||!c2) return 'unknown';
  if (c1===c2) return 'perfect';
  const n1=parseInt(c1),n2=parseInt(c2),l1=c1.slice(-1),l2=c2.slice(-1);
  if (l1===l2&&(Math.abs(n1-n2)===1||(n1===1&&n2===12)||(n1===12&&n2===1))) return 'good';
  if (l1!==l2&&n1===n2) return 'good';
  return 'poor';
};
const compatColor = c => c==='perfect'?'#3ae8a6':c==='good'?'#e8a63a':'#e85d3a';
const gcColor = g => GENRE_COLORS[g]||GENRE_COLORS.Other;


// ── Anthropic API ─────────────────────────────────────────────────────────────
const callAI = async (prompt, maxTokens=1200) => {
  const apiKey = localStorage.getItem(API_KEY_STORE)||'';
  if (!apiKey) throw new Error('No API key — add it in Settings');
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ model:MODEL, max_tokens:maxTokens, messages:[{role:'user',content:prompt}] })
  });
  if (!res.ok) {
    const err = await res.json().catch(()=>({}));
    const msg = err.error?.message || JSON.stringify(err).slice(0,200) || 'API error ' + res.status;
    throw new Error(res.status === 401 ? 'Invalid API key — check Settings' : msg);
  }
  const data = await res.json();
  const text = (data.content||[]).map(i=>i.text||'').join('').replace(/```json|```/g,'').trim();
  return JSON.parse(text);
};

// ── Spotify PKCE Auth (browser-safe, no backend needed) ──────────────────────
// Spotify blocks Client Credentials from browsers (CORS restriction).
// PKCE Auth flow for Spotify
const SP_TOKEN_STORE    = 'sp_access_token';
const SP_EXPIRY_STORE   = 'sp_token_expiry';
const SP_VERIFIER_STORE = 'sp_pkce_verifier';
const SP_PENDING_URL    = 'sp_pending_url';
const SP_STATE_STORE    = 'sp_oauth_state';

const getRedirectUri = () => {
  const loc = window.location;
  let path = loc.pathname;
  if (!path.endsWith('/')) path += '/';
  return loc.origin + path;
};

const generateRandom = len => {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/[^a-zA-Z0-9]/g,'').slice(0,len);
};

const sha256b64 = async str => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};

const startSpotifyLogin = async (pendingUrl='') => {
  const clientId = localStorage.getItem(SP_CLIENT_STORE)||'';
  if (!clientId) { setState({spotifyStatus:{ok:false,msg:'Add your Spotify Client ID in Settings first'}}); return; }
  const verifier  = generateRandom(64);
  const challenge = await sha256b64(verifier);
  const oauthState = generateRandom(16);
  localStorage.setItem(SP_VERIFIER_STORE, verifier);
  localStorage.setItem(SP_STATE_STORE,    oauthState);
  // Save pending URL so we can restore it after login (user still taps Import)
  if (pendingUrl) localStorage.setItem(SP_PENDING_URL, pendingUrl);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'playlist-read-private playlist-read-collaborative',
    redirect_uri: getRedirectUri(),
    state: oauthState,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  window.location.href = 'https://accounts.spotify.com/authorize?' + params;
};

// Returns true if handled a callback, false otherwise
const handleSpotifyCallback = async () => {
  const savedCode = sessionStorage.getItem('sp_code');
  const isReady   = sessionStorage.getItem('sp_ready');
  if (!savedCode || !isReady) return false;
  // Code is saved — just show the app and tell user to tap Import
  // We do NOT exchange here because Chrome blocks fetches on redirect pages
  if (!rootEl) rootEl = document.getElementById('root');
  Object.assign(state, {
    spotifyStatus: {ok:true, msg:'Spotify connected! Paste your playlist URL and tap Import.'}
  });
  render();
  return true;
};

// Complete the token exchange — called from Import button (normal page, fetch works)
const completeSpotifyLogin = async () => {
  const code    = sessionStorage.getItem('sp_code');
  const stateSS = sessionStorage.getItem('sp_state');
  if (!code) return false;
  const clientId    = localStorage.getItem(SP_CLIENT_STORE)||'';
  const verifier    = localStorage.getItem(SP_VERIFIER_STORE)||'';
  const redirectUri = getRedirectUri();
  if (!clientId||!verifier) {
    setState({spotifyStatus:{ok:false,msg:'Login expired — tap Import to try again'}});
    sessionStorage.removeItem('sp_code'); sessionStorage.removeItem('sp_ready');
    return false;
  }
  setState({loadingSpotify:true, spotifyStatus:{ok:null,msg:'Completing Spotify login...'}});
  try {
    const data = await exchangeCodeViaWorker(code, verifier, clientId, redirectUri);
    sessionStorage.removeItem('sp_code'); sessionStorage.removeItem('sp_state'); sessionStorage.removeItem('sp_ready');
    localStorage.removeItem(SP_VERIFIER_STORE); localStorage.removeItem(SP_STATE_STORE);
    localStorage.setItem(SP_TOKEN_STORE, data.access_token);
    localStorage.setItem(SP_EXPIRY_STORE, String(Date.now()+(data.expires_in-60)*1000));
    setState({loadingSpotify:false, spotifyStatus:{ok:true,msg:'Connected! Importing...'}});
    return true;
  } catch(e) {
    sessionStorage.removeItem('sp_code'); sessionStorage.removeItem('sp_ready');
    setState({loadingSpotify:false, spotifyStatus:{ok:false,msg:'Login failed: '+e.message}});
    return false;
  }
};

const getSpotifyToken = () => {
  const token  = localStorage.getItem(SP_TOKEN_STORE)||'';
  const expiry = parseInt(localStorage.getItem(SP_EXPIRY_STORE)||'0');
  if (token && Date.now() < expiry) return token;
  return null; // caller handles missing token
};

const isSpotifyConnected = () => {
  const token  = localStorage.getItem(SP_TOKEN_STORE)||'';
  const expiry = parseInt(localStorage.getItem(SP_EXPIRY_STORE)||'0');
  return !!(token && Date.now() < expiry);
};

const disconnectSpotify = () => {
  [SP_TOKEN_STORE,SP_EXPIRY_STORE,SP_VERIFIER_STORE,SP_PENDING_URL,SP_STATE_STORE].forEach(k=>localStorage.removeItem(k));
  setState({spotifyStatus:null});
};

const extractPlaylistId = url => {
  const m = url.match(/playlist[/:]([ A-Za-z0-9]+)/);
  return m ? m[1].trim() : null;
};

// Exchange PKCE code via worker (server-side, no CORS issues)
const exchangeCodeViaWorker = async (code, verifier, clientId, redirectUri) => {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 15000);
  let res;
  try {
    res = await fetch(SPOTIFY_PROXY + '/exchange', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Code': code,
        'X-Verifier': verifier,
        'X-Redirect-Uri': redirectUri,
        'X-Client-Id': clientId,
      },
      body: '{}',
      signal: controller.signal,
    });
    clearTimeout(tid);
  } catch(e) {
    clearTimeout(tid);
    throw new Error('Worker fetch failed: ' + e.message);
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { throw new Error('Bad response: ' + text.slice(0,100)); }
  if (!res.ok || data.error)
    throw new Error('Exchange ' + res.status + ': ' + (data.error_description||data.error||text.slice(0,100)));
  return data;
};

const getUserToken = () => {
  const token = localStorage.getItem(SP_TOKEN_STORE)||'';
  const expiry = parseInt(localStorage.getItem(SP_EXPIRY_STORE)||'0');
  if (token && Date.now() < expiry) return token;
  return null;
};

const fetchSpotifyPlaylist = async (url) => {
  const id = extractPlaylistId(url);
  if (!id) throw new Error('Could not find playlist ID in that URL');

  // Token must be present — startSpotifyOAuth handles the case when it's missing
  const token = getUserToken();
  if (!token) throw new Error('No Spotify token — please tap Import again');

  // Fetch via worker (worker uses our user token server-side — no CORS)
  const res = await fetch(SPOTIFY_PROXY + '/playlist/' + id, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Token':token},
    body: '{}',
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    if (res.status===401) {
      [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
      throw new Error('Token expired — tap Import again to reconnect');
    }
    if (res.status===403) {
      // Token scope issue — clear token and force re-login with correct scope
      [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
      throw new Error('Permission denied — tap Import again to reconnect Spotify with full access');
    }
    throw new Error((data.error||'error') + ' (status '+res.status+')');
  }
  const songs = (data.items||[]).filter(i=>i?.track?.name).map(i=>{
    const t=i.track, sec=Math.round((t.duration_ms||0)/1000);
    return {id:mkId(),title:t.name,artist:(t.artists||[]).map(a=>a.name).join(', '),
      genre:'Other',bpm:'',key:'',energy:'Medium',spotifyId:t.id||'',
      duration:sec>0?Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0'):'',
      tuning:'Standard',capo:0,vocal:'',unavailable:false,favorite:false};
  });
  if (!songs.length) throw new Error('No tracks found — make sure the playlist is not empty');
  return { name:data.name||'Spotify Playlist', songs };
};

// ── PDF Export ────────────────────────────────────────────────────────────────
const exportPDF = (songs, analysis, vocalType, generatedSetlist) => {
  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({unit:'mm',format:'a4'});
  const W = doc.internal.pageSize.getWidth();
  let y = 18;
  const add = (txt,sz,col,bold=false) => {
    doc.setFont('helvetica',bold?'bold':'normal');
    doc.setFontSize(sz); doc.setTextColor(...col);
    const lines = doc.splitTextToSize(String(txt),W-28);
    if (y+lines.length*(sz*0.4+1)>280){doc.addPage();y=18;}
    doc.text(lines,14,y); y+=lines.length*(sz*0.4+1)+2;
  };
  const rule = () => {doc.setDrawColor(40,40,40);doc.line(14,y,W-14,y);y+=5;};
  doc.setFillColor(9,9,9);doc.rect(0,0,W,297,'F');
  add('SETLIST OPTIMIZER',22,[232,93,58],true);
  add(`${vocalType} vocals · ${songs.length} songs · ${formatTotal(totalDuration(songs))}`,10,[100,100,100]);
  add(new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'}),9,[70,70,70]);
  rule();
  const list = generatedSetlist?.setlist||songs;
  add('SETLIST',13,[255,255,255],true);
  list.forEach((s,i)=>{
    if(y>270){doc.addPage();y=18;}
    doc.setFont('helvetica','bold');doc.setFontSize(11);doc.setTextColor(255,255,255);
    doc.text(`${String(i+1).padStart(2,'0')}  ${s.title||s}`,14,y);
    if(s.artist||s.bpm||s.key||s.duration){
      doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(110,110,110);
      const meta=[s.artist,s.genre,s.bpm&&s.bpm+' BPM',s.key,s.duration].filter(Boolean).join('  ·  ');
      doc.text(meta,22,y+4.5); y+=11;
    } else {y+=7;}
  });
  rule();
  if(generatedSetlist){
    add('GENERATED SET NOTES',13,[232,93,58],true);
    add(generatedSetlist.notes||'',10,[180,180,180]);
    if(generatedSetlist.swaps?.length){
      add('SWAP SUGGESTIONS',11,[58,158,232],true);
      generatedSetlist.swaps.forEach(sw=>{
        add(`Remove: "${sw.remove}" → Add: "${sw.add}" (${sw.artist})`,10,[200,200,200]);
        add(sw.reason,9,[120,120,120]);
      });
    }
    rule();
  }
  if(analysis){
    add(`FLOW SCORE: ${analysis.flowScore}/10`,13,[255,255,255],true);
    add(analysis.flowScoreNote,10,[160,160,160]);
    add(analysis.assessment,10,[180,180,180]); rule();
    add('ENERGY ARC',11,[232,166,58],true); add(analysis.energyArc,10,[170,170,170]); rule();
    add('SONGS TO MOVE',11,[58,158,232],true);
    (analysis.moves||[]).forEach(m=>{add(`"${m.song}" — #${m.currentPos} → #${m.suggestedPos}`,10,[220,220,220]);add(m.reason,9,[120,120,120]);});
    rule();
    add('SONGS TO REPLACE',11,[166,58,232],true);
    (analysis.replacements||[]).forEach(r=>{add(`"${r.song}"`,10,[220,220,220]);add(r.reason+'  →  '+r.suggestion,9,[150,100,200]);});
    rule();
    add('SONGS TO ADD',11,[58,232,166],true);
    (analysis.additions||[]).forEach(a=>{add(`"${a.title}" by ${a.artist} [${a.position}]`,10,[220,220,220]);add(a.reason,9,[120,120,120]);});
  }
  doc.save('setlist.pdf');
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const injectStyles = () => {
  document.head.appendChild(Object.assign(document.createElement('style'),{textContent:`
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
    html,body{height:100%;background:#090909;color:#fff;font-family:'DM Sans',sans-serif;}
    #root{height:100%;}
    ::-webkit-scrollbar{width:6px;}::-webkit-scrollbar-track{background:#111;}::-webkit-scrollbar-thumb{background:#2a2a2a;border-radius:3px;}
    input,select,button{font-family:'DM Sans',sans-serif;}
    input[type=number]::-webkit-inner-spin-button{opacity:0.3;}
    .app{min-height:100vh;background:#090909;background-image:radial-gradient(ellipse at 15% 10%,rgba(232,93,58,0.09) 0%,transparent 50%),radial-gradient(ellipse at 85% 90%,rgba(58,158,232,0.07) 0%,transparent 50%);color:#fff;padding-bottom:60px;}
    .header{border-bottom:1px solid rgba(255,255,255,0.06);padding:20px 24px 16px;display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px;position:sticky;top:0;background:rgba(9,9,9,0.92);backdrop-filter:blur(12px);z-index:100;}
    .logo{font-family:'Bebas Neue',sans-serif;font-size:32px;letter-spacing:4px;line-height:1;}
    .logo span{color:#e85d3a;}
    .tagline{font-size:10px;color:#444;letter-spacing:2px;margin-top:2px;}
    .header-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
    .duration-badge{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:7px 14px;text-align:center;}
    .duration-val{font-family:'Bebas Neue',sans-serif;font-size:18px;color:#e8a63a;line-height:1;}
    .duration-lbl{font-size:9px;color:#444;letter-spacing:1.5px;}
    .vocal-toggle{display:flex;background:rgba(255,255,255,0.05);border-radius:8px;padding:3px;border:1px solid rgba(255,255,255,0.07);}
    .vocal-btn{background:transparent;color:#666;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-weight:700;font-size:12px;transition:all 0.15s;}
    .vocal-btn.active{background:#e85d3a;color:#fff;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px;max-width:1400px;margin:0 auto;}
    @media(max-width:900px){.grid{grid-template-columns:1fr;}}
    .label{font-size:10px;letter-spacing:2px;color:#555;margin-bottom:12px;text-transform:uppercase;}
    .card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:16px;margin-bottom:16px;}
    .add-form{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px;}
    .inp{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.11);border-radius:6px;color:#fff;padding:8px 11px;font-size:13px;outline:none;flex:1;min-width:120px;transition:border-color 0.15s;}
    .inp:focus{border-color:rgba(232,93,58,0.5);}
    .inp-sm{max-width:90px;}.inp-md{max-width:130px;}
    select.inp option{background:#1a1a1a;}
    .btn{border:none;border-radius:7px;padding:8px 16px;cursor:pointer;font-weight:700;font-size:13px;letter-spacing:0.5px;transition:opacity 0.15s,transform 0.1s;font-family:'DM Sans',sans-serif;}
    .btn:active{transform:scale(0.97);}
    .btn-primary{background:#e85d3a;color:#fff;}
    .btn-green{background:#1DB954;color:#fff;}
    .btn-ghost{background:rgba(255,255,255,0.06);color:#bbb;border:1px solid rgba(255,255,255,0.09);}
    .btn-full{width:100%;padding:13px;font-size:14px;letter-spacing:3px;font-family:'Bebas Neue',sans-serif;}
    .btn-disabled{opacity:0.4;cursor:not-allowed;}
    .hint{color:#2e2e2e;font-size:11px;margin-top:5px;}
    .tabs{display:flex;border-bottom:1px solid rgba(255,255,255,0.06);margin-bottom:14px;}
    .tab{background:none;border:none;border-bottom:2px solid transparent;color:#555;padding:8px 16px;cursor:pointer;font-weight:700;font-size:12px;letter-spacing:1px;transition:all 0.15s;font-family:'DM Sans',sans-serif;}
    .tab.active{color:#fff;border-bottom-color:#e85d3a;}
    .song-count{margin-left:auto;color:#333;font-size:12px;padding:8px 0;align-self:center;}
    .song-card{background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.07);border-radius:8px;padding:11px 13px;display:flex;align-items:center;gap:9px;transition:background 0.15s;margin-bottom:5px;cursor:grab;}
    .song-card:hover{background:rgba(255,255,255,0.06);}
    .song-num{color:#333;font-size:11px;font-family:monospace;min-width:20px;text-align:center;}
    .song-title{font-family:'Bebas Neue',sans-serif;font-size:15px;letter-spacing:1px;color:#fff;}
    .song-artist{color:#666;font-size:12px;}
    .song-meta{display:flex;align-items:center;gap:7px;flex:1;flex-wrap:wrap;}
    .tag{border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700;}
    .tag-bpm{background:rgba(255,255,255,0.05);color:#555;}
    .tag-key{background:rgba(232,166,58,0.1);color:#e8a63a;}
    .tag-dur{color:#555;font-size:10px;}
    .tag-sp{background:rgba(29,185,84,0.12);color:#1DB954;font-size:10px;padding:2px 6px;border-radius:3px;}
    .tag-energy-high{color:#e85d3a;font-size:11px;}
    .tag-energy-med{color:#e8a63a;font-size:11px;}
    .tag-energy-low{color:#3a9ee8;font-size:11px;}
    .detecting{color:#444;font-size:10px;font-style:italic;}
    .song-actions{display:flex;gap:5px;flex-shrink:0;}
    .icon-btn{background:none;border:1px solid rgba(255,255,255,0.07);border-radius:4px;color:#555;padding:3px 8px;cursor:pointer;font-size:11px;transition:all 0.15s;}
    .icon-btn:hover{border-color:rgba(255,255,255,0.15);color:#999;}
    .icon-btn.danger:hover{border-color:#e85d3a;color:#e85d3a;}
    .edit-row{display:flex;gap:6px;flex-wrap:wrap;flex:1;}
    .empty-state{text-align:center;color:#2e2e2e;padding:44px 0;font-size:14px;line-height:2;}
    .empty-icon{font-size:32px;margin-bottom:8px;}
    .key-row{display:flex;align-items:center;gap:9px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:7px;margin-bottom:4px;}
    .key-connector{display:flex;align-items:center;gap:8px;padding:3px 12px;}
    .key-line{width:1px;height:16px;background:rgba(255,255,255,0.05);margin-left:9px;}
    .compat-label{font-size:10px;letter-spacing:1px;}
    .key-legend{margin-top:12px;padding:11px 14px;background:rgba(255,255,255,0.02);border-radius:8px;font-size:11px;color:#444;line-height:2;}
    .analysis-panel{display:flex;flex-direction:column;gap:13px;}
    .score-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:10px;padding:18px;display:flex;gap:16px;align-items:flex-start;}
    .score-num{font-family:'Bebas Neue',sans-serif;font-size:52px;line-height:1;}
    .score-lbl{font-size:9px;color:#444;letter-spacing:1.5px;}
    .score-text{font-size:13px;color:#ccc;line-height:1.6;}
    .score-note{margin-top:6px;font-size:11px;color:#555;font-style:italic;}
    .section{background:rgba(255,255,255,0.025);border:1px solid rgba(255,255,255,0.065);border-radius:10px;padding:16px;}
    .section-title{font-size:10px;font-weight:700;letter-spacing:2.5px;margin-bottom:13px;text-transform:uppercase;}
    .section-item{border-bottom:1px solid rgba(255,255,255,0.04);padding-bottom:9px;margin-bottom:9px;}
    .section-item:last-child{border-bottom:none;padding-bottom:0;margin-bottom:0;}
    .item-head{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:3px;}
    .item-title{font-family:'Bebas Neue',sans-serif;font-size:14px;color:#fff;}
    .item-badge{font-size:10px;padding:2px 8px;border-radius:4px;}
    .item-reason{font-size:12px;color:#666;}
    .item-suggest{font-size:12px;margin-top:3px;}
    .placeholder-panel{background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.06);border-radius:10px;padding:48px;text-align:center;}
    .placeholder-icon{font-size:40px;margin-bottom:12px;}
    .placeholder-text{color:#333;font-size:13px;line-height:1.8;}
    .loading-panel{background:rgba(232,93,58,0.04);border:1px solid rgba(232,93,58,0.1);border-radius:10px;padding:48px;text-align:center;}
    .loading-text{color:#e85d3a;font-size:12px;letter-spacing:3px;animation:pulse 1.5s ease-in-out infinite;}
    .loading-sub{color:#333;font-size:11px;margin-top:8px;}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
    .error-text{color:#e85d3a;font-size:12px;margin-top:8px;text-align:center;}
    .generate-panel{background:rgba(58,232,166,0.03);border:1px solid rgba(58,232,166,0.1);border-radius:10px;padding:18px;}
    .generate-controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px;}
    .generated-song{display:flex;align-items:center;gap:9px;padding:8px 12px;background:rgba(255,255,255,0.03);border-radius:7px;margin-bottom:4px;}
    .swap-item{padding:10px;background:rgba(58,158,232,0.05);border:1px solid rgba(58,158,232,0.1);border-radius:7px;margin-bottom:6px;}
    .swap-remove{color:#e85d3a;font-size:12px;}
    .swap-add{color:#3ae8a6;font-size:12px;margin-top:2px;}
    .swap-reason{color:#555;font-size:11px;margin-top:3px;}
    .api-banner{background:rgba(232,166,58,0.06);border-bottom:1px solid rgba(232,166,58,0.12);padding:10px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
    .api-banner p{font-size:12px;color:#888;flex:1;}
    .api-banner a{color:#e8a63a;text-decoration:none;}
    .settings-modal{position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(8px);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;}
    .settings-box{background:#111;border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:28px;width:100%;max-width:520px;}
    .modal-title{font-family:'Bebas Neue',sans-serif;font-size:22px;letter-spacing:3px;margin-bottom:4px;}
    .modal-sub{font-size:12px;color:#555;margin-bottom:20px;}
    .settings-section{margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid rgba(255,255,255,0.06);}
    .settings-section:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0;}
    .settings-section-title{font-size:11px;font-weight:700;letter-spacing:2px;color:#888;margin-bottom:12px;text-transform:uppercase;}
    .field-label{font-size:11px;color:#555;letter-spacing:1px;margin-bottom:6px;}
    .field-hint{font-size:11px;color:#3a3a3a;margin-top:5px;line-height:1.5;}
    .field-hint a{color:#1DB954;text-decoration:none;}
    .api-inp-wrap{display:flex;gap:8px;align-items:center;}
    .sp-import-box{background:rgba(29,185,84,0.04);border:1px solid rgba(29,185,84,0.15);border-radius:10px;padding:16px;margin-bottom:16px;}
    .sp-import-title{font-size:11px;font-weight:700;letter-spacing:2px;color:#1DB954;margin-bottom:10px;text-transform:uppercase;display:flex;align-items:center;gap:8px;}
    .sp-import-row{display:flex;gap:8px;align-items:center;}
    .sp-status{font-size:11px;margin-top:6px;}
    .sp-status.ok{color:#1DB954;}
    .sp-status.err{color:#e85d3a;}
    .generated-badge{background:rgba(58,232,166,0.12);color:#3ae8a6;font-size:10px;padding:2px 8px;border-radius:4px;margin-left:8px;}
    .install-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:14px 20px;display:flex;align-items:center;gap:12px;z-index:300;box-shadow:0 8px 32px rgba(0,0,0,0.5);animation:slideUp 0.3s ease;}
    @keyframes slideUp{from{transform:translateX(-50%) translateY(20px);opacity:0}to{transform:translateX(-50%) translateY(0);opacity:1}}
    .install-text{font-size:13px;color:#ccc;}
    .btn-settings{background:none;border:1px solid rgba(255,255,255,0.08);color:#555;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:12px;}
    .sp-loading{color:#1DB954;font-size:12px;letter-spacing:2px;animation:pulse 1.2s ease-in-out infinite;margin-top:8px;}
    .playlist-name{font-family:'Bebas Neue',sans-serif;font-size:14px;color:#1DB954;letter-spacing:1px;margin-bottom:8px;}
  `}));
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  bands: loadBands(),
  activeBand: getActiveBand(),
  songs: loadFromStorage(),
  vocalType: 'Mixed',
  tab: 'setlist',
  analysis: null,
  generatedSetlist: null,
  loading: false,
  loadingGenerate: false,
  loadingSpotify: false,
  detecting: {},
  editingId: null,
  editData: {},
  newSong: {title:'',artist:'',genre:'Pop',bpm:'',key:'',duration:'',energy:'Medium',vocal:'',tuning:'Standard',capo:0},
  targetMinutes: 60,
  numberOfSets: 1,
  breakMinutes: 15,
  availableVocalists: 'Both',
  savedSetlists: loadSavedSetlists(),
  viewingSetlist: null,
  pendingVerification: null,
  showSettings: false,
  apiKey: localStorage.getItem(API_KEY_STORE)||'',
  spClientId: localStorage.getItem(SP_CLIENT_STORE)||'',
  spClientSecret: localStorage.getItem(SP_SECRET_STORE)||'',
  spotifyUrl: '',
  spotifyStatus: null,   // null | {ok, msg}
  installPrompt: null,
  showInstall: false,
  error: null,
};

let rootEl;

// ─────────────────────────────────────────────────────────────────────────────
// RENDER ENGINE
// ─────────────────────────────────────────────────────────────────────────────
const h = (tag, attrs={}, ...children) => {
  const el = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k.startsWith('on') && typeof v==='function') el.addEventListener(k.slice(2).toLowerCase(),v);
    else if (k==='className') el.className=v;
    else if (k==='style'&&typeof v==='object') Object.assign(el.style,v);
    else if (v!=null&&v!==false) el.setAttribute(k,v);
  }
  for (const c of children.flat(Infinity)) {
    if (c==null||c===false) continue;
    el.appendChild(typeof c==='string'||typeof c==='number' ? document.createTextNode(c) : c);
  }
  return el;
};
const render = () => {
  if (!rootEl) rootEl = document.getElementById('root');
  if (!rootEl) return; // safety — don't crash if root missing
  const app = buildApp();
  if (rootEl.firstChild) rootEl.replaceChild(app,rootEl.firstChild);
  else rootEl.appendChild(app);
};
const setState = upd => { Object.assign(state,typeof upd==='function'?upd(state):upd); render(); };

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
const addSong = () => {
  const titleEl = document.getElementById('new-title');
  const artistEl = document.getElementById('new-artist');
  const title = titleEl?.value?.trim() || state.newSong.title?.trim() || '';
  if (!title) return;
  const capoEl = document.getElementById('new-capo');
  const song = {
    ...state.newSong,
    title,
    artist: artistEl?.value?.trim() || state.newSong.artist || '',
    capo: parseInt(capoEl?.value||'0')||0,
    id: mkId()
  };
  if (capoEl) capoEl.value='0';
  if (titleEl) titleEl.value = '';
  if (artistEl) artistEl.value = '';
  state.newSong = {title:'',artist:'',genre:'Pop',bpm:'',key:'',duration:'',energy:'Medium',vocal:'',tuning:'Standard',capo:0};
  const songs = [...state.songs, song];
  saveToStorage(songs);
  setState({songs});
  detectSongInfo(song);
};
const removeSong = id => {
  const song = state.songs.find(s=>s.id===id);
  if (!song) return;
  if (!confirm('Remove "'+song.title+'" from your library?')) return;
  const songs = state.songs.filter(s=>s.id!==id);
  saveToStorage(songs);
  setState({songs});
};
const startEdit = id => { const song=state.songs.find(s=>s.id===id); setState({editingId:id,editData:{...song}}); };
const saveEdit = id => { const songs=state.songs.map(s=>s.id===id?{...s,...state.editData}:s); saveToStorage(songs); setState({songs,editingId:null,editData:{}}); };
const cancelEdit = () => setState({editingId:null,editData:{}});

const detectSongInfo = async song => {
  setState(s=>({detecting:{...s.detecting,[song.id]:true}}));
  try {
    const info = await callAI(
      `For the song "${song.title}"${song.artist?` by ${song.artist}`:''}, give known musical attributes. Respond ONLY in JSON, no markdown:
{"bpm":integer_or_null,"key":"string_or_null","energy":"Low|Medium|High","duration":"m:ss_or_null","genre":"Rock|Pop|R&B|Country|Jazz|Folk|Electronic|Hip-Hop|Soul|Blues|Other","vocal":"Male|Female|Duet|Group|","tuning":"Standard|Drop D|Open G|Open D|Open E|DADGAD|Half Step Down|Full Step Down|","capo":integer_0_to_12}`, 300
    );
    const updated = {
      ...song,
      bpm:  song.bpm||(info.bpm?String(info.bpm):''),
      key:  song.key||info.key||'',
      energy: song.energy||info.energy||'Medium',
      duration: song.duration||info.duration||'',
      genre: song.genre==='Other'?(info.genre||song.genre):song.genre,
      vocal: song.vocal||info.vocal||'',
      tuning: song.tuning||info.tuning||'Standard',
      capo: song.capo!==undefined?song.capo:(info.capo||0),
    };
    const songs = state.songs.map(s=>s.id===song.id?updated:s);
    saveToStorage(songs);
    setState(s=>{const det={...s.detecting};delete det[song.id];return{songs,detecting:det};});
  } catch(e) {
    console.error('Detection failed:', e.message);
    setState(s=>{const det={...s.detecting};delete det[song.id];return{detecting:det};});
  }
};

const handleCSV = e => {
  const file=e.target.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload = ev => {
    const lines=ev.target.result.split('\n').filter(Boolean);
    const headers=lines[0].toLowerCase().split(',').map(h=>h.trim());
    const get=(row,names)=>{for(const n of names){const i=headers.indexOf(n);if(i>=0)return(row[i]||'').trim().replace(/^"|"$/g,'');}return '';};
    const newSongs=lines.slice(1).map(line=>{
      const cols=line.split(',');
      return {id:mkId(),title:get(cols,['title','song','name'])||cols[0]||'',artist:get(cols,['artist','artist name'])||cols[1]||'',genre:get(cols,['genre'])||'Other',bpm:get(cols,['bpm','tempo'])||'',key:get(cols,['key'])||'',duration:get(cols,['duration','length','time'])||'',energy:get(cols,['energy'])||'Medium'};
    }).filter(s=>s.title);
    const songs=[...state.songs,...newSongs];
    saveToStorage(songs); setState({songs});
    newSongs.forEach(s=>{if(!s.bpm||!s.key) detectSongInfo(s);});
  };
  reader.readAsText(file); e.target.value='';
};

// ── Spotify import ────────────────────────────────────────────────────────────
// Start OAuth redirect - uses pre-computed PKCE values for pure sync execution
const startSpotifyOAuth = (pendingUrl) => {
  const clientId = localStorage.getItem(SP_CLIENT_STORE)||'';
  if (!clientId) { setState({spotifyStatus:{ok:false,msg:'Add your Spotify Client ID in ⚙ Settings first'}}); return; }
  
  // Use pre-computed PKCE values (generated on page load)
  const verifier   = sessionStorage.getItem('pkce_verifier')||'';
  const challenge  = sessionStorage.getItem('pkce_challenge')||'';
  const oauthState = sessionStorage.getItem('pkce_state')||generateRandom(16);
  
  if (!verifier || !challenge) {
    // Fallback: generate new ones (async, but best effort)
    prepPKCE().then(() => startSpotifyOAuth(pendingUrl));
    setState({spotifyStatus:{ok:null,msg:'Preparing login, tap Import again in a moment...'}});
    return;
  }
  
  // Save to localStorage for retrieval after redirect
  localStorage.setItem(SP_VERIFIER_STORE, verifier);
  localStorage.setItem(SP_STATE_STORE, oauthState);
  if (pendingUrl) localStorage.setItem(SP_PENDING_URL, pendingUrl);
  
  // Clear pre-computed values so they get regenerated next time
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('pkce_challenge');
  sessionStorage.removeItem('pkce_state');

  const params = new URLSearchParams({
    response_type:'code', client_id:clientId,
    scope:'playlist-read-private playlist-read-collaborative',
    redirect_uri:getRedirectUri(), state:oauthState,
    code_challenge_method:'S256', code_challenge:challenge,
  });
  const authUrl = 'https://accounts.spotify.com/authorize?' + params;

  // Navigate directly to Spotify - synchronous from button tap, Chrome must allow this
  window.location.assign(authUrl);
};

const importFromSpotify = async (overrideUrl) => { overrideUrl = (typeof overrideUrl === 'string') ? overrideUrl : '';
  const urlEl = document.getElementById('spotify-url-inp');
  const url = (typeof overrideUrl==='string'&&overrideUrl ? overrideUrl : (urlEl?.value||state.spotifyUrl||'')).trim();
  if (!url) { setState({spotifyStatus:{ok:false,msg:'Paste a Spotify playlist URL first'}}); return; }
  if (!localStorage.getItem(SP_CLIENT_STORE)) {
    setState({spotifyStatus:{ok:false,msg:'Add your Spotify Client ID in ⚙ Settings first'}}); return;
  }
  // If no token, show message - actual redirect is triggered by Import button directly
  if (!getUserToken()) {
    setState({spotifyStatus:{ok:null,msg:'Tap Import again to open Spotify login'}});
    startSpotifyOAuth(url);
    return;
  }
  setState({loadingSpotify:true, spotifyStatus:{ok:null, msg:'Importing from Spotify...'}});
  try {
    const result = await fetchSpotifyPlaylist(url);
    if (!result) {
      setState({loadingSpotify:false, spotifyStatus:{ok:null, msg:'Redirecting to Spotify login...'}});
      return;
    }
    const {name, songs:imported} = result;
    if (!imported.length) {
      setState({loadingSpotify:false, spotifyStatus:{ok:false,msg:'No tracks found — is the playlist public?'}});
      return;
    }
    const songs = [...state.songs, ...imported];
    saveToStorage(songs);
    setState({songs, loadingSpotify:false, spotifyUrl:'',
      spotifyStatus:{ok:true, msg:'Imported ' + imported.length + ' songs from "' + name + '"'}});
    imported.slice(0,20).forEach(s => detectSongInfo(s));
  } catch(err) {
    const raw = err.message||'Unknown error';
    let msg = 'Import failed: ' + raw;
    if (raw==='NO_CLIENT_ID')   msg='Add your Spotify Client ID in Settings first';
    if (raw==='INVALID_URL')    msg='Could not find a playlist ID in that URL';
    if (raw==='SP_FORBIDDEN')   msg='Playlist is private — make it public in Spotify first';
    if (raw.startsWith('SP_FETCH_FAILED')) msg='Spotify API error ' + raw + ' — check your URL';
    setState({loadingSpotify:false, spotifyStatus:{ok:false, msg}});
  }
};

// Apply a move suggestion — reorder songs
// Export library to JSON file
const exportLibrary = () => {
  const data = {
    songs: state.songs,
    savedSetlists: state.savedSetlists||[],
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href=url; a.download='setlist-library.json'; a.click();
  URL.revokeObjectURL(url);
};

// Import library from JSON file
const importLibrary = (file) => {
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      const songs = data.songs||[];
      const saved = data.savedSetlists||[];
      if (!songs.length) { alert('No songs found in file'); return; }
      saveToStorage(songs);
      saveSavedSetlists(saved);
      setState({songs, savedSetlists:saved});
    } catch(e) { alert('Could not read file: '+e.message); }
  };
  reader.readAsText(file);
};

// ── Song Verification ────────────────────────────────────────────────────────
// Fetch accurate song info and show confirmation dialog before applying
const verifySong = async (song) => {
  setState(s=>({detecting:{...s.detecting,[song.id]:'verifying'}}));
  try {
    const info = await callAI(
      `You are a music database expert. For the RADIO VERSION of "${song.title}" by ${song.artist||'Unknown Artist'}, provide highly accurate musical data based on the original studio recording.
Return ONLY JSON, no markdown, no extra text:
{
  "bpm": <integer exact BPM of the radio version>,
  "key": <exact musical key e.g. "Am", "C#", "F#m">,
  "tuning": <"Standard"|"Drop D"|"Open G"|"Open D"|"Open E"|"DADGAD"|"Half Step Down"|"Full Step Down">,
  "capo": <integer 0-12>,
  "energy": <"Low"|"Medium"|"High">,
  "duration": <"m:ss" format of radio version length>,
  "artist": <correct full artist name>,
  "genre": <"Rock"|"Pop"|"R&B"|"Country"|"Jazz"|"Folk"|"Electronic"|"Hip-Hop"|"Soul"|"Blues"|"Other">
}`, 400);
    // Store proposed changes for confirmation
    const pending = {};
    const fields = ['bpm','key','tuning','capo','energy','duration','artist','genre'];
    fields.forEach(f => {
      const newVal = info[f] !== undefined ? String(info[f]) : '';
      const oldVal = String(song[f]||'');
      if (newVal && newVal !== oldVal) pending[f] = {old:oldVal, new:newVal};
    });
    setState(s=>({
      detecting:{...s.detecting,[song.id]:null},
      pendingVerification:{songId:song.id, songTitle:song.title, changes:pending}
    }));
  } catch(e) {
    setState(s=>({detecting:{...s.detecting,[song.id]:null}}));
    alert('Verify failed: ' + e.message);
  }
};

const applyVerification = (songId, approvedFields) => {
  const pv = state.pendingVerification;
  if (!pv || pv.songId !== songId) return;
  const updates = {};
  approvedFields.forEach(f => { if(pv.changes[f]) updates[f] = pv.changes[f].new; });
  const songs = state.songs.map(s => s.id===songId ? {...s,...updates} : s);
  saveToStorage(songs);
  setState({songs, pendingVerification:null});
};

// ── Band Management ──────────────────────────────────────────────────────────
const switchBand = name => {
  setActiveBand(name);
  setState({
    activeBand: name,
    songs: loadFromStorage(name),
    savedSetlists: loadSavedSetlists(name),
    generatedSetlist: null,
    viewingSetlist: null,
    analysis: null,
    showSettings: false,
  });
};

const addBand = name => {
  name = (name||'').trim();
  if (!name) return;
  const bands = [...state.bands];
  if (bands.includes(name)) { switchBand(name); return; }
  bands.push(name);
  saveBands(bands);
  setState({bands});
  switchBand(name);
};

const renameBand = (oldName, newName) => {
  newName = (newName||'').trim();
  if (!newName || newName===oldName) return;
  const bands = state.bands.map(b=>b===oldName?newName:b);
  // Move storage to new key
  const songs = loadFromStorage(oldName);
  const setlists = loadSavedSetlists(oldName);
  saveToStorage(songs, newName);
  saveSavedSetlists(setlists, newName);
  localStorage.removeItem(songsKeyFor(oldName));
  localStorage.removeItem(backupKeyFor(oldName));
  localStorage.removeItem(setlistsKeyFor(oldName));
  saveBands(bands);
  if (state.activeBand===oldName) setActiveBand(newName);
  setState({bands, activeBand: state.activeBand===oldName?newName:state.activeBand});
};

const deleteBand = name => {
  if (state.bands.length<=1) { alert('You need at least one band/library.'); return; }
  if (!confirm('Delete "'+name+'" and all its songs and setlists? This cannot be undone.')) return;
  const bands = state.bands.filter(b=>b!==name);
  localStorage.removeItem(songsKeyFor(name));
  localStorage.removeItem(backupKeyFor(name));
  localStorage.removeItem(setlistsKeyFor(name));
  saveBands(bands);
  if (state.activeBand===name) { switchBand(bands[0]); }
  else { setState({bands}); }
};

// Toggle song favorite/must-include status
const toggleFavorite = id => {
  const songs = state.songs.map(s => s.id===id ? {...s, favorite:!s.favorite} : s);
  saveToStorage(songs);
  setState({songs});
};

// Toggle song availability
const toggleAvailable = id => {
  const songs = state.songs.map(s => s.id===id ? {...s, unavailable:!s.unavailable} : s);
  saveToStorage(songs);
  setState({songs});
};

const applyMove = (song, newPos) => {
  const removeFromAnalysis = () => ({...state.analysis, moves:(state.analysis.moves||[]).filter(m=>m.song!==song)});
  // Apply to whichever target was analyzed
  if (state.viewingSetlist) {
    const saved = (state.savedSetlists||[]).map(sl=>{
      if (sl.id!==state.viewingSetlist) return sl;
      const arr=[...sl.songs];
      const fromIdx=arr.findIndex(s=>s.title===song);
      if(fromIdx<0) return sl;
      const toIdx=Math.max(0,Math.min(arr.length-1,newPos-1));
      const [moved]=arr.splice(fromIdx,1); arr.splice(toIdx,0,moved);
      return {...sl, songs:arr};
    });
    saveSavedSetlists(saved);
    setState({savedSetlists:saved, analysis:removeFromAnalysis()});
    return;
  }
  if (state.generatedSetlist) {
    const gs = JSON.parse(JSON.stringify(state.generatedSetlist));
    const arr = gs.sets ? gs.sets.flatMap(s=>s.setlist) : gs.setlist;
    const fromIdx = arr.findIndex(s=>s.title===song);
    if (fromIdx<0) { setState({analysis:removeFromAnalysis()}); return; }
    if (gs.sets) {
      // Find which set and reorder within the flattened position mapping
      let flat=[]; gs.sets.forEach((st,si)=>st.setlist.forEach((sg,gi)=>flat.push({si,gi,sg})));
      const fromEntry = flat.find(f=>f.sg.title===song);
      const toIdx = Math.max(0,Math.min(flat.length-1,newPos-1));
      const [moved] = gs.sets[fromEntry.si].setlist.splice(fromEntry.gi,1);
      // Recompute flat after removal, then insert
      flat = []; gs.sets.forEach((st,si)=>st.setlist.forEach((sg,gi)=>flat.push({si,gi})));
      const target = flat[Math.min(toIdx,flat.length)] || flat[flat.length-1];
      if (target) gs.sets[target.si].setlist.splice(target.gi,0,moved);
      else gs.sets[gs.sets.length-1].setlist.push(moved);
    } else {
      const toIdx=Math.max(0,Math.min(arr.length-1,newPos-1));
      const [moved]=arr.splice(fromIdx,1); arr.splice(toIdx,0,moved);
    }
    setState({generatedSetlist:gs, analysis:removeFromAnalysis()});
    return;
  }
  // Default: main library
  const arr = [...state.songs];
  const fromIdx = arr.findIndex(s => s.title === song);
  if (fromIdx < 0) { setState({analysis:removeFromAnalysis()}); return; }
  const toIdx = Math.max(0, Math.min(arr.length-1, newPos-1));
  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);
  saveToStorage(arr);
  setState({songs:arr, analysis:removeFromAnalysis()});
};

// Save a generated setlist
const saveSetlist = (name, songs) => {
  const entry = {
    id: mkId(),
    name: name || ('Set — ' + new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})),
    songs,
    createdAt: Date.now(),
  };
  const saved = [...(state.savedSetlists||[]), entry];
  saveSavedSetlists(saved);
  setState({savedSetlists:saved});
  return entry;
};

const deleteSavedSetlist = id => {
  const saved = (state.savedSetlists||[]).filter(s=>s.id!==id);
  saveSavedSetlists(saved);
  setState({savedSetlists:saved, viewingSetlist: state.viewingSetlist?.id===id ? null : state.viewingSetlist});
};

const loadSavedSetlistToMain = id => {
  const entry = (state.savedSetlists||[]).find(s=>s.id===id);
  if (!entry) return;
  saveToStorage(entry.songs);
  setState({songs:entry.songs, tab:'setlist'});
};

// Apply a generated setlist — save it and keep library intact
const applyGeneratedSetlist = () => {
  const gs = state.generatedSetlist;
  if (!gs) return;
  // Flatten sets or single setlist
  const allSongs = gs.sets
    ? gs.sets.flatMap(s=>s.setlist||[])
    : (gs.setlist||[]);
  if (!allSongs.length) return;
  const enriched = allSongs.map(s => ({
    ...s, id:mkId(),
    spotifyId: (state.songs.find(x=>x.title===s.title)||{}).spotifyId||'',
    vocal: (state.songs.find(x=>x.title===s.title)||{}).vocal||s.vocal||'',
    tuning: (state.songs.find(x=>x.title===s.title)||{}).tuning||s.tuning||'Standard',
    capo: (state.songs.find(x=>x.title===s.title)||{}).capo||s.capo||0,
  }));
  // Save as named setlist (library unchanged)
  saveSetlist(null, enriched);
  setState({generatedSetlist:null, tab:'setlists'});
};

// Determine which setlist Optimize should analyze:
// 1. Currently viewing a saved setlist -> use that
// 2. A generated setlist exists -> use that
// 3. Otherwise -> use main library (available songs only)
const getAnalysisTarget = () => {
  if (state.viewingSetlist) {
    const sl = (state.savedSetlists||[]).find(s=>s.id===state.viewingSetlist);
    if (sl) return {songs: sl.songs, label: sl.name};
  }
  if (state.generatedSetlist) {
    const gs = state.generatedSetlist;
    const songs = gs.sets ? gs.sets.flatMap(s=>s.setlist||[]) : (gs.setlist||[]);
    if (songs.length) return {songs, label: 'Generated Setlist'};
  }
  return {songs: state.songs.filter(s=>!s.unavailable), label: 'Library'};
};

const analyze = async () => {
  const target = getAnalysisTarget();
  if (target.songs.length<2){setState({error:'Need at least 2 songs to analyze.'});return;}
  setState({loading:true,error:null,analysis:null});
  try {
    const favTitles = target.songs.filter(s=>s.favorite).map(s=>s.title);
    const result = await callAI(
      `You are a veteran touring music director who has built thousands of real-world live setlists for working bands. You think like a performer, not a playlist algorithm.

REAL SETLIST PRINCIPLES YOU FOLLOW:
- Opener: medium-high energy, recognizable, pulls people's attention immediately — never the highest-energy song (save that), never something slow or obscure.
- Build in waves, not a straight ramp: energy should rise and fall in 2-4 song arcs, not climb in a single straight line. Real audiences need breathing room.
- Place the single highest-energy/most-recognizable song roughly 2/3 through the set (the "peak"), not at the very end.
- Closer: strong, satisfying, usually high-energy or a beloved crowd singalong — leaves people wanting more.
- Avoid placing two songs in the same key or extremely similar tempo/feel back to back even if music-theory "compatible" — variety prevents monotony.
- CRITICAL: minimize tuning/capo changes between consecutive songs. Every tuning change costs 30-90 seconds of dead air on stage. Cluster all songs sharing a tuning together as contiguous blocks; treat tuning grouping as a hard constraint, not a soft preference, unless doing so would force two near-identical energy/key songs back to back.
- Vary tempo and vocal lead (if mixed vocalists) to keep the set feeling dynamic, not monotonous.
- A practical live set rarely has more than 2 ballads/low-energy songs total, and they should never be placed back to back.
${favTitles.length ? '- These songs are MUST-PLAY favorites and must remain in the set if currently included: ' + favTitles.join(', ') + '. If they are missing from the current order, recommend adding them back via the "additions" field.' : ''}

Analyzing: ${target.label}
Current setlist:
${target.songs.map((s,i)=>`${i+1}. "${s.title}" by ${s.artist||'Unknown'}${s.favorite?' [FAVORITE]':''} | Genre:${s.genre||'?'} | BPM:${s.bpm||'?'} | Key:${s.key||'?'} | Tuning:${s.tuning||'Standard'}${s.capo>0?' Capo '+s.capo:''} | Energy:${s.energy||'?'} | Vocal:${s.vocal||'?'} | Duration:${s.duration||'?'}`).join('\n')}
Vocal type filter: ${state.vocalType}

Give specific, performer-minded feedback — reference actual song titles and real reasons (tuning change cost, energy pacing, key clash, opener/closer fit), not generic music-theory platitudes. Keep all text fields under 100 words each. Respond ONLY in JSON (no markdown):
{"assessment":"...","moves":[{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."},{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."},{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."}],"replacements":[{"song":"...","reason":"...","suggestion":"..."},{"song":"...","reason":"...","suggestion":"..."}],"additions":[{"title":"...","artist":"...","reason":"...","position":"..."},{"title":"...","artist":"...","reason":"...","position":"..."},{"title":"...","artist":"...","reason":"...","position":"..."}],"energyArc":"...","keyFlowNotes":"...","flowScore":N,"flowScoreNote":"..."}`
    ,4000);
    setState({analysis:result,loading:false,analysisTarget:target.label});
  } catch(e) { setState({loading:false,error:'Analysis failed: ' + e.message}); }
};

const generateSetlist = async () => {
  if (state.songs.length<3){setState({error:'Add at least 3 songs to generate a setlist.'});return;}
  setState({loadingGenerate:true,error:null,generatedSetlist:null});
  try {
    const av = state.availableVocalists||'Both';
    const vocalFilter = av==='Male' ? 'only songs a male vocalist can sing'
      : av==='Female' ? 'only songs a female vocalist can sing'
      : 'songs for any vocalist';
    const availSongs = state.songs.filter(s=>!s.unavailable);
    if (!availSongs.length) { setState({loadingGenerate:false, error:'No available songs — mark some songs as available first.'}); return; }
    const favSongs = availSongs.filter(s=>s.favorite);
    const songList = availSongs.map((s,i)=>
      `${i+1}. "${s.title}" by ${s.artist||'Unknown'}${s.favorite?' [MUST-PLAY FAVORITE]':''} | Genre:${s.genre} | BPM:${s.bpm||'?'} | Key:${s.key||'?'} | Tuning:${s.tuning||'Standard'}${s.capo>0?' Capo '+s.capo:''} | Energy:${s.energy} | Vocal:${s.vocal||'?'} | Duration:${s.duration||'?'}`
    ).join('\n');

    const principles = `You are a veteran touring music director building a REAL live setlist for a working band — not a shuffled playlist. Follow how professional sets are actually built:
- Opener: medium-high energy, instantly recognizable, gets the crowd's attention — not the single most intense song (save that), not a ballad.
- Energy moves in waves of 2-4 songs (rise, dip slightly, rise again) — never a flat ramp straight to a finale.
- The single highest-energy / most-anthemic song in the set should land roughly 2/3 of the way through as the emotional peak, not at the very end.
- Closer: strong, satisfying, high-energy or a beloved singalong — last impression matters most.
- No more than 2 low-energy/ballad songs per set, and never two ballads back to back.
- Avoid stacking two songs with near-identical key/tempo/feel back to back even if "compatible" — vary it for the audience.
${favSongs.length ? '- MUST-PLAY FAVORITES (marked above) must all appear in the set somewhere they fit well — do not omit them.' : ''}
- HARD CONSTRAINT: minimize tuning/capo changes. Every tuning change costs real dead-air time on stage. Group all songs sharing the same tuning into contiguous blocks within the set, breaking this only when it would force two ballads or two near-identical songs together.`;

    const isMultiSet = state.numberOfSets > 1;
    const prompt = isMultiSet
      ? `${principles}

Build ${state.numberOfSets} sets of ${state.targetMinutes} min each with ${state.breakMinutes}-min breaks between them. Select ${vocalFilter}.
Library (select which songs to perform — do not remove any from the library):
${songList}
Each set ~${Math.round(state.targetMinutes/3.5)} songs, following the real-setlist principles above (opener, wave-shaped energy, peak at ~2/3, strong closer, tuning grouping).
Respond ONLY in JSON (no markdown):
{"sets":[{"setlist":[{"title":"...","artist":"...","tuning":"...","capo":0,"duration":"...","energy":"...","vocal":"..."}]}],"totalEstimatedMinutes":N,"notes":"brief notes on the energy arc and tuning grouping logic used","swaps":[{"remove":"...","add":"...","artist":"...","reason":"..."}]}`
      : `${principles}

Build the optimal ${state.targetMinutes}-min setlist. Select ${vocalFilter}.
Library (select which songs to perform — do not remove any from the library):
${songList}
~${Math.round(state.targetMinutes/3.5)} songs, following the real-setlist principles above (opener, wave-shaped energy, peak at ~2/3, strong closer, tuning grouping).
Respond ONLY in JSON (no markdown):
{"setlist":[{"title":"...","artist":"...","tuning":"...","capo":0,"duration":"...","energy":"...","vocal":"..."}],"totalEstimatedMinutes":N,"notes":"brief notes on the energy arc and tuning grouping logic used","swaps":[{"remove":"...","add":"...","artist":"...","reason":"..."}]}`;
    const result = await callAI(prompt, 4000);
    setState({generatedSetlist:result,loadingGenerate:false,tab:'generate'});
  } catch(e) { setState({loadingGenerate:false,error:'Generate failed: ' + e.message}); }
};

// ─────────────────────────────────────────────────────────────────────────────
// UI BUILDERS
// ─────────────────────────────────────────────────────────────────────────────
let dragSrcIdx=null;

const buildSongCard = (song, index, isGenerated=false) => {
  const gc=gcColor(song.genre);
  const isEditing=state.editingId===song.id;
  const isDetecting=!!state.detecting[song.id];
  if (isEditing) {
    return h('div',{className:'song-card',style:{borderLeft:`3px solid ${gc}`,flexWrap:'wrap'}},
      h('div',{className:'edit-row'},
        h('input',{className:'inp',placeholder:'Title',value:state.editData.title||'',
          onInput:e=>{state.editData={...state.editData,title:e.target.value};},
          onBlur:e=>{state.editData={...state.editData,title:e.target.value};}}),
        h('input',{className:'inp inp-md',placeholder:'Artist',value:state.editData.artist||'',
          onInput:e=>{state.editData={...state.editData,artist:e.target.value};},
          onBlur:e=>{state.editData={...state.editData,artist:e.target.value};}}),
        h('select',{className:'inp inp-md',onChange:e=>setState({editData:{...state.editData,genre:e.target.value}})},
          ...Object.keys(GENRE_COLORS).map(g=>h('option',{value:g,selected:state.editData.genre===g||null},g))),
        h('input',{className:'inp inp-sm',placeholder:'BPM',type:'number',value:state.editData.bpm||'',
          onInput:e=>{state.editData={...state.editData,bpm:e.target.value};},
          onBlur:e=>{state.editData={...state.editData,bpm:e.target.value};}}),
        h('select',{className:'inp inp-sm',onChange:e=>setState({editData:{...state.editData,key:e.target.value}})},
          h('option',{value:''},'Key'),
          ...MUSICAL_KEYS.map(k=>h('option',{value:k,selected:state.editData.key===k||null},k))),
        h('input',{className:'inp inp-sm',placeholder:'m:ss',value:state.editData.duration||'',
          onInput:e=>{state.editData={...state.editData,duration:e.target.value};},
          onBlur:e=>{state.editData={...state.editData,duration:e.target.value};}}),
        h('select',{className:'inp inp-sm',onChange:e=>setState({editData:{...state.editData,energy:e.target.value}})},
          ['Low','Medium','High'].map(e=>h('option',{value:e,selected:state.editData.energy===e||null},e))),
        h('select',{className:'inp inp-sm',onChange:e=>setState({editData:{...state.editData,vocal:e.target.value}})},
          h('option',{value:''},'Vocal'),
          ['Male','Female','Duet','Group'].map(v=>h('option',{value:v,selected:state.editData.vocal===v||null},v))),
        h('select',{className:'inp inp-sm',onChange:e=>setState({editData:{...state.editData,tuning:e.target.value}})},
          ['Standard','Drop D','Open G','Open D','Open E','DADGAD','Half Step Down','Full Step Down'].map(t=>h('option',{value:t,selected:(state.editData.tuning||'Standard')===t||null},t))),
        h('input',{className:'inp inp-sm',placeholder:'Capo',type:'number',min:'0',max:'12',value:state.editData.capo||0,
          onInput:e=>{state.editData={...state.editData,capo:parseInt(e.target.value)||0};},
          onBlur:e=>{state.editData={...state.editData,capo:parseInt(e.target.value)||0};}}),
        h('button',{className:'btn btn-primary',style:{padding:'7px 14px'},onClick:()=>saveEdit(song.id)},'Save'),
        h('button',{className:'btn btn-ghost',style:{padding:'7px 12px'},onClick:cancelEdit},'✕')
      )
    );
  }
  const ec=song.energy==='High'?'tag-energy-high':song.energy==='Low'?'tag-energy-low':'tag-energy-med';
  const ei=song.energy==='High'?'🔥':song.energy==='Low'?'💧':'⚡';
  return h('div',{
    className:'song-card',style:{borderLeft:`3px solid ${gc}`,opacity:song.unavailable?0.35:isDetecting?0.6:1},
    draggable:!isGenerated,
    onDragstart:()=>{dragSrcIdx=index;},
    onDragover:e=>e.preventDefault(),
    onDrop:()=>{
      if(dragSrcIdx===null||dragSrcIdx===index)return;
      const arr=[...state.songs];const[m]=arr.splice(dragSrcIdx,1);arr.splice(index,0,m);
      saveToStorage(arr);setState({songs:arr});dragSrcIdx=null;
    }
  },
    h('div',{className:'song-num'},String(index+1).padStart(2,'0')),
    h('div',{className:'song-meta'},
      song.favorite&&h('span',{style:{color:'#e8c93a',fontSize:'13px'}},'★'),
      h('span',{className:'song-title'},song.title),
      song.artist&&h('span',{className:'song-artist'},song.artist),
      h('span',{className:'tag',style:{background:gc+'22',color:gc}},song.genre),
      song.bpm&&h('span',{className:'tag tag-bpm'},song.bpm+' BPM'),
      song.key&&h('span',{className:'tag tag-key'},`${song.key} · ${CAMELOT[song.key]||'?'}`),
      song.duration&&h('span',{className:'tag-dur'},'⏱ '+song.duration),
      song.energy&&h('span',{className:ec},ei+' '+song.energy),
      song.vocal&&h('span',{style:{background:'rgba(58,158,232,0.1)',color:'#3a9ee8',borderRadius:'4px',padding:'2px 7px',fontSize:'10px',fontWeight:'700'}},
        song.vocal==='Female'?'♀':song.vocal==='Male'?'♂':song.vocal==='Duet'?'♀♂':'👥',' '+song.vocal),
      (song.tuning&&song.tuning!=='Standard')&&h('span',{style:{background:'rgba(232,93,58,0.1)',color:'#e85d3a',borderRadius:'4px',padding:'2px 7px',fontSize:'10px',fontWeight:'700'}},song.tuning),
      (song.capo&&song.capo>0)&&h('span',{style:{background:'rgba(232,166,58,0.1)',color:'#e8a63a',borderRadius:'4px',padding:'2px 7px',fontSize:'10px',fontWeight:'700'}},'Capo '+song.capo),
      song.unavailable&&h('span',{style:{background:'rgba(232,93,58,0.12)',color:'#e85d3a',borderRadius:'4px',padding:'2px 7px',fontSize:'10px',fontWeight:'700'}},'Unavailable'),
      song.spotifyId&&h('span',{className:'tag-sp'},'♫ Spotify'),
      isDetecting&&h('span',{className:'detecting'},isDetecting==='verifying'?'verifying…':'detecting…')
    ),
    !isGenerated&&h('div',{className:'song-actions'},
      h('button',{
        className:'icon-btn',
        style:song.favorite?{borderColor:'#e8c93a',color:'#e8c93a'}:{},
        title:song.favorite?'Remove favorite':'Mark as favorite (always include in generated sets)',
        onClick:()=>toggleFavorite(song.id)
      }, song.favorite?'★':'☆'),
      h('button',{
        className:'icon-btn',
        style:song.unavailable?{borderColor:'#e85d3a',color:'#e85d3a'}:{},
        title:song.unavailable?'Mark available':'Mark unavailable',
        onClick:()=>toggleAvailable(song.id)
      }, song.unavailable?'Off':'On'),
      h('button',{className:'icon-btn',style:{color:'#3ae8a6',borderColor:'rgba(58,232,166,0.3)'},
        onClick:()=>verifySong(song),title:'Verify with radio version'},'✓'),
      h('button',{className:'icon-btn',onClick:()=>startEdit(song.id)},'Edit'),
      h('button',{className:'icon-btn danger',onClick:()=>removeSong(song.id)},'✕')
    )
  );
};

const buildReplacePickerModal = () => {
  const rp = state.replacingSong;
  if (!rp) return null;
  const gs = state.generatedSetlist;
  const arr = gs.sets ? gs.sets[rp.setIdx].setlist : gs.setlist;
  const current = arr[rp.songIdx];
  const usedTitles = new Set((gs.sets?gs.sets.flatMap(s=>s.setlist):arr).map(s=>s.title));
  const options = state.songs.filter(s=>!s.unavailable);
  return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,0.8)',backdropFilter:'blur(8px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:'20px'}},
    h('div',{style:{background:'#111',border:'1px solid rgba(255,255,255,0.1)',borderRadius:14,padding:20,width:'100%',maxWidth:420,maxHeight:'70vh',display:'flex',flexDirection:'column'}},
      h('div',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,letterSpacing:2,marginBottom:4}},'REPLACE "'+(current?.title||'')+'"'),
      h('div',{style:{fontSize:11,color:'#555',marginBottom:12}},'Choose a replacement from your library'),
      h('div',{style:{overflow:'auto',flex:1}},
        ...options.map(s=>h('div',{
          style:{padding:'10px 12px',fontSize:13,borderBottom:'1px solid rgba(255,255,255,0.05)',cursor:'pointer',
            display:'flex',justifyContent:'space-between',alignItems:'center',
            opacity: usedTitles.has(s.title)?0.35:1},
          onClick:()=>{
            const gs2=JSON.parse(JSON.stringify(state.generatedSetlist));
            const arr2=gs2.sets?gs2.sets[rp.setIdx].setlist:gs2.setlist;
            arr2[rp.songIdx]={title:s.title,artist:s.artist,tuning:s.tuning||'Standard',capo:s.capo||0,duration:s.duration,energy:s.energy,vocal:s.vocal};
            setState({generatedSetlist:gs2,replacingSong:null});
          }
        },
          h('div',{},
            h('div',{},s.title),
            h('div',{style:{fontSize:11,color:'#666'}},s.artist)
          ),
          h('div',{style:{fontSize:10,color:'#444',textAlign:'right'}},(s.tuning&&s.tuning!=='Standard')?s.tuning:'',usedTitles.has(s.title)?' (in set)':'')
        ))
      ),
      h('button',{className:'btn btn-ghost',style:{marginTop:12,padding:10},onClick:()=>setState({replacingSong:null})},'Cancel')
    )
  );
};

const buildVerificationModal = () => {
  const pv = state.pendingVerification;
  if (!pv) return null;
  const fields = Object.keys(pv.changes);
  if (!fields.length) {
    // No changes found
    setTimeout(()=>setState({pendingVerification:null}),0);
    return null;
  }
  const checked = state.verificationChecked || {};
  const fieldLabels = {bpm:'BPM',key:'Key',tuning:'Tuning',capo:'Capo',energy:'Energy',duration:'Duration',artist:'Artist',genre:'Genre'};
  return h('div',{style:{position:'fixed',inset:0,background:'rgba(0,0,0,0.8)',backdropFilter:'blur(8px)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:'20px'}},
    h('div',{style:{background:'#111',border:'1px solid rgba(255,255,255,0.1)',borderRadius:14,padding:24,width:'100%',maxWidth:460,maxHeight:'80vh',overflow:'auto'}},
      h('div',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,letterSpacing:3,marginBottom:4}},'VERIFY: '+pv.songTitle),
      h('div',{style:{fontSize:11,color:'#555',letterSpacing:1,marginBottom:16}},'SELECT UPDATES TO APPLY'),
      ...fields.map(f => {
        const isChecked = checked[f] !== false; // default checked
        return h('div',{style:{display:'flex',alignItems:'center',gap:12,padding:'10px 0',borderBottom:'1px solid rgba(255,255,255,0.05)'}},
          h('input',{type:'checkbox',checked:isChecked,style:{width:16,height:16,cursor:'pointer'},
            onChange:e=>setState({verificationChecked:{...state.verificationChecked,[f]:e.target.checked}})}),
          h('div',{style:{flex:1}},
            h('div',{style:{fontSize:11,color:'#666',letterSpacing:1}},fieldLabels[f]||f.toUpperCase()),
            h('div',{style:{display:'flex',gap:8,alignItems:'center',marginTop:2}},
              h('span',{style:{fontSize:12,color:'#555',textDecoration:'line-through'}},(pv.changes[f].old||'—')),
              h('span',{style:{color:'#555'}},'→'),
              h('span',{style:{fontSize:13,color:'#3ae8a6',fontWeight:700}},pv.changes[f].new)
            )
          )
        );
      }),
      h('div',{style:{display:'flex',gap:10,marginTop:20}},
        h('button',{className:'btn btn-primary',style:{flex:1,padding:12,fontFamily:"'Bebas Neue',sans-serif",fontSize:14,letterSpacing:2},
          onClick:()=>{
            const approved = fields.filter(f=>state.verificationChecked?.[f]!==false);
            applyVerification(pv.songId, approved);
            setState({verificationChecked:{}});
          }},'Apply Selected'),
        h('button',{className:'btn btn-ghost',style:{padding:12},
          onClick:()=>setState({pendingVerification:null,verificationChecked:{}})},'Cancel')
      )
    )
  );
};

const buildKeyTab = () => {
  const {songs}=state;
  if(songs.length<2) return h('div',{className:'empty-state'},h('div',{className:'empty-icon'},'🎹'),'Add at least 2 songs\nto see key & tempo analysis');
  const rows=[];
  songs.forEach((song,i)=>{
    if(i>0){
      const prev=songs[i-1];
      const compat=camelotCompat(prev.key,song.key);
      const cc=compatColor(compat);
      const bpmDiff=prev.bpm&&song.bpm?Math.abs(parseInt(prev.bpm)-parseInt(song.bpm)):null;
      const cl=compat==='perfect'?'✦ PERFECT MATCH':compat==='good'?'↕ GOOD TRANSITION':'⚠ KEY CLASH';
      rows.push(h('div',{className:'key-connector'},
        h('div',{className:'key-line'}),
        h('span',{className:'compat-label',style:{color:cc}},cl),
        bpmDiff!==null&&h('span',{style:{fontSize:'10px',color:bpmDiff>20?'#e85d3a':bpmDiff>10?'#e8a63a':'#444'}},
          bpmDiff===0?' · Same BPM':` · Δ${bpmDiff} BPM`)
      ));
    }
    rows.push(h('div',{className:'key-row',style:{borderLeft:i>0?`2px solid ${compatColor(camelotCompat(songs[i-1]?.key,song.key))}33`:'2px solid transparent'}},
      h('span',{style:{color:'#444',fontSize:'11px',fontFamily:'monospace',minWidth:'20px'}},String(i+1).padStart(2,'0')),
      h('span',{style:{flex:1,fontFamily:"'Bebas Neue',sans-serif",fontSize:'14px',letterSpacing:'1px'}},song.title),
      song.key&&h('span',{className:'tag tag-key'},`${song.key} · ${CAMELOT[song.key]||'?'}`),
      song.bpm&&h('span',{style:{color:'#555',fontSize:'11px'}},song.bpm+' BPM')
    ));
  });
  return h('div',{},
    h('div',{className:'label'},'Transition Compatibility — Camelot Wheel'),
    ...rows,
    h('div',{className:'key-legend'},
      h('span',{style:{color:'#3ae8a6'}},'✦ Perfect'),' — same position   ·   ',
      h('span',{style:{color:'#e8a63a'}},'↕ Good'),' — adjacent/relative   ·   ',
      h('span',{style:{color:'#e85d3a'}},'⚠ Clash'),' — key conflict',
      state.analysis?.keyFlowNotes&&h('div',{style:{marginTop:'8px',color:'#555',fontStyle:'italic'}},state.analysis.keyFlowNotes)
    )
  );
};

const buildGenerateTab = () => {
  const {targetMinutes,numberOfSets,breakMinutes,loadingGenerate,generatedSetlist}=state;
  return h('div',{},
    h('div',{className:'generate-panel'},
      h('div',{className:'label'},'🎵 Auto-Generate Setlist'),
      h('div',{style:{display:'flex',gap:'6px',marginBottom:'10px',flexWrap:'wrap'}},
        h('span',{style:{fontSize:'11px',color:'#666',alignSelf:'center'}},'Vocalists available:'),
        ...['Male','Female','Both'].map(v=>h('button',{
          style:{fontSize:'12px',padding:'5px 12px',borderRadius:'6px',border:'none',cursor:'pointer',fontWeight:'700',
            background:state.availableVocalists===v?'#e85d3a':'rgba(255,255,255,0.06)',
            color:state.availableVocalists===v?'#fff':'#666'},
          onClick:()=>setState({availableVocalists:v})},v))
      ),
      h('div',{style:{display:'flex',flexWrap:'wrap',gap:'12px',marginBottom:'10px',alignItems:'center'}},
        // Sets stepper
        h('div',{style:{display:'flex',alignItems:'center',gap:'6px'}},
          h('span',{style:{fontSize:'11px',color:'#666',letterSpacing:'1px'}},'SETS'),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({numberOfSets:Math.max(1,numberOfSets-1)})},'−'),
          h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'22px',color:'#fff',minWidth:'20px',textAlign:'center'}},numberOfSets),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({numberOfSets:Math.min(5,numberOfSets+1)})},'＋')
        ),
        // Minutes stepper
        h('div',{style:{display:'flex',alignItems:'center',gap:'6px'}},
          h('span',{style:{fontSize:'11px',color:'#666',letterSpacing:'1px'}},'MINS'),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({targetMinutes:Math.max(15,targetMinutes-5)})},'−'),
          h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'22px',color:'#fff',minWidth:'36px',textAlign:'center'}},targetMinutes),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({targetMinutes:Math.min(180,targetMinutes+5)})},'＋')
        ),
        // Break stepper (only when multiple sets)
        numberOfSets>1&&h('div',{style:{display:'flex',alignItems:'center',gap:'6px'}},
          h('span',{style:{fontSize:'11px',color:'#666',letterSpacing:'1px'}},'BREAK'),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({breakMinutes:Math.max(5,breakMinutes-5)})},'−'),
          h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'22px',color:'#fff',minWidth:'32px',textAlign:'center'}},breakMinutes),
          h('button',{className:'btn btn-ghost',style:{padding:'4px 10px',fontSize:'16px'},
            onClick:()=>setState({breakMinutes:Math.min(60,breakMinutes+5)})},'＋'),
          h('span',{style:{fontSize:'11px',color:'#555'}})
        )
      ),
      h('p',{style:{fontSize:'11px',color:'#444',marginBottom:'12px',marginTop:'6px',lineHeight:'1.6'}},
        numberOfSets>1
          ? `${numberOfSets} sets × ${targetMinutes} min + ${numberOfSets-1} breaks × ${breakMinutes} min = ~${numberOfSets*targetMinutes+(numberOfSets-1)*breakMinutes} min total`
          : `~${Math.round(targetMinutes/3.5)} songs to fill ${targetMinutes} minutes`
      ),
      h('button',{className:`btn btn-primary btn-full ${loadingGenerate?'btn-disabled':''}`,
        style:{letterSpacing:'2px',fontFamily:"'Bebas Neue',sans-serif",fontSize:'15px'},
        onClick:loadingGenerate?null:generateSetlist},loadingGenerate?'GENERATING…':'✦ GENERATE SETLIST')
    ),
    loadingGenerate&&h('div',{className:'loading-panel',style:{marginTop:'14px'}},
      h('div',{className:'loading-text'},'BUILDING YOUR SET…'),
      h('div',{className:'loading-sub'},'Selecting songs, sequencing energy arc, finding swaps')
    ),
    generatedSetlist&&h('div',{style:{marginTop:'14px'}},
      h('div',{style:{display:'flex',alignItems:'center',gap:'10px',marginBottom:'12px',flexWrap:'wrap'}},
        h('div',{className:'label',style:{margin:0}},'Generated Setlist'),
        h('span',{className:'generated-badge'},`~${generatedSetlist.totalEstimatedMinutes} min`),
        h('button',{className:'btn btn-primary',style:{fontSize:'12px',padding:'6px 14px',marginLeft:'auto'},
          onClick:applyGeneratedSetlist},'💾 Save Setlist')
      ),
      generatedSetlist.notes&&h('p',{style:{fontSize:'12px',color:'#666',marginBottom:'12px',lineHeight:'1.6',fontStyle:'italic'}},generatedSetlist.notes),
      ...(generatedSetlist.sets||[generatedSetlist]).map((setObj,setIdx)=>{
        const setKey = 'set_'+setIdx;
        const songs = setObj.setlist || setObj;
        if (!Array.isArray(songs)) return null;
        return h('div',{},
          generatedSetlist.sets&&h('div',{style:{fontSize:'11px',fontWeight:'700',letterSpacing:'2px',color:'#e85d3a',marginBottom:'6px',marginTop:setIdx>0?'14px':'0'}},'SET '+(setIdx+1)),
          ...songs.map((song,i)=>{
            const gc=gcColor(song.genre);
            return h('div',{
              className:'generated-song',
              style:{borderLeft:`3px solid ${gc}`,cursor:'grab'},
              draggable:true,
              onDragstart:()=>{ state._genDragIdx=i; state._genDragSet=setIdx; },
              onDragover:e=>e.preventDefault(),
              onDrop:()=>{
                const fi=state._genDragIdx, fs=state._genDragSet;
                if(fi===null||fi===undefined) return;
                const gs = JSON.parse(JSON.stringify(state.generatedSetlist));
                const getArr = idx => gs.sets ? gs.sets[idx].setlist : gs.setlist;
                const fromArr = getArr(fs);
                const toArr = getArr(setIdx);
                if (fs===setIdx) {
                  if(fi===i) return;
                  const [moved]=fromArr.splice(fi,1); fromArr.splice(i,0,moved);
                } else {
                  const [moved]=fromArr.splice(fi,1);
                  toArr.splice(i,0,moved);
                }
                state._genDragIdx=null; state._genDragSet=null;
                setState({generatedSetlist:gs});
              }
            },
              h('span',{style:{color:'#444',fontSize:'12px',marginRight:'4px',cursor:'grab'}},'⠿'),
              h('span',{style:{color:'#333',fontSize:'11px',fontFamily:'monospace',minWidth:'20px'}},String(i+1).padStart(2,'0')),
              h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'14px',flex:1}},song.title),
              song.artist&&h('span',{style:{color:'#666',fontSize:'11px'}},song.artist),
              song.duration&&h('span',{style:{color:'#444',fontSize:'10px'}},'⏱ '+song.duration),
              h('button',{style:{background:'none',border:'none',color:'#3a9ee8',cursor:'pointer',fontSize:'11px',padding:'0 4px'},
                onClick:()=>setState({replacingSong:{setIdx,songIdx:i}})
              },'⇄'),
              h('button',{style:{background:'none',border:'none',color:'#e85d3a',cursor:'pointer',fontSize:'13px',padding:'0 4px'},
                onClick:()=>{
                  const gs=JSON.parse(JSON.stringify(state.generatedSetlist));
                  const arr=gs.sets?gs.sets[setIdx].setlist:gs.setlist;
                  arr.splice(i,1);
                  setState({generatedSetlist:gs});
                }},'✕')
            );
          }),
          // End-of-set drop zone
          h('div',{
            style:{height:'24px',border:'1px dashed rgba(255,255,255,0.06)',borderRadius:'6px',marginTop:'4px',
              display:'flex',alignItems:'center',justifyContent:'center',fontSize:'10px',color:'#444'},
            onDragover:e=>e.preventDefault(),
            onDrop:()=>{
              const fi=state._genDragIdx, fs=state._genDragSet;
              if(fi===null||fi===undefined) return;
              const gs = JSON.parse(JSON.stringify(state.generatedSetlist));
              const getArr = idx => gs.sets ? gs.sets[idx].setlist : gs.setlist;
              const fromArr = getArr(fs), toArr = getArr(setIdx);
              const [moved]=fromArr.splice(fi,1);
              toArr.push(moved);
              state._genDragIdx=null; state._genDragSet=null;
              setState({generatedSetlist:gs});
            }
          }, 'drop here to move to end of set'),
          // Add song to this set from library
          h('button',{
            className:'btn btn-ghost', style:{fontSize:'11px',padding:'5px 10px',marginTop:'6px',width:'100%'},
            onClick:()=>setState({addingToSet:setIdx})
          }, '+ Add Song to Set '+(setIdx+1)),
          state.addingToSet===setIdx && h('div',{style:{marginTop:'6px',maxHeight:'160px',overflow:'auto',border:'1px solid rgba(255,255,255,0.06)',borderRadius:'6px'}},
            ...state.songs.filter(s=>!s.unavailable).map(s=>h('div',{
              style:{padding:'8px 10px',fontSize:'12px',borderBottom:'1px solid rgba(255,255,255,0.04)',cursor:'pointer',display:'flex',justifyContent:'space-between'},
              onClick:()=>{
                const gs=JSON.parse(JSON.stringify(state.generatedSetlist));
                const arr=gs.sets?gs.sets[setIdx].setlist:gs.setlist;
                arr.push({title:s.title,artist:s.artist,tuning:s.tuning||'Standard',capo:s.capo||0,duration:s.duration,energy:s.energy,vocal:s.vocal});
                setState({generatedSetlist:gs,addingToSet:null});
              }
            },
              h('span',{},s.title),
              h('span',{style:{color:'#555'}},s.artist)
            ))
          ),
          generatedSetlist.sets&&setIdx<generatedSetlist.sets.length-1&&
            h('div',{style:{textAlign:'center',padding:'8px',color:'#555',fontSize:'11px',letterSpacing:'2px',borderTop:'1px solid rgba(255,255,255,0.05)',marginTop:'4px'}},'— BREAK '+state.breakMinutes+' MIN —')
        );
      }),
      generatedSetlist.swaps?.length&&h('div',{style:{marginTop:'16px'}},
        h('div',{className:'label'},'🔄 Swap Suggestions'),
        ...generatedSetlist.swaps.map(sw=>h('div',{className:'swap-item'},
          h('div',{className:'swap-remove'},`Remove: "${sw.remove}"`),
          h('div',{className:'swap-add'},`Add: "${sw.add}" — ${sw.artist}`),
          h('div',{className:'swap-reason'},sw.reason)
        ))
      )
    )
  );
};

const buildAnalysisPanel = () => {
  const {analysis,loading}=state;
  if(loading) return h('div',{className:'loading-panel'},h('div',{className:'loading-text'},'ANALYZING YOUR SET…'),h('div',{className:'loading-sub'},'Reviewing energy arcs, key flow & pacing'));
  if(!analysis) return h('div',{className:'placeholder-panel'},h('div',{className:'placeholder-icon'},'🎙️'),h('div',{className:'placeholder-text'},'Add songs then click\n"Optimize My Setlist"\nfor AI-powered suggestions'));
  const sc=analysis.flowScore>=8?'#3ae8a6':analysis.flowScore>=5?'#e8a63a':'#e85d3a';
  return h('div',{className:'analysis-panel'},
    h('div',{className:'score-card'},
      h('div',{},h('div',{className:'score-num',style:{color:sc}},analysis.flowScore),h('div',{className:'score-lbl'},'FLOW SCORE')),
      h('div',{},h('div',{className:'score-text'},analysis.assessment),h('div',{className:'score-note'},analysis.flowScoreNote))
    ),
    h('div',{className:'section'},h('div',{className:'section-title',style:{color:'#e8a63a'}},'⚡ Energy Arc'),h('p',{style:{color:'#bbb',fontSize:'13px',lineHeight:'1.6',margin:0}},analysis.energyArc)),
    h('div',{className:'section'},
      h('div',{className:'section-title',style:{color:'#3a9ee8'}},'↕ Songs to Move'),
      ...(analysis.moves||[]).map(m=>h('div',{className:'section-item'},
        h('div',{className:'item-head'},
          h('span',{className:'item-title'},`"${m.song}"`),
          h('span',{className:'item-badge',style:{background:'rgba(58,158,232,0.12)',color:'#3a9ee8'}},`#${m.currentPos} → #${m.suggestedPos}`),
          h('button',{className:'btn',style:{fontSize:'11px',padding:'3px 10px',background:'rgba(58,158,232,0.15)',color:'#3a9ee8',border:'1px solid rgba(58,158,232,0.3)',marginLeft:'auto'},
            onClick:()=>applyMove(m.song,m.suggestedPos)},'Apply')
        ),
        h('div',{className:'item-reason'},m.reason)))
    ),
    h('div',{className:'section'},
      h('div',{className:'section-title',style:{color:'#a63ae8'}},'🔄 Songs to Replace'),
      ...(analysis.replacements||[]).map(r=>h('div',{className:'section-item'},
        h('div',{className:'item-title'},`"${r.song}"`),h('div',{className:'item-reason'},r.reason),h('div',{className:'item-suggest',style:{color:'#a63ae8'}},'💡 '+r.suggestion)))
    ),
    h('div',{className:'section'},
      h('div',{className:'section-title',style:{color:'#3ae8a6'}},'+  Songs to Add'),
      ...(analysis.additions||[]).map(a=>h('div',{className:'section-item'},
        h('div',{className:'item-head'},h('span',{className:'item-title'},`"${a.title}"`),h('span',{style:{color:'#666',fontSize:'12px'}},'— '+a.artist),h('span',{className:'item-badge',style:{background:'rgba(58,232,166,0.1)',color:'#3ae8a6'}},a.position)),
        h('div',{className:'item-reason'},a.reason)))
    )
  );
};

const buildSettingsModal = () => {
  const {apiKey,spClientId}=state;
  const connected = isSpotifyConnected();
  const redirectUri = getRedirectUri();
  return h('div',{className:'settings-modal',onClick:e=>e.target===e.currentTarget&&setState({showSettings:false})},
    h('div',{className:'settings-box'},
      h('div',{className:'modal-title'},'SETTINGS'),
      h('div',{className:'modal-sub'},'Configure your Setlist Optimizer'),

      // Anthropic
      h('div',{className:'settings-section'},
        h('div',{className:'settings-section-title'},'🤖 Anthropic API'),
        h('div',{className:'field-label'},'API KEY'),
        h('p',{className:'field-hint'},'Get your key at ',h('a',{href:'https://console.anthropic.com',target:'_blank',style:{color:'#e8a63a'}},'console.anthropic.com'),'. Stored locally only.'),
        h('div',{className:'api-inp-wrap',style:{marginTop:'8px'}},
          h('input',{className:'inp',type:'password',placeholder:'sk-ant-…',value:apiKey,onInput:e=>setState({apiKey:e.target.value})}),
          h('button',{className:'btn btn-primary',onClick:()=>{localStorage.setItem(API_KEY_STORE,state.apiKey);setState({showSettings:false});}},'Save')
        )
      ),

      // Spotify — Client ID + one-time OAuth login
      h('div',{className:'settings-section'},
        h('div',{className:'settings-section-title',style:{color:'#1DB954'}},'♫ Spotify',
          isSpotifyConnected()&&h('span',{style:{fontSize:'10px',color:'#1DB954',fontWeight:'normal',marginLeft:'8px'}},'● Connected')
        ),
        isSpotifyConnected()
          ? h('div',{},
              h('p',{className:'field-hint',style:{color:'#555',marginBottom:'10px'}},'Connected! Paste a playlist URL and tap Import.'),
              h('button',{className:'btn btn-ghost',style:{fontSize:'12px'},onClick:()=>{
                [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
                setState({showSettings:false,spotifyStatus:null});
              }},'Disconnect')
            )
          : h('div',{},
              h('p',{className:'field-hint',style:{marginBottom:'10px'}},
                '1. Go to ',h('a',{href:'https://developer.spotify.com/dashboard',target:'_blank',style:{color:'#1DB954'}},'developer.spotify.com/dashboard'),
                ' → create a free app → copy your Client ID.'
              ),
              h('p',{className:'field-hint',style:{marginBottom:'10px'}},
                '2. In the Spotify app settings add this Redirect URI:',h('br',{}),
                h('code',{style:{color:'#1DB954',fontSize:'11px',display:'block',marginTop:'4px',padding:'6px 8px',background:'rgba(29,185,84,0.08)',borderRadius:'4px',wordBreak:'break-all'}},getRedirectUri())
              ),
              h('p',{className:'field-hint',style:{marginBottom:'10px'}},'3. Paste Client ID below and tap Save — then import any playlist to log in once.'),
              h('div',{className:'api-inp-wrap'},
                h('input',{className:'inp',placeholder:'Paste Client ID',value:state.spClientId||'',
                  onInput:e=>{state.spClientId=e.target.value;}}),
                h('button',{className:'btn btn-green',onClick:()=>{
                  const id=(state.spClientId||'').trim();
                  if(!id)return;
                  localStorage.setItem(SP_CLIENT_STORE,id);
                  [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
                  setState({showSettings:false,spotifyStatus:{ok:null,msg:'Client ID saved — paste a playlist URL and tap Import'}});
                }},'Save')
              )
            )
      ),

      h('div',{style:{display:'flex',justifyContent:'flex-end'}},
        h('button',{className:'btn btn-ghost',onClick:()=>setState({showSettings:false})},'Close')
      )
    )
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP BUILDER
// ─────────────────────────────────────────────────────────────────────────────
const buildApp = () => {
  const {songs,vocalType,tab,analysis,loading,error,newSong,showSettings,showInstall,installPrompt,loadingSpotify,spotifyUrl,spotifyStatus}=state;
  const totalSec=totalDuration(songs);
  const hasApiKey=!!localStorage.getItem(API_KEY_STORE);
  const hasSpotify=!!localStorage.getItem(SP_CLIENT_STORE);

  const fileInput=h('input',{type:'file',accept:'.csv',style:{display:'none'},id:'csv-upload',onChange:handleCSV});

  const header=h('div',{className:'header'},
    h('div',{},
      h('div',{className:'logo'},'Setlist ',h('span',{},'Optimizer')),
      h('div',{className:'tagline'},'AI-Powered Performance Sequencing'),
      h('div',{style:{marginTop:'8px',display:'flex',gap:'6px',alignItems:'center',flexWrap:'wrap'}},
        h('select',{
          value: state.activeBand,
          style:{background:'rgba(255,255,255,0.05)',border:'1px solid rgba(255,255,255,0.1)',color:'#fff',borderRadius:'6px',padding:'5px 10px',fontSize:'12px',fontWeight:'700'},
          onChange:e=>{
            if (e.target.value==='__add__') {
              const name = prompt('Name of new band / library:');
              if (name) addBand(name);
            } else {
              switchBand(e.target.value);
            }
          }
        },
          ...state.bands.map(b=>h('option',{value:b},b)),
          h('option',{value:'__add__'},'+ Add new band...')
        ),
        h('button',{style:{background:'none',border:'none',color:'#555',cursor:'pointer',fontSize:'11px',textDecoration:'underline'},
          onClick:()=>{
            const newName = prompt('Rename "'+state.activeBand+'" to:', state.activeBand);
            if (newName) renameBand(state.activeBand, newName);
          }},'rename'),
        state.bands.length>1&&h('button',{style:{background:'none',border:'none',color:'#e85d3a',cursor:'pointer',fontSize:'11px',textDecoration:'underline'},
          onClick:()=>deleteBand(state.activeBand)},'delete')
      )
    ),
    h('div',{className:'header-right'},
      songs.length>0&&h('div',{className:'duration-badge'},
        h('div',{className:'duration-val'},formatTotal(totalSec)),
        h('div',{className:'duration-lbl'},'Total Duration')
      ),
      h('div',{className:'vocal-toggle'},
        ...VOCAL_OPTIONS.map(v=>h('button',{className:`vocal-btn ${vocalType===v?'active':''}`,onClick:()=>setState({vocalType:v})},v))
      ),
      h('button',{className:'btn-settings',onClick:()=>setState({showSettings:true})},'⚙ Settings')
    )
  );

  const apiBanner=!hasApiKey&&h('div',{className:'api-banner'},
    h('p',{},'⚠ No API key set. AI features need an Anthropic API key. ',h('a',{href:'https://console.anthropic.com',target:'_blank'},'Get one here'),'.'),
    h('button',{className:'btn btn-ghost',style:{padding:'6px 14px',fontSize:'12px'},onClick:()=>setState({showSettings:true})},'Add Key')
  );

  // Spotify import box (always visible in the add-song card)
  const spotifyBox=h('div',{className:'sp-import-box'},
    h('div',{className:'sp-import-title'},
      '♫ Import from Spotify',
      !hasSpotify&&h('span',{style:{fontSize:'10px',color:'#555',fontWeight:'normal',letterSpacing:'0'}},' — add Client ID in ⚙ Settings')
    ),
    h('div',{className:'sp-import-row'},
      h('input',{className:'inp',placeholder:'Paste Spotify playlist URL or URI…',id:'spotify-url-inp',
        onKeydown:e=>e.key==='Enter'&&importFromSpotify()
      }),
      h('button',{
        className:`btn btn-green ${loadingSpotify?'btn-disabled':''}`,
        style:{whiteSpace:'nowrap',flexShrink:0},
        onClick:loadingSpotify?null:async()=>{
          // If there's a pending code from OAuth callback, exchange it first
          if(sessionStorage.getItem('sp_code')&&sessionStorage.getItem('sp_ready')){
            const ok = await completeSpotifyLogin();
            if(!ok) return;
            // Now do the import with fresh token
            const urlEl=document.getElementById('spotify-url-inp');
            const url=(urlEl?.value||state.spotifyUrl||'').trim();
            if(url) importFromSpotify(url);
            return;
          }
          const urlEl=document.getElementById('spotify-url-inp');
          const url=(urlEl?.value||state.spotifyUrl||'').trim();
          if(!url){setState({spotifyStatus:{ok:false,msg:'Paste a playlist URL first'}});return;}
          if(!localStorage.getItem(SP_CLIENT_STORE)){setState({spotifyStatus:{ok:false,msg:'Add Client ID in ⚙ Settings'}});return;}
          if(!getUserToken()){startSpotifyOAuth(url);return;}
          importFromSpotify(url);
        }
      },loadingSpotify?'Importing…':'Import')
    ),
    loadingSpotify&&h('div',{className:'sp-loading'},'FETCHING PLAYLIST…'),
    spotifyStatus&&h('div',{className:`sp-status ${spotifyStatus.ok?'ok':'err'}`},spotifyStatus.msg)
  );

  const addForm=h('div',{className:'card'},
    h('div',{className:'label',style:{marginBottom:'10px'}},'ADD SONGS'),
    spotifyBox,
    h('div',{className:'label',style:{marginTop:'4px',marginBottom:'8px'}},'Or add manually'),
    h('div',{className:'add-form'},
      h('input',{className:'inp',placeholder:'Song title *',id:'new-title',
        defaultValue:newSong.title||'',
        onInput:e=>{state.newSong.title=e.target.value;},
        onKeydown:e=>e.key==='Enter'&&addSong()}),
      h('input',{className:'inp inp-md',placeholder:'Artist',id:'new-artist',
        defaultValue:newSong.artist||'',
        onInput:e=>{state.newSong.artist=e.target.value;}}),
      h('select',{className:'inp inp-md',value:newSong.genre,onChange:e=>{state.newSong.genre=e.target.value;}},
        ...Object.keys(GENRE_COLORS).map(g=>h('option',{value:g},g))),
      h('select',{className:'inp inp-sm',value:newSong.vocal||'',onChange:e=>{state.newSong.vocal=e.target.value;}},
        h('option',{value:''},'Vocal'),
        ['Male','Female','Duet','Group'].map(v=>h('option',{value:v},v))),
      h('select',{className:'inp inp-sm',value:newSong.tuning||'Standard',onChange:e=>{state.newSong.tuning=e.target.value;}},
        ['Standard','Drop D','Open G','Open D','Open E','DADGAD','Half Step Down','Full Step Down'].map(t=>h('option',{value:t},t))),
      h('input',{className:'inp inp-sm',placeholder:'Capo',type:'number',min:'0',max:'12',
        defaultValue:newSong.capo||0,id:'new-capo',
        onInput:e=>{state.newSong.capo=parseInt(e.target.value)||0;}})
    ),
    h('div',{style:{display:'flex',gap:'8px',marginTop:'10px',flexWrap:'wrap'}},
      h('button',{className:'btn btn-primary',onClick:addSong},'+ Add Song'),
      h('button',{className:'btn btn-ghost',onClick:()=>document.getElementById('csv-upload').click()},'↑ CSV'),
      h('button',{className:'btn btn-ghost',onClick:exportLibrary},'↓ Backup'),
      h('button',{className:'btn btn-ghost',onClick:()=>document.getElementById('lib-import').click()},'↑ Restore'),
      h('input',{type:'file',accept:'.json',style:{display:'none'},id:'lib-import',onChange:e=>{if(e.target.files[0])importLibrary(e.target.files[0]);e.target.value='';}}),
      songs.length>0&&h('button',{className:'btn btn-ghost',style:{marginLeft:'auto'},onClick:()=>exportPDF(songs,analysis,vocalType,state.generatedSetlist)},'↓ PDF')
    ),
    h('div',{className:'hint'},'CSV columns: title, artist, genre, bpm, key, duration, energy'),
    fileInput
  );

  const tabs=h('div',{className:'tabs'},
    h('button',{className:`tab ${tab==='setlist'?'active':''}`,onClick:()=>setState({tab:'setlist'})},'🎵 Setlist'),
    h('button',{className:`tab ${tab==='keys'?'active':''}`,onClick:()=>setState({tab:'keys'})},'🎹 Key / Tempo'),
    h('button',{className:`tab ${tab==='generate'?'active':''}`,onClick:()=>setState({tab:'generate'})},
      '✨ Generate',state.generatedSetlist?h('span',{className:'generated-badge',style:{marginLeft:'6px'}},'✓'):null),
    h('button',{className:`tab ${tab==='setlists'?'active':''}`,onClick:()=>setState({tab:'setlists'})},
      '📋 Saved',(state.savedSetlists||[]).length>0?h('span',{className:'generated-badge',style:{marginLeft:'6px'}},(state.savedSetlists||[]).length):null),
    h('span',{className:'song-count'},`${songs.length} songs`)
  );

  const buildSavedSetlistsTab = () => {
    const saved = state.savedSetlists||[];
    if (!saved.length) return h('div',{className:'empty-state'},h('div',{className:'empty-icon'},'📋'),'No saved setlists yet — generate one and tap Save Setlist');
    return h('div',{},
      h('div',{className:'label'},'Saved Setlists'),
      state.viewingSetlist&&h('div',{style:{background:'rgba(58,232,166,0.08)',border:'1px solid rgba(58,232,166,0.2)',borderRadius:6,padding:'8px 12px',marginBottom:'10px',fontSize:'12px',color:'#3ae8a6',display:'flex',justifyContent:'space-between',alignItems:'center'}},
        'Optimize will analyze: '+((saved.find(s=>s.id===state.viewingSetlist)||{}).name||''),
        h('button',{style:{background:'none',border:'none',color:'#3ae8a6',cursor:'pointer',fontSize:'11px',textDecoration:'underline'},onClick:()=>setState({viewingSetlist:null})},'Clear')
      ),
      ...saved.map(sl=>h('div',{style:{background:state.viewingSetlist===sl.id?'rgba(58,232,166,0.06)':'rgba(255,255,255,0.03)',border:state.viewingSetlist===sl.id?'1px solid rgba(58,232,166,0.3)':'1px solid rgba(255,255,255,0.07)',borderRadius:8,padding:'12px 14px',marginBottom:'8px'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:'8px',marginBottom:'6px',flexWrap:'wrap'}},
          h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'15px',letterSpacing:'1px',flex:1}},sl.name),
          h('span',{style:{color:'#555',fontSize:'11px'}},sl.songs.length+' songs'),
          h('button',{className:'btn',style:{fontSize:'11px',padding:'4px 10px',
            background:state.viewingSetlist===sl.id?'rgba(58,232,166,0.25)':'rgba(58,158,232,0.12)',
            color:state.viewingSetlist===sl.id?'#3ae8a6':'#3a9ee8',
            border:'1px solid rgba(58,158,232,0.2)'},
            onClick:()=>setState({viewingSetlist:state.viewingSetlist===sl.id?null:sl.id, generatedSetlist:null})},
            state.viewingSetlist===sl.id?'Selected ✓':'Select for Optimize'),
          h('button',{className:'btn',style:{fontSize:'11px',padding:'4px 10px',background:'rgba(58,232,166,0.12)',color:'#3ae8a6',border:'1px solid rgba(58,232,166,0.2)'},
            onClick:()=>loadSavedSetlistToMain(sl.id)},'Load to Main'),
          h('button',{className:'icon-btn danger',onClick:()=>deleteSavedSetlist(sl.id)},'✕')
        ),
        h('div',{style:{display:'flex',flexWrap:'wrap',gap:'4px'}},
          ...sl.songs.slice(0,5).map(s=>h('span',{style:{fontSize:'11px',color:'#555',background:'rgba(255,255,255,0.04)',padding:'2px 7px',borderRadius:'4px'}},s.title)),
          sl.songs.length>5&&h('span',{style:{fontSize:'11px',color:'#444'}},`+${sl.songs.length-5} more`)
        )
      ))
    );
  };

  let tabContent;
  if(tab==='setlist') tabContent=songs.length===0?h('div',{className:'empty-state'},h('div',{className:'empty-icon'},'🎙️'),'No songs yet — add above or upload a CSV'):h('div',{},...songs.map((s,i)=>buildSongCard(s,i)));
  else if(tab==='keys') tabContent=buildKeyTab();
  else if(tab==='generate') tabContent=buildGenerateTab();
  else if(tab==='setlists') tabContent=buildSavedSetlistsTab();
  else tabContent=buildGenerateTab();

  const target = getAnalysisTarget();
  const optimizeBtn=songs.length>0&&h('div',{style:{marginTop:'18px'}},
    h('div',{style:{fontSize:'11px',color:'#555',marginBottom:'6px',letterSpacing:'1px'}},'Will analyze: '+target.label+' ('+target.songs.length+' songs)'),
    h('button',{className:`btn btn-primary btn-full ${loading?'btn-disabled':''}`,onClick:loading?null:analyze},loading?'ANALYZING…':'✦ Optimize'),
    error&&h('div',{className:'error-text'},error)
  );

  const grid=h('div',{className:'grid'},
    h('div',{},addForm,tabs,tabContent,optimizeBtn),
    h('div',{},h('div',{className:'label'},'AI Analysis'+(state.analysisTarget?' — '+state.analysisTarget:'')),buildAnalysisPanel())
  );

  const installToast=showInstall&&h('div',{className:'install-toast'},
    h('span',{className:'install-text'},'📲 Add Setlist Optimizer to your home screen'),
    h('button',{className:'btn btn-primary',style:{padding:'7px 14px',fontSize:'12px'},onClick:()=>{installPrompt?.prompt();setState({showInstall:false});}},'Install'),
    h('button',{className:'btn btn-ghost',style:{padding:'7px 10px',fontSize:'12px'},onClick:()=>setState({showInstall:false})},'✕')
  );

  return h('div',{className:'app'},
    header,
    apiBanner||'',
    grid,
    buildVerificationModal()||'',
    buildReplacePickerModal()||'',
    showSettings&&buildSettingsModal(),
    installToast||''
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: arrived from Spotify with ?code= — save to sessionStorage immediately
// Do NOT navigate away — just clean the URL and let handleSpotifyCallback do the exchange
(function() {
  const sp = new URLSearchParams(window.location.search);
  const code = sp.get('code');
  if (code) {
    sessionStorage.setItem('sp_code', code);
    sessionStorage.setItem('sp_state', sp.get('state')||'');
    sessionStorage.setItem('sp_ready', '1');
    // Clean URL without navigating away
    window.history.replaceState({}, '', window.location.pathname);
  }
})();

injectStyles();
rootEl=document.getElementById('root');
render();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();setState({installPrompt:e,showInstall:true});});

// Pre-generate PKCE values so redirect can happen purely synchronously on tap
const prepPKCE = async () => {
  const verifier = generateRandom(64);
  const challenge = await sha256b64(verifier);
  const oauthState = generateRandom(16);
  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('pkce_challenge', challenge);
  sessionStorage.setItem('pkce_state', oauthState);
};
prepPKCE();

// Handle Spotify PKCE callback — check both URL params and sessionStorage
(async () => {
  const hasCode = sessionStorage.getItem('sp_ready') && sessionStorage.getItem('sp_code');
  const p = new URLSearchParams(window.location.search);
  const urlCode = p.get('code');
  
  // If there's a code in the URL that phase 1 missed, save it now
  if (urlCode && !hasCode) {
    sessionStorage.setItem('sp_code', urlCode);
    sessionStorage.setItem('sp_state', p.get('state')||'');
    sessionStorage.setItem('sp_ready', '1');
    window.history.replaceState({}, '', window.location.pathname);
  }
  
  if (!hasCode && !urlCode) return; // normal page load

  // Show status
  const dbg = document.getElementById('error-display');
  if (dbg) { dbg.style.display='block'; dbg.style.color='#3ae8a6'; dbg.textContent='Connecting to Spotify...'; }

  await handleSpotifyCallback();
})();
