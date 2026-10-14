// Responde comentarios con palabra clave y envía el recurso por mensaje privado.
// Lee recursos y el interruptor de datos.enc.json (cifrado con DATA_PASS). Con el interruptor apagado solo informa (modo prueba).
// Los logs son públicos: solo cantidades, nunca nombres, IDs ni textos.
const { DATA_PASS, META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
for (const [k, v] of Object.entries({ DATA_PASS, META_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) if (!v) throw new Error('Falta la variable ' + k);
const MAX_ENVIOS = 15, DIA = 864e5;
const FILE = `https://api.github.com/repos/${GITHUB_REPOSITORY}/contents/datos.enc.json`;
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = u => Buffer.from(u).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
async function key(salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(DATA_PASS), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const gh = (url, opt = {}) => fetch(url, { ...opt, headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + GITHUB_TOKEN } });
async function load() {
  const r = await gh(FILE + '?t=' + Date.now());
  if (r.status === 404) return { data: {}, sha: null, salt: crypto.getRandomValues(new Uint8Array(16)) };
  if (!r.ok) throw new Error('GitHub ' + r.status + ' al leer.');
  const j = await r.json(), f = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  try { return { data: JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, await key(unb64(f.salt)), unb64(f.ct)))), sha: j.sha, salt: unb64(f.salt) }; }
  catch { throw new Error('DATA_PASS no coincide con la contraseña de los datos.'); }
}
// Lee, aplica el cambio sobre datos frescos y guarda; reintenta ante conflicto.
async function mutate(fn) {
  for (let i = 0; i < 4; i++) {
    const { data, sha, salt } = await load();
    fn(data);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(salt), enc.encode(JSON.stringify(data)));
    const content = Buffer.from(JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) })).toString('base64');
    const w = await gh(FILE, { method: 'PUT', body: JSON.stringify({ message: 'Bot de comentarios', content, ...(sha ? { sha } : {}) }) });
    if (w.ok) return;
    if (w.status !== 409 && w.status !== 422) throw new Error('GitHub ' + w.status + ' al guardar.');
  }
  throw new Error('Conflictos repetidos al guardar.');
}

const G = 'https://graph.facebook.com/v21.0';
async function g(path, method = 'GET', params = {}, token = META_TOKEN) {
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === 'GET' ? await fetch(`${G}/${path}?${body}`) : await fetch(`${G}/${path}`, { method, body });
  const j = await r.json();
  return { ok: r.ok, status: r.status, j };
}
const norm = t => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const coincide = (palabra, texto) => new RegExp('(^|[^a-z0-9])' + norm(palabra).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])').test(norm(texto));

const { data } = await load();
const auto = !!data.config?.auto?.activo;
const recursos = Object.entries(data.recursos || {}).map(([id, r]) => ({ id, ...r })).filter(r => r.estado === 'Activo' && r.palabra && r.dm);
console.log(`Modo: ${auto ? 'automático' : 'prueba (no envía)'} | recursos activos: ${recursos.length}`);
if (!recursos.length) process.exit(0);

const want = (process.env.IG_USERNAME || 'ramaruiz.ads').toLowerCase();
const pages = (await g('me/accounts', 'GET', { fields: 'id,access_token,instagram_business_account{id,username}' })).j.data || [];
const page = pages.find(p => (p.instagram_business_account?.username || '').toLowerCase() === want);
if (!page) throw new Error('No encontré la página vinculada al Instagram.');
const tk = page.access_token || META_TOKEN, ig = page.instagram_business_account.id;
async function enviar(recipient, text) {
  const body = { recipient: JSON.stringify(recipient), message: JSON.stringify({ text }) };
  let r = await g(`${page.id}/messages`, 'POST', body, tk);
  if (!r.ok) r = await g(`${ig}/messages`, 'POST', body);
  return r;
}
const falla = r => `error ${r.status} (código ${r.j.error?.code}/${r.j.error?.error_subcode || '-'}): ${r.j.error?.message}`;

