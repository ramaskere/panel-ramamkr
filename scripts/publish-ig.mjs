// Publica una imagen o un carrusel en Instagram. Solo corre desde el workflow manual "Publicar en Instagram".
// Variables: META_TOKEN, IMAGE_URLS (una URL por línea o separadas por coma), CAPTION. Opcional: IG_USER_ID, IG_USERNAME.
const { META_TOKEN, IMAGE_URLS, CAPTION = '' } = process.env;
if (!META_TOKEN) throw new Error('Falta META_TOKEN');
const urls = (IMAGE_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
if (!urls.length) throw new Error('Falta al menos una URL de imagen.');
if (urls.length > 10) throw new Error('Instagram admite hasta 10 imágenes por carrusel.');
if (urls.some(u => !u.startsWith('https://'))) throw new Error('Todas las URLs deben empezar con https://');

const G = 'https://graph.facebook.com/v21.0';
async function api(path, method = 'GET', params = {}) {
  const body = new URLSearchParams({ ...params, access_token: META_TOKEN });
  const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
  const j = await r.json();
  if (!r.ok) throw new Error(`Meta ${r.status} en ${path}: ${j.error?.message || 'error'}`);
  return j;
}
async function igId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  const want = (process.env.IG_USERNAME || 'ramaruiz.ads').toLowerCase();
  const pages = (await api('me/accounts', 'GET', { fields: 'instagram_business_account{id,username}' })).data || [];
  const mine = pages.map(p => p.instagram_business_account).filter(Boolean).find(a => (a.username || '').toLowerCase() === want);
  if (!mine) throw new Error('No encontré @' + want + ' entre las cuentas visibles.');
  return mine.id;
}
async function ready(id) {
  for (let i = 0; i < 30; i++) {
    const s = await api(id, 'GET', { fields: 'status_code' });
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar el contenido: ' + s.status_code);
    await new Promise(r => setTimeout(r, 4000));
  }
  throw new Error('Instagram tardó demasiado en procesar el contenido.');
}

const ig = await igId();
let creation;
if (urls.length === 1) {
  creation = (await api(`${ig}/media`, 'POST', { image_url: urls[0], caption: CAPTION })).id;
} else {
  const kids = [];
  for (const u of urls) { const k = (await api(`${ig}/media`, 'POST', { image_url: u, is_carousel_item: 'true' })).id; await ready(k); kids.push(k); }
  creation = (await api(`${ig}/media`, 'POST', { media_type: 'CAROUSEL', children: kids.join(','), caption: CAPTION })).id;
}
await ready(creation);
const pub = await api(`${ig}/media_publish`, 'POST', { creation_id: creation });
const info = await api(pub.id, 'GET', { fields: 'permalink' }).catch(() => ({}));
console.log('Publicado:', info.permalink || '(sin link)');
