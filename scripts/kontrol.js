// Başlatma sayfasından gelen yön ve tuş isteklerini emülatöre uygular.
// Kapının arkasında çalışır: /k/<sır>/_ctl/<yol> → 127.0.0.1:8001/<yol>
//   GET /yon?a=<0|90|180|270>   telefonun yönü → emülatörün ivme sensörü (Android kendisi döner)
//   GET /tus?k=<geri|ana|son>   gezinme tuşu
// Kullanım: ADB=<adb yolu> SERIAL=<emulator-5554> node scripts/kontrol.js
const http = require('http');
const { execFile } = require('child_process');

const G = 9.81;
// Telefon dik tutulduğunda yerçekimi +Y; 90° saat yönünün tersine çevrilince +X, vb.
const YON = { 0: [0, G, 0], 90: [G, 0, 0], 180: [0, -G, 0], 270: [-G, 0, 0] };
const TUS = { geri: 'KEYCODE_BACK', ana: 'KEYCODE_HOME', son: 'KEYCODE_APP_SWITCH' };

// İstek yolunu çalıştırılacak adb argümanlarına çevirir (saf fonksiyon, test edilebilir).
function istekCoz(adres, serial) {
  const u = new URL(adres, 'http://yerel');
  if (u.pathname === '/yon') {
    const ham = u.searchParams.get('a');
    if (ham === null || ham.trim() === '') return null;
    const a = Number(ham);
    if (!Number.isFinite(a)) return null;
    const v = YON[((Math.round(a / 90) * 90) % 360 + 360) % 360];
    if (!v) return null;
    return ['-s', serial, 'emu', 'sensor', 'set', 'acceleration', v.map((x) => x.toFixed(2)).join(':')];
  }
  if (u.pathname === '/tus') {
    const k = TUS[u.searchParams.get('k')];
    if (!k) return null;
    return ['-s', serial, 'shell', 'input', 'keyevent', k];
  }
  return null;
}

module.exports = { istekCoz };

if (require.main === module) {
  const ADB = process.env.ADB;
  const SERIAL = process.env.SERIAL;
  let sonYon = null;
  http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const argv = istekCoz(req.url, SERIAL);
    if (!argv) { res.statusCode = 400; res.end('gecersiz'); return; }
    // Aynı yön tekrar gelirse emülatörü boşuna meşgul etme.
    if (argv[3] === 'emu' && argv[6] === sonYon) { res.end('ok'); return; }
    execFile(ADB, argv, { timeout: 8000 }, (hata) => {
      if (!hata && argv[3] === 'emu') sonYon = argv[6];
      res.statusCode = hata ? 500 : 200;
      res.end(hata ? 'hata' : 'ok');
    });
  }).listen(8001, '127.0.0.1');
}
