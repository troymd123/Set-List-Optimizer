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
const STORAGE_KEY      = 'setlist_songs_v2';
const SETLISTS_KEY     = 'setlist_saved_v1';
const BACKUP_KEY       = 'setlist_backup_v1'; // secondary backup key

// Save to both primary and backup keys for resilience
const loadFromStorage = () => {
  try {
    const primary = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (primary?.length) return primary;
    // Try backup if primary is empty
    const backup = JSON.parse(localStorage.getItem(BACKUP_KEY));
    if (backup?.length) { localStorage.setItem(STORAGE_KEY, JSON.stringify(backup)); return backup; }
    return [];
  } catch(e) { return []; }
};
const saveToStorage = songs => {
  try {
    const data = JSON.stringify(songs);
    localStorage.setItem(STORAGE_KEY, data);
    localStorage.setItem(BACKUP_KEY, data); // mirror to backup
  } catch(e) {}
};
const loadSavedSetlists = () => { try{return JSON.parse(localStorage.getItem(SETLISTS_KEY))||[];}catch(e){return[];} };
const saveSavedSetlists = sl => { try{localStorage.setItem(SETLISTS_KEY,JSON.stringify(sl));}catch(e){} };
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
  // Check for saved code from phase 1 redirect
  const savedCode = sessionStorage.getItem('sp_code');
  const savedSt = sessionStorage.getItem('sp_state');
  
  // Phase 1: We just arrived from Spotify with ?code= in URL
  // Save code to sessionStorage and reload cleanly — this lets the fetch work normally
  const params = new URLSearchParams(window.location.search);
  const urlCode = params.get('code');
  const urlError = params.get('error');
  const urlState = params.get('state');
  
  if (urlCode || urlError) {
    // Clear URL immediately
    window.history.replaceState({}, '', window.location.pathname);
    if (urlError) { setState({spotifyStatus:{ok:false,msg:'Spotify login cancelled'}}); return true; }
    // Save code and reload — phase 2 will pick it up
    sessionStorage.setItem('sp_code', urlCode);
    sessionStorage.setItem('sp_state', urlState||'');
    dbgLog('Code saved, reloading for clean exchange...');
    setTimeout(() => window.location.reload(), 300);
    return true;
  }
  
  // Phase 2: Clean reload with saved code
  if (!savedCode) return false;
  sessionStorage.removeItem('sp_code');
  sessionStorage.removeItem('sp_state');
  
  const code = savedCode;
  const retState = savedSt;
  window.history.replaceState({}, '', window.location.pathname);
  if (!localStorage.getItem(SP_VERIFIER_STORE)) { setState({spotifyStatus:{ok:false,msg:'Login expired, please try again'}}); return true; }

  // Validate state to prevent CSRF
  const savedState = localStorage.getItem(SP_STATE_STORE)||'';
  localStorage.removeItem(SP_STATE_STORE);
  if (savedState && retState && retState !== savedState) {
    setState({spotifyStatus:{ok:false,msg:'Auth state mismatch — please try again'}});
    return true;
  }

  const clientId = localStorage.getItem(SP_CLIENT_STORE)||'';
  const verifier = localStorage.getItem(SP_VERIFIER_STORE)||'';
  localStorage.removeItem(SP_VERIFIER_STORE);
  const redirectUri = getRedirectUri();

  const dbg = document.getElementById('error-display');
  const dbgLog = msg => { if(dbg) { dbg.style.display='block'; dbg.style.color='#3ae8a6'; dbg.textContent += '\n' + msg; } };

  dbgLog('Exchanging token...');
  dbgLog('client_id: ' + (clientId ? clientId.slice(0,8)+'...' : 'MISSING'));
  dbgLog('verifier: ' + (verifier ? verifier.slice(0,8)+'...' : 'MISSING'));
  dbgLog('redirect_uri: ' + redirectUri);

  try {
    // Use proxy worker to avoid CORS block on GitHub Pages
    const tokenUrl = 'https://setlist-spotify.troymd123.workers.dev';
    dbgLog('Token URL: ' + tokenUrl);
    dbgLog('Sending POST to worker...');
    let res, data;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        code_verifier: verifier,
      });
      dbgLog('Body: ' + body.toString().slice(0,100));
      res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      dbgLog('HTTP status: ' + res.status);
    } catch(fetchErr) {
      throw new Error('POST fetch failed: ' + fetchErr.message);
    }
    let raw = '';
    try {
      dbgLog('Reading response body...');
      raw = await res.text();
      dbgLog('Raw: ' + raw.slice(0,150));
    } catch(readErr) {
      throw new Error('Cannot read response (CORS?): ' + readErr.message);
    }
    try {
      data = JSON.parse(raw);
    } catch(parseErr) {
      throw new Error('Parse failed. Raw: ' + raw.slice(0,100));
    }
    if (!res.ok || data.error) {
      throw new Error(data.error_description || data.error || 'Token exchange failed ' + res.status);
    }
    dbgLog('Token received, saving...');
    localStorage.setItem(SP_TOKEN_STORE,  data.access_token);
    localStorage.setItem(SP_EXPIRY_STORE, String(Date.now()+(data.expires_in-60)*1000));
    const pendingUrl = localStorage.getItem(SP_PENDING_URL)||'';
    localStorage.removeItem(SP_PENDING_URL);
    dbgLog('Saved! Starting app...');
    // Ensure rootEl is set before rendering
    if (!rootEl) rootEl = document.getElementById('root');
    Object.assign(state, {
      spotifyUrl: pendingUrl||'',
      spotifyStatus:{ok:true, msg:'Connected! ' + (pendingUrl ? 'Tap Import to load your playlist.' : 'Paste a playlist URL and tap Import.')}
    });
    try {
      dbgLog('Building header...');
      // Test each section individually to find crash point
      const testH = h('div',{style:{color:'#fff',padding:'20px'}},'APP IS WORKING - Spotify Connected!');
      if (rootEl.firstChild) rootEl.replaceChild(testH, rootEl.firstChild);
      else rootEl.appendChild(testH);
      if(dbg) dbg.style.display='none';
      // Test buildApp section by section to find crash
      setTimeout(() => {
        try {
          const appEl = buildApp();
          if (rootEl.firstChild) rootEl.replaceChild(appEl, rootEl.firstChild);
          else rootEl.appendChild(appEl);
        } catch(e) {
          const errDiv = document.createElement('div');
          errDiv.style.cssText = 'color:#e85d3a;padding:20px;font-family:monospace;font-size:11px;white-space:pre-wrap;background:#090909;position:fixed;inset:0;overflow:auto;z-index:9999';
          errDiv.textContent = 'RENDER ERROR: ' + e.message + ' ' + (e.stack||'').slice(0,600);
          document.body.appendChild(errDiv);
        }
      }, 100);
    } catch(renderErr) {
      dbgLog('RENDER ERROR: ' + renderErr.message + ' ' + (renderErr.stack||'').slice(0,300));
    }
  } catch(e) {
    dbgLog('ERROR: ' + e.message);
    // Leave debug screen visible so user can see the error
  }
  return true;
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

