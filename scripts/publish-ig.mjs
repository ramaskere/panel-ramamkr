// Publica una imagen o un carrusel. Solo corre desde el workflow manual "Publicar en Instagram".
import { makeApi, publish } from './lib-ig.mjs';
const { META_TOKEN, IMAGE_URLS, CAPTION = '' } = process.env;
if (!META_TOKEN) throw new Error('Falta META_TOKEN');
const urls = (IMAGE_URLS || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
console.log('Publicado:', (await publish(makeApi(META_TOKEN), urls, CAPTION, process.env.CUENTA)) || '(sin link)');
