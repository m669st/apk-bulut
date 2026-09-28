// Dokunma ölçümü (yalnızca test dalı): gerçek Android + ws-scrcpy-web + kapı üzerinden,
// telefon gibi davranan tarayıcının dokunmaları Android'e ulaşıyor mu?
// Kullanım: ADB=<adb> TARAYICI=chrome|webkit CERCEVE=eski|yeni|'' node dokunma-olcum.js <etiket>
//   CERCEVE verilirse tam.html, başlatma sayfası gibi BAŞKA origin'deki (localhost:9000) bir iframe içinde açılır.
const fs = require('fs');
const { execFileSync } = require('child_process');
const pw = require(process.env.PW_YOL || 'playwright-core');

const ADB = process.env.ADB;
const SIR = fs.readFileSync('/tmp/oturum/sir', 'utf8').trim();
const ETIKET = process.argv[2] || 'ölçüm';
const TARAYICI = process.env.TARAYICI || 'chrome';
const CERCEVE = process.env.CERCEVE || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sonuc = [];
const not = (baslik, metin) => { console.log(`::notice title=${ETIKET} · ${baslik}::${metin}`); sonuc.push(baslik + ': ' + metin); };

function adb(...a) { return execFileSync(ADB, ['-s', 'emulator-5554', ...a], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 << 20 }); }
function odak() {
  const m = /(topResumedActivity|mResumedActivity)[^\n]*/.exec(adb('shell', 'dumpsys', 'activity', 'activities'));
  return m ? m[0].trim().replace(/\s+/g, ' ') : '';
}
function pencere() {
  const m = /mCurrentFocus=[^\n]*/.exec(adb('shell', 'dumpsys window | grep -E "mCurrentFocus"'));
  return m ? m[0].trim() : '';
}
function ayarlariAc() {
  adb('shell', 'am', 'force-stop', 'com.android.settings');
  adb('shell', 'cmd', 'statusbar', 'collapse');
  adb('shell', 'am', 'start', '-W', '-a', 'android.settings.SETTINGS');
}
function arayuz() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/u.xml');
  const x = adb('shell', 'cat', '/sdcard/u.xml');
  const dugumler = [];
  const re = /<node [^>]*?text="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let m;
  while ((m = re.exec(x))) dugumler.push({ metin: m[1], x0: +m[2], y0: +m[3], x1: +m[4], y1: +m[5] });
  return dugumler;
}
function hedef() {
  const d = arayuz();
  const h = d.find((n) => /Network|internet/i.test(n.metin)) || d.find((n) => n.metin && n.y0 > 200);
  return h ? { metin: h.metin, x: Math.round((h.x0 + h.x1) / 2), y: Math.round((h.y0 + h.y1) / 2) } : null;
}
function ekranBoyu() {
  const m = /(Override|Physical) size: (\d+)x(\d+)/.exec(adb('shell', 'wm', 'size').split('\n').reverse().join('\n'));
  return m ? { en: +m[2], boy: +m[3] } : null;
}