const fetchSpotifyPlaylist = async (url) => {
  const id = extractPlaylistId(url);
  if (!id) throw new Error('INVALID_URL');
  const token = getSpotifyToken();
  if (!token) return null;
  const headers = { Authorization:'Bearer '+token };

  // First get playlist name
  const res = await fetch(SPOTIFY_API+'/playlists/'+id+'?fields=name',{headers});
  if (res.status===401) {
    [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
    await startSpotifyLogin(url); return null;
  }
  if (res.status===403) throw new Error('SP_FORBIDDEN');
  if (!res.ok) throw new Error('SP_FETCH_FAILED_'+res.status);
  const meta = await res.json();
  if (meta.error) throw new Error('Spotify: ' + (meta.error.message||JSON.stringify(meta.error)));
  const playlistName = meta.name || 'Spotify Playlist';

  // Fetch tracks via dedicated endpoint — always works regardless of playlist size
  let songs = [];
  let tracksUrl = SPOTIFY_API+'/playlists/'+id+'/tracks?limit=100';
  while (tracksUrl) {
    const tr = await fetch(tracksUrl, {headers});
    if (tr.status===401) {
      [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
      await startSpotifyLogin(url); return null;
    }
    if (tr.status===403) {
      // Token missing required scope — force re-login to get fresh token
      [SP_TOKEN_STORE,SP_EXPIRY_STORE].forEach(k=>localStorage.removeItem(k));
      await startSpotifyLogin(url); return null;
    }
    if (!tr.ok) throw new Error('Tracks fetch failed: '+tr.status);
    const td = await tr.json();
    if (td.error) throw new Error('Tracks error: '+(td.error.message||JSON.stringify(td.error)));
    const pageItems = td.items||[];
    // Diagnose null tracks
    const nullCount = pageItems.filter(i=>!i||!i.track||!i.track.name).length;
    for (const item of pageItems) {
      if (!item || !item.track || !item.track.name) continue;
      const t = item.track;
      const sec = Math.round((t.duration_ms||0)/1000);
      songs.push({
        id: mkId(), title: t.name,
        artist: (t.artists||[]).map(a=>a.name).join(', '),
        genre:'Other', bpm:'', key:'', energy:'Medium', spotifyId:t.id||'',
        duration: sec>0 ? Math.floor(sec/60)+':'+String(sec%60).padStart(2,'0') : ''
      });
    }
    if (!songs.length && nullCount > 0) {
      // All tracks are null — show first raw item for diagnosis
      throw new Error('All '+nullCount+' items have null tracks. Raw item[0]: '+JSON.stringify(pageItems[0]).slice(0,300));
    }
    tracksUrl = td.next || null;
  }

  if (!songs.length) throw new Error('Playlist is empty or contains only local/podcast files');
  return { name: playlistName, songs };
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
const importFromSpotify = async (overrideUrl) => { overrideUrl = (typeof overrideUrl === 'string') ? overrideUrl : '';
  const urlEl = document.getElementById('spotify-url-inp');
  const url = (typeof overrideUrl==='string'&&overrideUrl ? overrideUrl : (urlEl?.value||state.spotifyUrl||'')).trim();
  if (!url) { setState({spotifyStatus:{ok:false,msg:'Paste a Spotify playlist URL first'}}); return; }
  if (!localStorage.getItem(SP_CLIENT_STORE)) {
    setState({spotifyStatus:{ok:false,msg:'Add your Spotify Client ID in Settings first'}}); return;
  }
  // If not connected, redirect synchronously (must happen from user gesture)
  const existingToken = localStorage.getItem(SP_TOKEN_STORE)||'';
  const existingExpiry = parseInt(localStorage.getItem(SP_EXPIRY_STORE)||'0');
  if (!existingToken || Date.now() >= existingExpiry) {
    setState({spotifyStatus:{ok:null, msg:'Opening Spotify login...'}});
    // Save URL before redirecting
    if (url) localStorage.setItem(SP_PENDING_URL, url);
    // Build login URL synchronously and redirect immediately
    const clientId = localStorage.getItem(SP_CLIENT_STORE)||'';
    if (!clientId) { setState({spotifyStatus:{ok:false,msg:'Add your Spotify Client ID in Settings first'}}); return; }
    const verifier = generateRandom(64);
    sha256b64(verifier).then(challenge => {
      const oauthState = generateRandom(16);
      localStorage.setItem(SP_VERIFIER_STORE, verifier);
      localStorage.setItem(SP_STATE_STORE, oauthState);
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
    });
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

// Toggle song availability
const toggleAvailable = id => {
  const songs = state.songs.map(s => s.id===id ? {...s, unavailable:!s.unavailable} : s);
  saveToStorage(songs);
  setState({songs});
};

const applyMove = (song, newPos) => {
  const arr = [...state.songs];
  const fromIdx = arr.findIndex(s => s.title === song);
  if (fromIdx < 0) return;
  const toIdx = Math.max(0, Math.min(arr.length-1, newPos-1));
  const [moved] = arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, moved);
  saveToStorage(arr);
  setState({songs:arr, analysis:{...state.analysis, moves:(state.analysis.moves||[]).filter(m=>m.song!==song)}});
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

const analyze = async () => {
  if (state.songs.length<2){setState({error:'Add at least 2 songs to analyze.'});return;}
  const availForAnalysis = state.songs.filter(s=>!s.unavailable);
  if (availForAnalysis.length<2){setState({error:'Need at least 2 available songs to analyze.'});return;}
  setState({loading:true,error:null,analysis:null});
  try {
    const result = await callAI(
      `You are a professional music director and setlist optimizer.
Setlist:
${availForAnalysis.map((s,i)=>`${i+1}. "${s.title}" by ${s.artist||'Unknown'} | Genre:${s.genre} | BPM:${s.bpm||'?'} | Key:${s.key||'?'} | Tuning:${s.tuning||'Standard'}${s.capo>0?' Capo '+s.capo:''} | Energy:${s.energy} | Vocal:${s.vocal||'?'} | Duration:${s.duration||'?'}`).join('\n')}
Vocal type filter: ${state.vocalType}
Keep all text fields under 100 words each. Respond ONLY in JSON (no markdown):
{"assessment":"...","moves":[{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."},{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."},{"song":"...","currentPos":N,"suggestedPos":N,"reason":"..."}],"replacements":[{"song":"...","reason":"...","suggestion":"..."},{"song":"...","reason":"...","suggestion":"..."}],"additions":[{"title":"...","artist":"...","reason":"...","position":"..."},{"title":"...","artist":"...","reason":"...","position":"..."},{"title":"...","artist":"...","reason":"...","position":"..."}],"energyArc":"...","keyFlowNotes":"...","flowScore":N,"flowScoreNote":"..."}`
    ,4000);
    setState({analysis:result,loading:false});
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
    const songList = availSongs.map((s,i)=>
      `${i+1}. "${s.title}" by ${s.artist||'Unknown'} | Genre:${s.genre} | BPM:${s.bpm||'?'} | Key:${s.key||'?'} | Tuning:${s.tuning||'Standard'}${s.capo>0?' Capo '+s.capo:''} | Energy:${s.energy} | Vocal:${s.vocal||'?'} | Duration:${s.duration||'?'}`
    ).join('\n');
    const isMultiSet = state.numberOfSets > 1;
    const prompt = isMultiSet
      ? `You are a professional music director. Build ${state.numberOfSets} sets of ${state.targetMinutes} min each with ${state.breakMinutes}-min breaks. Select ${vocalFilter}. CRITICAL: minimise tuning changes between consecutive songs — group same-tuning songs together.
Songs (these are a LIBRARY — do not remove them, just select which to perform):
${songList}
Each set ~${Math.round(state.targetMinutes/3.5)} songs. Strong energy arc per set. Keep text fields under 60 chars.
Respond ONLY in JSON (no markdown):
{"sets":[{"setlist":[{"title":"...","artist":"...","tuning":"...","capo":0,"duration":"...","energy":"...","vocal":"..."}]}],"totalEstimatedMinutes":N,"notes":"...","swaps":[{"remove":"...","add":"...","artist":"...","reason":"..."}]}`
      : `You are a professional music director. Build optimal ${state.targetMinutes}-min setlist. Select ${vocalFilter}. CRITICAL: minimise tuning changes — group same-tuning songs together.
Songs (LIBRARY — select which to perform, do not remove):
${songList}
~${Math.round(state.targetMinutes/3.5)} songs. Keep text fields under 60 chars.
Respond ONLY in JSON (no markdown):
{"setlist":[{"title":"...","artist":"...","tuning":"...","capo":0,"duration":"...","energy":"...","vocal":"..."}],"totalEstimatedMinutes":N,"notes":"...","swaps":[{"remove":"...","add":"...","artist":"...","reason":"..."}]}`;
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
      isDetecting&&h('span',{className:'detecting'},'detecting…')
    ),
    !isGenerated&&h('div',{className:'song-actions'},
      h('button',{
        className:'icon-btn',
        style:song.unavailable?{borderColor:'#e85d3a',color:'#e85d3a'}:{},
        title:song.unavailable?'Mark available':'Mark unavailable',
        onClick:()=>toggleAvailable(song.id)
      }, song.unavailable?'Off':'On'),
      h('button',{className:'icon-btn',onClick:()=>startEdit(song.id)},'Edit'),
      h('button',{className:'icon-btn danger',onClick:()=>removeSong(song.id)},'✕')
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
        const songs = setObj.setlist || setObj;
        if (!Array.isArray(songs)) return null;
        return h('div',{},
          generatedSetlist.sets&&h('div',{style:{fontSize:'11px',fontWeight:'700',letterSpacing:'2px',color:'#e85d3a',marginBottom:'6px',marginTop:setIdx>0?'14px':'0'}},'SET '+(setIdx+1)),
          ...songs.map((song,i)=>{
            const gc=gcColor(song.genre);
            return h('div',{className:'generated-song',style:{borderLeft:`3px solid ${gc}`}},
              h('span',{style:{color:'#333',fontSize:'11px',fontFamily:'monospace',minWidth:'20px'}},String(i+1).padStart(2,'0')),
              h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'14px',flex:1}},song.title),
              song.artist&&h('span',{style:{color:'#666',fontSize:'11px'}},song.artist),
              song.duration&&h('span',{style:{color:'#444',fontSize:'10px'}},'⏱ '+song.duration)
            );
          }),
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

      // Spotify — PKCE flow (Client ID only, no secret needed)
      h('div',{className:'settings-section'},
        h('div',{className:'settings-section-title',style:{color:'#1DB954'}},'♫ Spotify',
          connected && h('span',{style:{fontSize:'10px',color:'#1DB954',fontWeight:'normal',marginLeft:'8px',letterSpacing:'0'}},'● Connected')
        ),
        connected
          ? h('div',{},
              h('p',{className:'field-hint',style:{marginBottom:'12px',color:'#555'}},'Spotify is connected. Your songs import directly from any public playlist.'),
              h('button',{className:'btn btn-ghost',style:{fontSize:'12px',padding:'6px 14px'},onClick:()=>{disconnectSpotify();setState({showSettings:false});}},'Disconnect Spotify')
            )
          : h('div',{},
              h('p',{className:'field-hint',style:{marginBottom:'10px'}},
                '1. Go to ',h('a',{href:'https://developer.spotify.com/dashboard',target:'_blank'},'developer.spotify.com/dashboard'),
                ' and create a free app.'
              ),
              h('p',{className:'field-hint',style:{marginBottom:'10px'}},
                '2. In the app settings, add this exact Redirect URI:',h('br',{}),
                h('code',{style:{color:'#1DB954',fontSize:'11px',wordBreak:'break-all',display:'block',marginTop:'4px',padding:'6px 8px',background:'rgba(29,185,84,0.08)',borderRadius:'4px'}},redirectUri)
              ),
              h('p',{className:'field-hint',style:{marginBottom:'12px'}},
                '3. Copy your Client ID (no secret needed) and paste it below.'
              ),
              h('div',{className:'field-label'},'CLIENT ID'),
              h('div',{className:'api-inp-wrap'},
                h('input',{className:'inp',placeholder:'Paste Client ID here',value:spClientId,onInput:e=>setState({spClientId:e.target.value})}),
                h('button',{className:'btn btn-green',onClick:()=>{
                  if (!state.spClientId.trim()) return;
                  localStorage.setItem(SP_CLIENT_STORE, state.spClientId.trim());
                  // Build redirect URL and navigate immediately from this tap
                  const clientId = state.spClientId.trim();
                  const verifier = generateRandom(64);
                  sha256b64(verifier).then(challenge => {
                    const oauthState = generateRandom(16);
                    localStorage.setItem(SP_VERIFIER_STORE, verifier);
                    localStorage.setItem(SP_STATE_STORE, oauthState);
                    const params = new URLSearchParams({
                      response_type:'code', client_id:clientId,
                      scope:'playlist-read-private playlist-read-collaborative',
                      redirect_uri:getRedirectUri(), state:oauthState,
                      code_challenge_method:'S256', code_challenge:challenge,
                    });
                    window.location.href = 'https://accounts.spotify.com/authorize?' + params;
                  });
                }},'Connect')
              ),
              h('p',{className:'field-hint',style:{marginTop:'6px'}},'Clicking Connect will open Spotify to authorise — you will be sent back here automatically.')
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
      h('div',{className:'tagline'},'AI-Powered Performance Sequencing')
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
        onClick:loadingSpotify?null:()=>importFromSpotify()
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
        onKeydown:e=>e.key==='Enter'&&addSong()}),
      h('input',{className:'inp inp-md',placeholder:'Artist',id:'new-artist'}),
      h('select',{className:'inp inp-md',onChange:e=>setState({newSong:{...state.newSong,genre:e.target.value}})},
        ...Object.keys(GENRE_COLORS).map(g=>h('option',{value:g,selected:newSong.genre===g||null},g))),
      h('select',{className:'inp inp-sm',onChange:e=>setState({newSong:{...state.newSong,vocal:e.target.value}})},
        h('option',{value:''},'Vocal'),
        ['Male','Female','Duet','Group'].map(v=>h('option',{value:v,selected:newSong.vocal===v||null},v))),
      h('select',{className:'inp inp-sm',onChange:e=>setState({newSong:{...state.newSong,tuning:e.target.value}})},
        ['Standard','Drop D','Open G','Open D','Open E','DADGAD','Half Step Down','Full Step Down'].map(t=>h('option',{value:t,selected:(newSong.tuning||'Standard')===t||null},t))),
      h('input',{className:'inp inp-sm',placeholder:'Capo',type:'number',min:'0',max:'12',
        defaultValue:0,id:'new-capo'})
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
      ...saved.map(sl=>h('div',{style:{background:'rgba(255,255,255,0.03)',border:'1px solid rgba(255,255,255,0.07)',borderRadius:8,padding:'12px 14px',marginBottom:'8px'}},
        h('div',{style:{display:'flex',alignItems:'center',gap:'8px',marginBottom:'6px',flexWrap:'wrap'}},
          h('span',{style:{fontFamily:"'Bebas Neue',sans-serif",fontSize:'15px',letterSpacing:'1px',flex:1}},sl.name),
          h('span',{style:{color:'#555',fontSize:'11px'}},sl.songs.length+' songs'),
          h('button',{className:'btn',style:{fontSize:'11px',padding:'4px 10px',background:'rgba(58,232,166,0.12)',color:'#3ae8a6',border:'1px solid rgba(58,232,166,0.2)'},
            onClick:()=>loadSavedSetlistToMain(sl.id)},'Load'),
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

  const optimizeBtn=songs.length>0&&h('div',{style:{marginTop:'18px'}},
    h('button',{className:`btn btn-primary btn-full ${loading?'btn-disabled':''}`,onClick:loading?null:analyze},loading?'ANALYZING…':'✦ Optimize My Setlist'),
    error&&h('div',{className:'error-text'},error)
  );

  const grid=h('div',{className:'grid'},
    h('div',{},addForm,tabs,tabContent,optimizeBtn),
    h('div',{},h('div',{className:'label'},'AI Analysis'),buildAnalysisPanel())
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
    showSettings&&buildSettingsModal(),
    installToast||''
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 stash: save code to sessionStorage synchronously before anything else
// This happens even before the app initialises
(function() {
  const sp = new URLSearchParams(window.location.search);
  if (sp.get('code') && !sessionStorage.getItem('sp_code')) {
    sessionStorage.setItem('sp_code', sp.get('code'));
    sessionStorage.setItem('sp_state', sp.get('state')||'');
  }
})();

injectStyles();
rootEl=document.getElementById('root');
render();
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();setState({installPrompt:e,showInstall:true});});

// Handle Spotify PKCE callback — extract code IMMEDIATELY before anything else
// Spotify codes expire in ~10 seconds so we must act fast
(async () => {
  const p = new URLSearchParams(window.location.search);
  const code = p.get('code'), err = p.get('error');
  if (!code && !err) return; // normal page load, nothing to do
  
  // Clear URL immediately
  window.history.replaceState({}, '', window.location.pathname);

  // Show minimal status
  const dbg = document.getElementById('error-display');
  if (dbg) { dbg.style.display='block'; dbg.style.color='#3ae8a6'; dbg.textContent='Connecting to Spotify...'; }

  await handleSpotifyCallback();
})();
