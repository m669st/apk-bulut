// Başlatma sayfasından gelen istekleri emülatöre uygular.
// Kapının arkasında çalışır: /k/<sır>/_ctl/<yol> → 127.0.0.1:8001/<yol>
//   GET /yon?a=<0|90|180|270>   telefonun yönü → emülatörün ivme sensörü (Android kendisi döner)
//   GET /tus?k=<geri|ana|son>   gezinme tuşu
//   GET /ekran?g=<720|540|432>  Android ekran çözünürlüğü (düşük = daha az çizim + kodlama yükü)
//   GET /anim?o=<0|0.5|1>       Android animasyon hızı (0 = kapalı)
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
    const e = EKRAN[g];
    if (!e) return [kabuk('wm', 'size', 'reset'), kabuk('wm', 'density', 'reset')];
    return [kabuk('wm', 'size', e[0]), kabuk('wm', 'density', e[1])];
  }
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
    const komutlar = istekCoz(req.url, SERIAL);
    if (!komutlar) { res.statusCode = 400; res.end('gecersiz'); return; }
    // Aynı yön tekrar gelirse emülatörü boşuna meşgul etme.
    const yon = komutlar[0][2] === 'emu' ? komutlar[0][6] : null;   // ['-s', seri, 'emu', ..., değer]
    if (yon && yon === sonYon) { res.end('ok'); return; }
    sirayla(komutlar, (hata) => {
      if (!hata && yon) sonYon = yon;
      res.statusCode = hata ? 500 : 200;
      res.end(hata ? 'hata' : 'ok');
    });
  }).listen(8001, '127.0.0.1');
}