/* 1. Comentarios nuevos con palabra clave */
const atendidos = data.atendidos || {};
const media = (await g(`${ig}/media`, 'GET', { fields: 'id', limit: '10' }, tk)).j.data || [];
let leidos = 0, coinciden = 0, enviados = 0, bloqueados = 0;
for (const m of media) {
  const c = await g(`${m.id}/comments`, 'GET', { fields: 'id,text,timestamp,username', limit: '50' }, tk);
  for (const x of c.j.data || []) {
    leidos++;
    if (atendidos[x.id] || (x.username || '').toLowerCase() === want || Date.now() - new Date(x.timestamp) > 7 * DIA) continue;
    const rec = recursos.find(r => coincide(r.palabra, x.text) && (!r.post || r.post === 'post:ig-' + m.id));
    if (!rec) continue;
    coinciden++;
    if (!auto) continue;
    if (/\[LINK\]/i.test(rec.dm)) { bloqueados++; continue; }
    if (enviados >= MAX_ENVIOS) continue;
    const primero = rec.pregunta || rec.dm;
    const pr = await enviar({ comment_id: x.id }, primero);
    if (!pr.ok) {
      console.log('Respuesta privada falló:', falla(pr));
      await mutate(d => { (d.atendidos ||= {})[x.id] = { recurso: rec.id, estado: 'error', ts: Date.now() }; });
      continue;
    }
    if (rec.respuesta) { const pub = await g(`${x.id}/replies`, 'POST', { message: rec.respuesta }, tk); if (!pub.ok) console.log('Respuesta pública falló:', falla(pub)); }
    const sid = pr.j.recipient_id;
    await mutate(d => {
      (d.atendidos ||= {})[x.id] = { recurso: rec.id, estado: rec.pregunta ? 'preguntado' : 'entregado', sid, ts: Date.now() };
      const r = d.recursos[rec.id]; r.comentarios = (r.comentarios || 0) + 1; r.enviados = (r.enviados || 0) + 1;
    });
    enviados++;
  }
}
console.log(`Comentarios leídos: ${leidos} | con palabra clave: ${coinciden} | respuestas enviadas: ${enviados}${bloqueados ? ' | sin enviar por [LINK] pendiente: ' + bloqueados : ''}`);

/* 2. Personas que respondieron la pregunta: enviar el recurso */
const pendientes = Object.entries(atendidos).filter(([, a]) => a.estado === 'preguntado');
let entregados = 0, esperando = 0;
if (pendientes.length) {
  const convs = (await g(`${page.id}/conversations`, 'GET', { platform: 'instagram', fields: 'id,participants', limit: '50' }, tk)).j.data || [];
  const porPersona = {};
  for (const cv of convs) for (const p of cv.participants?.data || []) porPersona[p.id] = cv.id;
  console.log('Diagnóstico: conversaciones visibles:', convs.length, '| personas en ellas:', Object.keys(porPersona).length, '| pendientes con conversación encontrada:', pendientes.filter(([, a]) => porPersona[a.sid]).length);
  const own = new Set([ig, page.id]);
  const leer = async id => (await g(id, 'GET', { fields: 'messages.limit(10){message,from,created_time}' }, tk)).j.messages?.data || [];
  for (const [cid, a] of pendientes) {
    if (Date.now() - a.ts > 7 * DIA) { await mutate(d => { d.atendidos[cid].estado = 'vencido'; }); continue; }
    const rec = data.recursos?.[a.recurso];
    if (!rec) { esperando++; continue; }
    let conv = porPersona[a.sid], msgs = conv ? await leer(conv) : [];
    if (!conv) { // el ID devuelto al enviar no siempre coincide: se busca por el texto de la pregunta
      const clave = norm(rec.pregunta || rec.dm).slice(0, 30);
      for (const cv of convs) {
        const mm = await leer(cv.id);
        if (mm.some(x => own.has(x.from?.id) && norm(x.message).includes(clave) && Math.abs(new Date(x.created_time) - a.ts) < 10 * 60e3)) { conv = cv.id; msgs = mm; break; }
      }
    }
    const resp = msgs.find(x => x.from?.id && !own.has(x.from.id) && new Date(x.created_time).getTime() > a.ts);
    console.log('Diagnóstico: conversación encontrada:', conv ? 'sí' : 'no', '| mensajes leídos:', msgs.length, '| respuesta de la persona:', resp ? 'sí' : 'no');
    if (!resp) { esperando++; continue; }
    if (!auto) { entregados++; continue; }
    if (/\[LINK\]/i.test(rec.dm)) continue;
    const er = await enviar({ id: resp.from.id }, rec.dm);
    if (!er.ok) { console.log('Envío del recurso falló:', falla(er)); continue; }
    await mutate(d => { d.atendidos[cid].estado = 'entregado'; const r = d.recursos[a.recurso]; r.respuestas = (r.respuestas || 0) + 1; });
    entregados++;
  }
}
console.log(`Esperando respuesta: ${esperando} | recursos ${auto ? 'enviados' : 'que se enviarían'} tras responder: ${entregados}`);
