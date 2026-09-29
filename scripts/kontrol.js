// Başlatma sayfasından gelen istekleri emülatöre uygular.
// Kapının arkasında çalışır: /k/<sır>/_ctl/<yol> → 127.0.0.1:8001/<yol>
//   GET /yon?a=<0|90|180|270>   telefonun yönü → emülatörün ivme sensörü (Android kendisi döner)
//   GET /tus?k=<geri|ana|son>   gezinme tuşu
//   GET /ekran?g=<720|540|432>  Android ekran çözünürlüğü (düşük = daha az çizim + kodlama yükü)
//       &oran=<1.5–2.4>&dp=<320–480>  isteğe bağlı: ekranı telefonun oranına ve boyutuna uydur
//       (boy = genişlik × oran; dp = Android arayüzünün genişliği, telefondaki CSS pikseline eşit)
//   GET /anim?o=<0|0.5|1>       Android animasyon hızı (0 = kapalı)
//   GET /tani?...               tam.html'in dokunma tanı özeti; yalnızca günlüğe yazılır (komut çalıştırmaz)
//   /kayit/...                  oyun kaydı (Telegram): bkz. scripts/kayit.js
// Kullanım: ADB=<adb yolu> SERIAL=<emulator-5554> node scripts/kontrol.js
const http = require('http');
const { execFile } = require('child_process');

const G = 9.81;
// Telefon dik tutulduğunda yerçekimi +Y; 90° saat yönünün tersine çevrilince +X, vb.
const YON = { 0: [0, G, 0], 90: [G, 0, 0], 180: [0, -G, 0], 270: [-G, 0, 0] };
const TUS = { geri: 'KEYCODE_BACK', ana: 'KEYCODE_HOME', son: 'KEYCODE_APP_SWITCH' };
// Genişlik → [boyut, dpi]. Hepsi 360dp genişlik: arayüz aynı görünür, sadece piksel sayısı değişir.
// 720 emülatörün kendi boyutu (720x1560@320) olduğu için sıfırlanır.
const EKRAN = { 720: null, 540: ['540x1170', '240'], 432: ['432x936', '192'] };
const ANIM = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'];

// İstek yolunu çalıştırılacak adb komutlarına çevirir (saf fonksiyon, test edilebilir).
// Dönüş: argv dizilerinin listesi ya da geçersizse null.
function istekCoz(adres, serial) {
  const u = new URL(adres, 'http://yerel');
  const kabuk = (...a) => ['-s', serial, 'shell', ...a];
  if (u.pathname === '/yon') {
    const ham = u.searchParams.get('a');
    if (ham === null || ham.trim() === '') return null;
    const a = Number(ham);
    if (!Number.isFinite(a)) return null;
    const v = YON[((Math.round(a / 90) * 90) % 360 + 360) % 360];
    if (!v) return null;
    return [['-s', serial, 'emu', 'sensor', 'set', 'acceleration', v.map((x) => x.toFixed(2)).join(':')]];
  }
  if (u.pathname === '/tus') {
    const k = TUS[u.searchParams.get('k')];
    if (!k) return null;
    return [kabuk('input', 'keyevent', k)];
  }
  if (u.pathname === '/ekran') {
    const g = u.searchParams.get('g');
    if (!Object.prototype.hasOwnProperty.call(EKRAN, g)) return null;
    if (u.searchParams.has('oran') || u.searchParams.has('dp')) {
      const oran = Number(u.searchParams.get('oran'));
      const dp = Number(u.searchParams.get('dp'));
      if (!(oran >= 1.5 && oran <= 2.4) || !(dp >= 320 && dp <= 480)) return null;
      const en = g === '540' ? 536 : Number(g);              // scrcpy iki kenarı da 8'in katına indirir;
      const boy = Math.round((en * oran) / 8) * 8;           // tam katı seçilince video piksel piksel aynı kalır
      return [kabuk('wm', 'size', en + 'x' + boy), kabuk('wm', 'density', String(Math.round((en * 160) / dp)))];
    }
    const e = EKRAN[g];
    if (!e) return [kabuk('wm', 'size', 'reset'), kabuk('wm', 'density', 'reset')];
    return [kabuk('wm', 'size', e[0]), kabuk('wm', 'density', e[1])];
  }
  if (u.pathname === '/tani') return [];
  if (u.pathname === '/anim') {
    const o = u.searchParams.get('o');
    if (!['0', '0.5', '1'].includes(o)) return null;
    return ANIM.map((ad) => kabuk('settings', 'put', 'global', ad, o));
  }
  return null;
}

module.exports = { istekCoz };

if (require.main === module) {
  const ADB = process.env.ADB;
  const SERIAL = process.env.SERIAL;
  let sonYon = null;
  const { Kayit, AdbCihaz, kayitIstegi } = require('./kayit');
  const saat = () => new Date().toISOString().slice(11, 19);
  const kayit = new Kayit(new AdbCihaz(ADB, SERIAL), { tgTaban: process.env.TG_API, gunluk: (s) => console.log(saat() + ' ' + s) });
  // Otomatik kayıt: 15 dakikada bir; geri yükleme bitmiş olmalı, değişiklik yoksa hiçbir şey gönderilmez.
  setInterval(() => {
    const d = kayit.durum();
    if (d.ayarli && d.geriYuklendi && !d.islem) kayit.kaydet();
  }, 15 * 60 * 1000);

  // Komutları sırayla çalıştırır; ilk hatada durur.
  function sirayla(komutlar, bitti) {
    if (!komutlar.length) { bitti(null); return; }
    execFile(ADB, komutlar[0], { timeout: 8000 }, (hata) => {
      if (hata) { bitti(hata); return; }
      sirayla(komutlar.slice(1), bitti);
    });
  }

  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url.startsWith('/kayit/')) { kayitIstegi(kayit, req, res); return; }
    const komutlar = istekCoz(req.url, SERIAL);
    if (!komutlar) { res.statusCode = 400; res.end('gecersiz'); return; }
    if (req.url.startsWith('/tani?')) {
      // Günlük herkese açık olabilir: yalnızca beklenen karakterler, kısa.
      let ozet = req.url.slice(6);
      try { ozet = decodeURIComponent(ozet); } catch { /* bozuk kodlama: ham haliyle süzülür */ }
      ozet = ozet.replace(/[^A-Za-z0-9=&x._ -]/g, '').slice(0, 200);
      console.log(new Date().toISOString().slice(11, 19) + ' tani ' + ozet);
    }
    // Aynı yön tekrar gelirse emülatörü boşuna meşgul etme.
    const yon = komutlar.length && komutlar[0][2] === 'emu' ? komutlar[0][6] : null;   // ['-s', seri, 'emu', ..., değer]
    if (yon && yon === sonYon) { res.end('ok'); return; }
    sirayla(komutlar, (hata) => {
      if (!hata && yon) sonYon = yon;
      res.statusCode = hata ? 500 : 200;
      res.end(hata ? 'hata' : 'ok');
    });
  }).listen(8001, '127.0.0.1');
}
