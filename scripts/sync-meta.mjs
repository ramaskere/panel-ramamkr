// Trae métricas de Instagram y de Meta Ads y las suma a datos.enc.json (cifrado con la misma contraseña del panel).
// Variables: META_TOKEN, DATA_PASS, GITHUB_TOKEN, GITHUB_REPOSITORY. Opcionales: IG_USER_ID, AD_ACCOUNT_ID.
const { META_TOKEN, DATA_PASS, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ META_TOKEN, DATA_PASS, GITHUB_TOKEN, GITHUB_REPOSITORY })) if (!v) throw new Error('Falta la variable ' + k);

const FILE = 'datos.enc.json', GRAPH = 'https://graph.facebook.com/v21.0', GH = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/${FILE}`;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u8 => Buffer.from(u8).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function key(salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(DATA_PASS), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(obj, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(salt), enc.encode(JSON.stringify(obj)));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}
async function decrypt(text) {
  const f = JSON.parse(text);
  try { return { data: JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await key(unb64(f.salt)), unb64(f.ct)))), salt: unb64(f.salt) }; }
  catch { throw new Error('DATA_PASS no coincide con la contraseña de los datos.'); }
}

async function graph(path, params = {}) {
  const url = new URL(path.startsWith('http') ? path : `${GRAPH}/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('access_token', META_TOKEN);
  const r = await fetch(url), j = await r.json();
  if (!r.ok) throw new Error(`Meta ${r.status} en ${path}: ${j.error?.message || 'error'}`);
  return j;
}
async function graphAll(path, params) {
  let out = [], j = await graph(path, params);
  for (let i = 0; i < 10; i++) { out = out.concat(j.data || []); if (!j.paging?.next) break; j = await graph(j.paging.next); }
  return out;
}
const num = v => Number(v) || 0;
const day = iso => (iso || '').slice(0, 10);

/* ---------- Instagram orgánico ---------- */
async function organic() {
  let ig = process.env.IG_USER_ID;
  if (!ig) {
    const pages = await graphAll('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
    ig = pages.map(p => p.instagram_business_account?.id).find(Boolean);
    if (!ig) throw new Error('No encontré una cuenta de Instagram profesional vinculada a una página.');
  }
  const media = await graphAll(`${ig}/media`, { fields: 'id,caption,media_type,media_product_type,permalink,timestamp,like_count,comments_count', limit: '50' });
  const docs = {};
  for (const m of media.slice(0, 60)) {
    let reach = 0, saved = 0, shares = 0;
    try {
      const ins = await graph(`${m.id}/insights`, { metric: 'reach,saved,shares' });
      const g = n => num(ins.data.find(x => x.name === n)?.values?.[0]?.value);
      reach = g('reach'); saved = g('saved'); shares = g('shares');
    } catch (e) { console.warn('Sin insights para', m.id, '-', e.message); }
    const formato = m.media_product_type === 'REELS' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carrusel' : 'Post';
    docs['ig-' + m.id] = {
      metrics: { alcance: reach, likes: num(m.like_count), comentarios: num(m.comments_count), guardados: saved, compartidos: shares },
      base: { fecha: day(m.timestamp), formato, titulo: (m.caption || 'Sin texto').split('\n')[0].slice(0, 90), url: m.permalink, meta: true }
    };
  }
  return docs;
}

/* ---------- Meta Ads ---------- */
const OBJ = { OUTCOME_LEADS: 'Leads', OUTCOME_SALES: 'Ventas', OUTCOME_TRAFFIC: 'Tráfico', OUTCOME_AWARENESS: 'Alcance', OUTCOME_ENGAGEMENT: 'Mensajes', MESSAGES: 'Mensajes' };
async function ads() {
  let act = process.env.AD_ACCOUNT_ID;
  if (!act) { const a = await graphAll('me/adaccounts', { fields: 'id,name' }); act = a[0]?.id; if (!act) throw new Error('No encontré una cuenta publicitaria.'); }
  if (!act.startsWith('act_')) act = 'act_' + act;
  const camps = await graphAll(`${act}/campaigns`, { fields: 'id,name,status,effective_status,objective,start_time', limit: '100' });
  const ins = await graphAll(`${act}/insights`, { level: 'campaign', fields: 'campaign_id,spend,impressions,clicks', date_preset: 'maximum', limit: '500' });
  const byId = Object.fromEntries(ins.map(i => [i.campaign_id, i]));
  const docs = {};
  for (const c of camps) {
    const i = byId[c.id] || {};
    docs['meta-' + c.id] = {
      metrics: { gasto: num(i.spend), impresiones: num(i.impressions), clics: num(i.clicks), estado: c.effective_status === 'ACTIVE' ? 'Activa' : c.effective_status === 'PAUSED' ? 'Pausada' : 'Finalizada' },
      base: { nombre: c.name, objetivo: OBJ[c.objective] || 'Leads', inicio: day(c.start_time), meta: true }
    };
  }
  return docs;
}

/* ---------- Guardar en el repo ---------- */
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN, ...(opt.headers || {}) } });
async function readData() {
  const r = await gh(GH + '?t=' + Date.now());
  if (r.status === 404) return { data: { posts: {}, camps: {}, leads: {} }, sha: null, salt: crypto.getRandomValues(new Uint8Array(16)) };
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al leer los datos.');
  const j = await r.json(), d = await decrypt(Buffer.from(j.content, 'base64').toString('utf8'));
  return { data: { posts: {}, camps: {}, leads: {}, ...d.data }, sha: j.sha, salt: d.salt };
}
function upsert(col, incoming) {
  for (const [id, { metrics, base }] of Object.entries(incoming)) col[id] = col[id] ? { ...col[id], ...metrics } : { ...base, ...metrics, creado: Date.now() };
}

const results = await Promise.allSettled([organic(), ads()]);
const [org, adv] = results;
results.forEach((r, i) => { if (r.status === 'rejected') console.error(['Orgánico', 'Ads'][i] + ':', r.reason.message); });
if (results.every(r => r.status === 'rejected')) process.exit(1);

for (let intento = 0; intento < 3; intento++) {
  const { data, sha, salt } = await readData();
  if (org.status === 'fulfilled') upsert(data.posts, org.value);
  if (adv.status === 'fulfilled') upsert(data.camps, adv.value);
  const body = { message: 'Sincroniza métricas de Meta', content: Buffer.from(await encrypt(data, salt)).toString('base64'), ...(sha ? { sha } : {}) };
  const r = await gh(GH, { method: 'PUT', body: JSON.stringify(body) });
  if (r.ok) { console.log(`Listo: ${Object.keys(org.value || {}).length} contenidos, ${Object.keys(adv.value || {}).length} campañas.`); process.exit(0); }
  if (r.status !== 409 && r.status !== 422) throw new Error('GitHub ' + r.status + ' al guardar.');
}
throw new Error('No se pudo guardar por conflictos repetidos.');