(async () => {
  const tam = `http://127.0.0.1:8080/k/${SIR}/tam.html?device=emulator-5554&host=127.0.0.1&port=8080&secure=false` +
    `&pathname=${encodeURIComponent('/k/' + SIR + '/')}&codec=h264&deviceKind=phone&audio=false&maxFps=30&bitrate=4000000`;
  const url = CERCEVE ? `http://localhost:9000/cerceve-${CERCEVE}.html#${encodeURIComponent(tam)}` : tam;
  const iphone = {
    viewport: { width: 430, height: 839 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  };
  const tarayici = TARAYICI === 'webkit'
    ? await pw.webkit.launch()
    : await pw.chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const baglam = await tarayici.newContext(TARAYICI === 'webkit' ? pw.devices['iPhone 15 Plus'] : iphone);
  const sayfa = await baglam.newPage();
  const hatalar = [];
  sayfa.on('pageerror', (e) => hatalar.push(String(e).slice(0, 160)));
  sayfa.on('console', (m) => { if (m.type() === 'error') hatalar.push('konsol: ' + m.text().slice(0, 140)); });
  const giden = [];
  sayfa.on('websocket', (ws) => {
    if (!ws.url().includes('action=stream')) return;
    ws.on('framesent', (f) => {
      const b = Buffer.isBuffer(f.payload) ? f.payload : Buffer.from(f.payload || '');
      if (b.length === 33 && b[0] === 2 && b[1] === 2) {
        giden.push({ eylem: b[2], x: b.readUInt32BE(11), y: b.readUInt32BE(15), en: b.readUInt16BE(19), boy: b.readUInt16BE(21), basinc: b.readUInt16BE(23) });
      }
    });
  });

  ayarlariAc();
  await sayfa.goto(url);
  const cerceveBul = () => sayfa.frames().find((f) => f.url().includes('/tam.html')) || null;
  // Akış bağlansın (durum "connected") ve tuval gerçek video boyutunu alsın
  let cer = null, durum = '';
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    cer = cerceveBul();
    if (!cer) continue;
    durum = await cer.evaluate(() => (document.getElementById('status') || {}).textContent || '').catch(() => '');
    if (/^connected/.test(durum)) break;
  }
  await sleep(2500);
  async function tuvalOlc() {
    const t = await cer.evaluate(() => {
      const c = document.querySelector('.touch-layer');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { en: c.width, boy: c.height, sol: r.left, ust: r.top, g: r.width, y: r.height };
    }).catch(() => null);
    if (!t) return null;
    if (CERCEVE) {                                      // iframe'in sayfadaki yeri eklenir
      const k = await sayfa.evaluate(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return { sol: r.left, ust: r.top }; });
      t.sol += k.sol; t.ust += k.ust;
    }
    return t;
  }
  const tuval = cer && await tuvalOlc();
  if (!tuval || !/^connected/.test(durum)) {
    not('SONUÇ', 'akış açılmadı. durum: ' + durum + ' · hatalar: ' + hatalar.slice(0, 3).join(' | '));
    await tarayici.close();
    return;
  }
  const eb = ekranBoyu();
  not('akış', `video ${tuval.en}x${tuval.boy}, Android ${eb ? eb.en + 'x' + eb.boy : '?'}, ekranda ${Math.round(tuval.g)}x${Math.round(tuval.y)} @(${Math.round(tuval.sol)},${Math.round(tuval.ust)}) · ${durum}`);
  const nokta = (x, y) => ({
    px: tuval.sol + (x + 0.5) * tuval.g / eb.en,
    py: tuval.ust + (y + 0.5) * tuval.y / eb.boy,
  });

  const cdp = TARAYICI === 'chrome' ? await baglam.newCDPSession(sayfa) : null;
  async function dokun(px, py, force) {
    if (!cdp) { await sayfa.touchscreen.tap(px, py); return; }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: px, y: py, force, id: 1 }] });
    await sleep(70);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  async function kaydir(x0, y0, x1, y1, force, adim = 12) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0, force, id: 1 }] });
    for (let i = 1; i <= adim; i++) {
      await sleep(16);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + (x1 - x0) * i / adim, y: y0 + (y1 - y0) * i / adim, force, id: 1 }] });
    }
    await sleep(30);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  // Dokunma: hedefin tam ortasına; Android'in açtığı ekran ve giden mesaj kaydedilir
  for (let tur = 1; tur <= 2; tur++) {
    ayarlariAc();
    await sleep(1500);
    const h = hedef();
    if (!h) { not('dokunma ' + tur, 'hedef bulunamadı'); continue; }
    const once = odak();
    const n0 = giden.length;
    const { px, py } = nokta(h.x, h.y);
    await dokun(px, py, 0);
    await sleep(2500);
    const sonra = odak();
    const msj = giden.slice(n0).map((m) => `${['DOWN', 'UP', 'MOVE'][m.eylem]}(${m.x},${m.y} ${m.en}x${m.boy} p=${m.basinc})`).join(' ');
    not('dokunma ' + tur, `${sonra !== once ? 'GEÇTİ — Android açtı' : 'KALDI — Android tepki vermedi'} · hedef "${h.metin}" (${h.x},${h.y}) · giden: ${msj || 'yok'}`);
  }

  if (cdp) {
    ayarlariAc();
    await sleep(1500);
    const bas = nokta(eb.en / 2, 3), son = nokta(eb.en / 2, eb.boy * 0.6);
    await kaydir(bas.px, bas.py, son.px, son.py, 0);
    await sleep(1500);
    const p = pencere();
    not('kenardan çekme (bildirim perdesi)', `${/NotificationShade|StatusBar/i.test(p) ? 'GEÇTİ — perde açıldı' : 'KALDI'} · ${p.slice(-60)}`);
    adb('shell', 'cmd', 'statusbar', 'collapse');
  }
  if (hatalar.length) not('sayfa hataları', hatalar.slice(0, 3).join(' | '));
  await tarayici.close();
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', `### ${ETIKET}\n\n${sonuc.map((s) => '- ' + s).join('\n')}\n\n`);
})().catch((e) => { console.log(`::error title=${ETIKET}::${String(e && e.stack || e).slice(0, 400)}`); process.exit(1); });
