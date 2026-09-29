// Telegram Bot API'nin kayıt sisteminin kullandığı kısmını taklit eden sunucu (test için).
// Gerçek kurallar: sendDocument ≤ 50 MB, getFile ile indirme ≤ 20 MB, getChat.pinned_message = en son sabitlenen.
const http = require('http');

function sahteTelegram({ jeton, sohbet, ilk429 = 0 }) {
  const dosyalar = new Map();      // file_id → Buffer
  const mesajlar = [];             // { message_id, date, document, caption }
  const sabit = new Set();
  let sayac = 0, kalan429 = ilk429;
  const istatistik = { gonderilen: 0, indirilen: 0, enBuyukYukleme: 0, enBuyukIndirme: 0, cagri: [] };

  const sunucu = http.createServer(async (req, res) => {
    const govde = await new Promise((r) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => r(Buffer.concat(p))); });
    const yaz = (kod, j) => { res.statusCode = kod; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    const hata = (kod, aciklama, ek) => yaz(kod, { ok: false, error_code: kod, description: aciklama, ...(ek || {}) });

    let m = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
    if (m) {
      if (m[1] !== jeton) return hata(401, 'Unauthorized');
      const id = [...dosyalar.keys()].find((k) => 'documents/' + k + '.bin' === m[2]);
      if (!id) { res.statusCode = 404; return res.end(); }
      istatistik.indirilen++;
      return res.end(dosyalar.get(id));
    }
    m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    if (!m) return hata(404, 'Not Found');
    if (m[1] !== jeton) return hata(401, 'Unauthorized');
    const yontem = m[2];
    istatistik.cagri.push(yontem);
    let p = {};
    const tur = req.headers['content-type'] || '';
    if (tur.startsWith('application/json')) p = JSON.parse(govde.toString() || '{}');
    else if (tur.startsWith('multipart/form-data')) {
      const f = await new Request('http://x/', { method: 'POST', headers: { 'content-type': tur }, body: govde }).formData();
      for (const [k, v] of f.entries()) p[k] = typeof v === 'string' ? v : { ad: v.name, veri: Buffer.from(await v.arrayBuffer()) };
    }
    if (p.chat_id !== undefined && String(p.chat_id) !== String(sohbet)) return hata(400, 'Bad Request: chat not found');

    switch (yontem) {
      case 'getMe': return yaz(200, { ok: true, result: { id: 1, is_bot: true, username: 'sahte_bot' } });
      case 'sendDocument': {
        if (kalan429 > 0) { kalan429--; return hata(429, 'Too Many Requests: retry after 1', { parameters: { retry_after: 1 } }); }
        if (!p.document || !p.document.veri) return hata(400, 'Bad Request: there is no document in the request');
        if (govde.length > 50 * 1024 * 1024) return hata(413, 'Request Entity Too Large');
        const id = 'F' + (++sayac);
        dosyalar.set(id, p.document.veri);
        istatistik.gonderilen++;
        istatistik.enBuyukYukleme = Math.max(istatistik.enBuyukYukleme, p.document.veri.length);
        const mesaj = { message_id: sayac, date: sayac, chat: { id: Number(sohbet), type: 'private' }, caption: p.caption,
          document: { file_id: id, file_unique_id: 'U' + id, file_name: p.document.ad, file_size: p.document.veri.length } };
        mesajlar.push(mesaj);
        return yaz(200, { ok: true, result: mesaj });
      }
      case 'getFile': {
        const v = dosyalar.get(p.file_id);
        if (!v) return hata(400, 'Bad Request: invalid file_id');
        if (v.length > 20 * 1024 * 1024) return hata(400, 'Bad Request: file is too big');
        istatistik.enBuyukIndirme = Math.max(istatistik.enBuyukIndirme, v.length);
        return yaz(200, { ok: true, result: { file_id: p.file_id, file_size: v.length, file_path: 'documents/' + p.file_id + '.bin' } });
      }
      case 'getChat': {
        const son = mesajlar.filter((x) => sabit.has(x.message_id)).sort((a, b) => b.date - a.date)[0];
        return yaz(200, { ok: true, result: { id: Number(sohbet), type: 'private', ...(son ? { pinned_message: son } : {}) } });
      }
      case 'pinChatMessage': sabit.add(Number(p.message_id)); return yaz(200, { ok: true, result: true });
      case 'unpinChatMessage': sabit.delete(Number(p.message_id)); return yaz(200, { ok: true, result: true });
      default: return hata(404, 'Not Found: method not found');
    }
  });
  return {
    sunucu, dosyalar, mesajlar, sabit, istatistik,
    baslat: () => new Promise((r) => sunucu.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + sunucu.address().port))),
    kapat: () => new Promise((r) => sunucu.close(r)),
  };
}
module.exports = { sahteTelegram };

// Doğrudan çalıştırma (runner testi): JETON, SOHBET, PORT ortam değişkenleri
if (require.main === module) {
  const t = sahteTelegram({ jeton: process.env.JETON, sohbet: process.env.SOHBET });
  t.sunucu.listen(Number(process.env.PORT || 8099), '127.0.0.1', () => console.log('sahte telegram hazır'));
  setInterval(() => console.log('istatistik ' + JSON.stringify({ ...t.istatistik, cagri: t.istatistik.cagri.length, sabit: [...t.sabit] })), 60000).unref();
}
