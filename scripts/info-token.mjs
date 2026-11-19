// Muestra de qué app salió el token de Meta y cuándo vence. No imprime el token ni datos de personas.
const T = process.env.META_TOKEN;
if (!T) throw new Error('Falta META_TOKEN');
const q = new URLSearchParams({ input_token: T, access_token: T });
const r = await fetch('https://graph.facebook.com/v21.0/debug_token?' + q), j = await r.json();
if (!r.ok) throw new Error('Meta ' + r.status + ': ' + (j.error?.message || ''));
const d = j.data || {};
const fecha = s => !s ? 'sin vencimiento' : new Date(s * 1000).toISOString().slice(0, 10);
console.log('App:', d.application || '(sin nombre)');
console.log('ID de la app:', d.app_id || '(desconocido)');
console.log('Tipo de token:', d.type || '(desconocido)');
console.log('Válido:', d.is_valid ? 'sí' : 'no');
console.log('Vence:', fecha(d.expires_at));
console.log('Acceso a datos vence:', fecha(d.data_access_expires_at));
console.log('Cantidad de permisos:', (d.scopes || []).length);
