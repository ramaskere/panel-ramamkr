// Prueba de respuesta privada: busca el comentario más reciente (últimas 24 h) que contenga PALABRA en los últimos posts
// y le envía TEXTO como mensaje privado. No imprime nombres ni IDs (el repo y sus logs son públicos).
const { META_TOKEN, PALABRA, TEXTO } = process.env;
if (!META_TOKEN || !PALABRA || !TEXTO) throw new Error('Faltan variables.');
const G = 'https://graph.facebook.com/v21.0';
async function call(path, method = 'GET', params = {}, token = META_TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
  const j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const want = (process.env.IG_USERNAME || 'ramaruiz.ads').toLowerCase();
const pages = (await call('me/accounts', 'GET', { fields: 'id,access_token,instagram_business_account{id,username}' })).j.data || [];
const page = pages.find(p => (p.instagram_business_account?.username || '').toLowerCase() === want);
if (!page) throw new Error('No encontré la página vinculada al Instagram.');
const ig = page.instagram_business_account.id;

const media = (await call(`${ig}/media`, 'GET', { fields: 'id', limit: '10' })).j.data || [];
const since = Date.now() - 24 * 36e5;
let found = null, scanned = 0;
for (const m of media) {
  const c = await call(`${m.id}/comments`, 'GET', { fields: 'id,text,timestamp', limit: '50' });
  if (!c.ok) { console.log('Leer comentarios falló:', c.status, c.j.error?.message); continue; }
  for (const x of c.j.data || []) {
    scanned++;
    if ((x.text || '').toLowerCase().includes(PALABRA.toLowerCase()) && new Date(x.timestamp).getTime() >= since && (!found || x.timestamp > found.timestamp)) found = x;
  }
}
console.log('Comentarios leídos:', scanned, '| comentario de prueba encontrado:', found ? 'sí' : 'no');
if (!found) process.exit(1);

const msg = { recipient: JSON.stringify({ comment_id: found.id }), message: JSON.stringify({ text: TEXTO }) };
let res = await call(`${page.id}/messages`, 'POST', msg, page.access_token || META_TOKEN);
console.log('Intento 1 (página):', res.ok ? 'enviado' : `error ${res.status}: ${res.j.error?.message} (código ${res.j.error?.code}/${res.j.error?.error_subcode || '-'})`);
if (!res.ok) {
  res = await call(`${ig}/messages`, 'POST', msg);
  console.log('Intento 2 (cuenta de Instagram):', res.ok ? 'enviado' : `error ${res.status}: ${res.j.error?.message} (código ${res.j.error?.code}/${res.j.error?.error_subcode || '-'})`);
}
process.exit(res.ok ? 0 : 1);
