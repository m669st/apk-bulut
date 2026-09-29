// Oyun kaydı: kullanıcının kurduğu uygulamaların APK'ları ve verileri Telegram botuna şifreli yedeklenir,
// yeni oturumda geri yüklenir.
//
// Depolama (Telegram Bot API): bot kendi sohbetine belge gönderir. Bot API indirme sınırı 20 MB olduğu için
// her içerik 19 MB'lık parçalara bölünür; her parça AES-256-GCM ile ayrı şifrelenir (bağlam = içerik özeti +
// sıra, parçalar karıştırılamaz). Kaydın listesi (manifest) de şifreli bir belgedir ve sohbete sabitlenir;
// yeni oturum getChat → pinned_message ile en son kaydı bulur. Aynı içerik (özet) bir daha yüklenmez.
//
// Anahtar ve bot jetonu başlatma sayfasından gizli kapı üzerinden gelir, yalnızca bellekte tutulur, hiçbir
// yere yazılmaz ve günlüğe basılmaz (depo ve günlükleri herkese açık olabilir).
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');

const PARCA = 19 * 1024 * 1024;
const EN_BUYUK = 1900 * 1024 * 1024;          // tek içerik üst sınırı (bellekte tutulur)
const MANIFEST_ADI = 'apk-bulut-kayit.bin';
const ACIKLAMA = 'APK Bulut kaydı';
const bekle = (ms) => new Promise((r) => setTimeout(r, ms));
const ozet = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- Şifreleme: iv(12) || şifreli || etiket(16), bağlam AAD olarak bağlanır ----
function sifrele(anahtar, veri, baglam) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', anahtar, iv);
  c.setAAD(Buffer.from('apk-bulut|' + baglam));
  return Buffer.concat([iv, c.update(veri), c.final(), c.getAuthTag()]);
}
function coz(anahtar, veri, baglam) {
  if (veri.length < 28) throw new Error('bozuk parça');
  const d = crypto.createDecipheriv('aes-256-gcm', anahtar, veri.subarray(0, 12));
  d.setAAD(Buffer.from('apk-bulut|' + baglam));
  d.setAuthTag(veri.subarray(veri.length - 16));
  return Buffer.concat([d.update(veri.subarray(12, veri.length - 16)), d.final()]);
}

// ---- Telegram Bot API ----
class Telegram {
  constructor(jeton, sohbet, taban) {
    this.jeton = jeton;
    this.sohbet = sohbet;
    this.taban = taban || 'https://api.telegram.org';
  }

  // Hata metinlerinde jeton asla yer almaz (yalnızca yöntem adı ve Telegram'ın açıklaması).
  async istek(yontem, secenek) {
    for (let deneme = 1; ; deneme++) {
      let j = null, durum = 0;
      try {
        const r = await fetch(`${this.taban}/bot${this.jeton}/${yontem}`, { method: 'POST', ...secenek() });
        durum = r.status;
        j = await r.json().catch(() => null);
      } catch (e) {
        if (deneme >= 4) throw new Error(`Telegram ${yontem}: bağlantı hatası`);
        await bekle(1500 * deneme);
        continue;
      }
      if (j && j.ok) return j.result;
      const kod = j ? j.error_code : durum;
      if ((kod === 429 || kod >= 500) && deneme < 6) {
        await bekle(((j && j.parameters && j.parameters.retry_after) || deneme * 2) * 1000);
        continue;
      }
      throw new Error(`Telegram ${yontem}: ${kod} ${(j && j.description) || ''}`.trim());
    }
  }

  cagir(yontem, veri) {
    return this.istek(yontem, () => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(veri) }));
  }

  belgeGonder(ad, veri, aciklama) {
    return this.istek('sendDocument', () => {
      const f = new FormData();
      f.append('chat_id', String(this.sohbet));
      f.append('disable_notification', 'true');
      if (aciklama) f.append('caption', aciklama);
      f.append('document', new Blob([veri]), ad);
      return { body: f };
    });
  }

  async indir(dosyaId) {
    const f = await this.cagir('getFile', { file_id: dosyaId });
    for (let deneme = 1; ; deneme++) {
      try {
        const r = await fetch(`${this.taban}/file/bot${this.jeton}/${f.file_path}`);
        if (!r.ok) throw new Error(String(r.status));
        return Buffer.from(await r.arrayBuffer());
      } catch (e) {
        if (deneme >= 4) throw new Error('Telegram dosya indirme: ' + e.message.replace(this.jeton, '<bot>'));
        await bekle(1500 * deneme);
      }
    }
  }
}

// ---- Android (adb + root) ----
class AdbCihaz {
  constructor(adb, seri) {
    this.adb = adb;
    this.seri = seri;
    this.betik = '/data/local/tmp/kayit-cihaz.sh';
  }

  calis(args, { zaman = 300000 } = {}) {
    return new Promise((coz_, red) => {
      execFile(this.adb, ['-s', this.seri, ...args], { timeout: zaman, maxBuffer: 64 << 20 }, (hata, cikti, hatacikti) => {
        if (hata) red(new Error((String(hatacikti || '').trim() || hata.message).slice(-300)));
        else coz_(String(cikti));
      });
    });
  }

  async hazirla() {
    await this.calis(['push', path.join(__dirname, 'kayit-cihaz.sh'), this.betik]);
    const kim = (await this.calis(['shell', 'su', '0', 'id', '-u'])).trim();
    if (kim !== '0') throw new Error('Android içinde root yok');
  }

  kok(...args) { return this.calis(['shell', 'su', '0', 'sh', this.betik, ...args]); }

  async paketler() {
    const c = await this.calis(['shell', 'pm', 'list', 'packages', '-3', '-U']);
    return c.split('\n').map((s) => /^package:([\w.]+) uid:(\d+)/.exec(s.trim())).filter(Boolean)
      .map((m) => ({ ad: m[1], uid: Number(m[2]) }));
  }

  async surumKodu(ad) {
    const m = /versionCode=(\d+)/.exec(await this.calis(['shell', 'dumpsys', 'package', ad]));
    return m ? Number(m[1]) : 0;
  }

  async apkYollari(ad) {
    const c = await this.calis(['shell', 'pm', 'path', ad]);
    return c.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('package:')).map((s) => s.slice(8));
  }

  async cek(yol) {
    const yerel = path.join(os.tmpdir(), 'kayit-' + crypto.randomBytes(6).toString('hex'));
    try {
      await this.calis(['pull', yol, yerel]);
      return fs.readFileSync(yerel);
    } finally {
      fs.rmSync(yerel, { force: true });
    }
  }

  async gonder(veri, yol) {
    const yerel = path.join(os.tmpdir(), 'kayit-' + crypto.randomBytes(6).toString('hex'));
    try {
      fs.writeFileSync(yerel, veri);
      await this.calis(['push', yerel, yol]);
    } finally {
      fs.rmSync(yerel, { force: true });
    }
  }

  // → { veri, dis, obb: Buffer|null, sahip: metin }
  async yedekle(ad) {
    const k = '/data/local/tmp/kb/' + ad;
    await this.kok('yedekle', ad);
    try {
      const var_ = (await this.calis(['shell', 'ls', k])).split(/\s+/);
      const al = async (d) => (var_.includes(d) ? this.cek(k + '/' + d) : null);
      return { sahip: (await al('sahip')).toString('utf8'), veri: await al('veri.tar'), dis: await al('dis.tar'), obb: await al('obb.tar') };
    } finally {
      await this.calis(['shell', 'su', '0', 'rm', '-rf', k]).catch(() => {});
    }
  }

  async kur(apklar) {
    const klasor = fs.mkdtempSync(path.join(os.tmpdir(), 'kayit-apk-'));
    try {
      const yollar = apklar.map((a, i) => {
        const y = path.join(klasor, `${i}-${a.ad.replace(/[^\w.-]/g, '_')}`);
        fs.writeFileSync(y, a.veri);
        return y;
      });
      await this.calis(['install-multiple', '-r', '-g', ...yollar], { zaman: 600000 });
    } finally {
      fs.rmSync(klasor, { recursive: true, force: true });
    }
  }

  async geriYukle(ad, { sahip, veri, dis, obb }) {
    const k = '/data/local/tmp/kb/' + ad;
    await this.calis(['shell', 'su', '0', 'rm', '-rf', k]);
    await this.calis(['shell', 'mkdir', '-p', k]);
    await this.gonder(Buffer.from(sahip), k + '/sahip');
    for (const [d, b] of [['veri.tar', veri], ['dis.tar', dis], ['obb.tar', obb]]) if (b) await this.gonder(b, k + '/' + d);
    const c = await this.kok('geriyukle', ad);
    if (!/tamam/.test(c)) throw new Error('geri yükleme betiği: ' + c.slice(-200));
  }
}

// ---- Kayıt yöneticisi ----
class Kayit {
  constructor(cihaz, secenek = {}) {
    this.cihaz = cihaz;
    this.tgTaban = secenek.tgTaban;
    this.gunluk = secenek.gunluk || (() => {});
    this.tg = null;
    this.anahtar = null;
    this.son = null;                 // { manifest, mesajId } — sohbetteki en son kayıt
    this.apkBellek = new Map();      // cihazdaki APK yolu → özet (her kayıtta 100 MB çekmemek için)
    this.hazirlandi = false;
    this.d = { ayarli: false, islem: null, asama: '', geriYuklendi: false, sonKayit: null, sonuc: null };
  }

  durum() { return { ...this.d }; }

  // Başlatma sayfasından: { bot, sohbet, anahtar (base64, 32 bayt) }
  ayarla(g) {
    if (!g || typeof g.bot !== 'string' || !/^\d{5,}:[\w-]{30,}$/.test(g.bot)) throw new Error('bot jetonu geçersiz');
    if (!/^-?\d{1,20}$/.test(String(g.sohbet))) throw new Error('sohbet geçersiz');
    const anahtar = Buffer.from(String(g.anahtar || ''), 'base64');
    if (anahtar.length !== 32) throw new Error('anahtar geçersiz');
    const degisti = !this.tg || this.tg.jeton !== g.bot || String(this.tg.sohbet) !== String(g.sohbet) || !this.anahtar.equals(anahtar);
    if (degisti) {
      this.tg = new Telegram(g.bot, String(g.sohbet), this.tgTaban);
      this.anahtar = anahtar;
      this.son = null;
      this.d.geriYuklendi = false;
      this.d.sonKayit = null;
    }
    this.d.ayarli = true;
  }

  // Aynı anda tek işlem. Hiçbir zaman reddedilmez: sonuç { tur, basari, mesaj, zaman } döner.
  _islem(ad, fn) {
    const zaman = () => new Date().toISOString();
    if (!this.d.ayarli) return Promise.resolve({ tur: ad, basari: false, mesaj: 'Telegram kaydı ayarlı değil', zaman: zaman() });
    if (this.d.islem) return Promise.resolve({ tur: ad, basari: false, mesaj: 'Başka bir kayıt işlemi sürüyor', zaman: zaman() });
    this.d.islem = ad;
    this.d.asama = '';
    this.surec = (async () => {
      try {
        if (!this.hazirlandi) { await this.cihaz.hazirla(); this.hazirlandi = true; }
        const mesaj = await fn();
        this.d.sonuc = { tur: ad, basari: true, mesaj, zaman: zaman() };
        this.gunluk(`kayit ${ad}: ${mesaj}`);
      } catch (e) {
        this.d.sonuc = { tur: ad, basari: false, mesaj: e.message, zaman: zaman() };
        this.gunluk(`kayit ${ad} hata: ${e.message}`);
      } finally {
        this.d.islem = null;
        this.d.asama = '';
      }
      return this.d.sonuc;
    })();
    return this.surec;
  }

  // Süren işlem (varsa) bittikten sonra çalıştırır.
  sonra(fn) { return Promise.resolve(this.surec).catch(() => {}).then(fn); }

  async _sonKaydiBul() {
    const sohbet = await this.tg.cagir('getChat', { chat_id: this.tg.sohbet });
    const m = sohbet && sohbet.pinned_message;
    if (!m || !m.document || m.document.file_name !== MANIFEST_ADI) return null;
    const sifreli = await this.tg.indir(m.document.file_id);
    let manifest;
    try {
      manifest = JSON.parse(coz(this.anahtar, sifreli, 'manifest').toString('utf8'));
    } catch {
      throw new Error('Kayıt bu anahtarla açılamadı (site anahtarı yenilenmiş olabilir)');
    }
    if (manifest.surum !== 1 || !Array.isArray(manifest.paketler)) throw new Error('kayıt biçimi tanınmıyor');
    return { manifest, mesajId: m.message_id };
  }

  async _blobIndir(manifest, sha) {
    const b = manifest.bloblar[sha];
    if (!b) throw new Error('kayıtta eksik parça');
    const parcalar = [];
    for (let i = 0; i < b.parcalar.length; i++) parcalar.push(coz(this.anahtar, await this.tg.indir(b.parcalar[i]), `${sha}|${i}`));
    let veri = Buffer.concat(parcalar);
    if (b.gzip) veri = zlib.gunzipSync(veri);
    if (ozet(veri) !== sha) throw new Error('kayıt bozuk (özet tutmuyor)');
    return veri;
  }

  async _blobYukle(veri, onceki, yeni, gzip) {
    const sha = ozet(veri);
    if (yeni[sha]) return sha;
    if (onceki && onceki.bloblar[sha]) { yeni[sha] = onceki.bloblar[sha]; return sha; }
    if (veri.length > EN_BUYUK) throw new Error('içerik çok büyük (' + Math.round(veri.length / 1048576) + ' MB)');
    const yuk = gzip ? zlib.gzipSync(veri, { level: 6 }) : veri;
    const parcalar = [];
    for (let i = 0; i * PARCA < yuk.length || i === 0; i++) {
      const m = await this.tg.belgeGonder(`${sha.slice(0, 16)}-${i}.bin`, sifrele(this.anahtar, yuk.subarray(i * PARCA, (i + 1) * PARCA), `${sha}|${i}`));
      parcalar.push(m.document.file_id);
    }
    yeni[sha] = { boyut: veri.length, gzip: !!gzip, parcalar };
    return sha;
  }

  geriYukle() {
    return this._islem('geri', async () => {
      this.d.asama = 'Kayıt aranıyor';
      const son = await this._sonKaydiBul();
      this.son = son;
      if (!son) { this.d.geriYuklendi = true; return 'Kayıt yok, yeni başlıyor'; }
      this.d.sonKayit = son.manifest.zaman;
      const m = son.manifest;
      const kurulu = new Map((await this.cihaz.paketler()).map((p) => [p.ad, p]));
      for (const p of m.paketler) {
        const onceki = kurulu.get(p.ad);
        if (!onceki || (await this.cihaz.surumKodu(p.ad)) < p.surumKodu) {
          this.d.asama = `${p.ad} kuruluyor`;
          const apklar = [];
          for (const a of p.apklar) apklar.push({ ad: a.ad, veri: await this._blobIndir(m, a.sha) });
          await this.cihaz.kur(apklar);
        }
        this.d.asama = `${p.ad} verisi yükleniyor`;
        const al = async (sha) => (sha ? this._blobIndir(m, sha) : null);
        await this.cihaz.geriYukle(p.ad, { sahip: p.sahip, veri: await al(p.veri), dis: await al(p.dis), obb: await al(p.obb) });
      }
      this.d.geriYuklendi = true;
      return `${m.paketler.length} uygulama geri yüklendi`;
    });
  }

  // zorla: geri yükleme yapılmamışken de kaydet (yalnızca elle)
  kaydet({ zorla = false } = {}) {
    if (!zorla && this.d.ayarli && !this.d.geriYuklendi && !this.d.islem) {
      return Promise.resolve({ tur: 'kaydet', basari: false, mesaj: 'Önce kayıt geri yüklenmeli', zaman: new Date().toISOString() });
    }
    return this._islem('kaydet', async () => {
      if (!this.son) this.son = await this._sonKaydiBul().catch(() => null);
      const onceki = this.son && this.son.manifest;
      const bloblar = {};
      const paketler = [];
      for (const p of await this.cihaz.paketler()) {
        this.d.asama = `${p.ad} kaydediliyor`;
        const apklar = [];
        for (const yol of await this.cihaz.apkYollari(p.ad)) {
          const ad = path.basename(yol);
          let sha = this.apkBellek.get(yol);
          if (!sha || !(onceki && onceki.bloblar[sha]) && !bloblar[sha]) sha = await this._blobYukle(await this.cihaz.cek(yol), onceki, bloblar, false);
          else if (!bloblar[sha]) bloblar[sha] = onceki.bloblar[sha];
          this.apkBellek.set(yol, sha);
          apklar.push({ ad, sha });
        }
        const y = await this.cihaz.yedekle(p.ad);
        const yukle = (b) => (b ? this._blobYukle(b, onceki, bloblar, true) : null);
        paketler.push({
          ad: p.ad, surumKodu: await this.cihaz.surumKodu(p.ad), apklar, sahip: y.sahip,
          veri: await yukle(y.veri), dis: await yukle(y.dis), obb: await yukle(y.obb),
        });
      }
      if (onceki && JSON.stringify(onceki.paketler) === JSON.stringify(paketler)) return 'Değişiklik yok';
      const manifest = { surum: 1, zaman: new Date().toISOString(), paketler, bloblar };
      this.d.asama = 'Kayıt listesi gönderiliyor';
      const tarih = manifest.zaman.replace('T', ' ').slice(0, 16) + ' UTC';
      const mesaj = await this.tg.belgeGonder(MANIFEST_ADI, sifrele(this.anahtar, Buffer.from(JSON.stringify(manifest)), 'manifest'), `${ACIKLAMA} · ${tarih}`);
      await this.tg.cagir('pinChatMessage', { chat_id: this.tg.sohbet, message_id: mesaj.message_id, disable_notification: true });
      if (this.son) await this.tg.cagir('unpinChatMessage', { chat_id: this.tg.sohbet, message_id: this.son.mesajId }).catch(() => {});
      this.son = { manifest, mesajId: mesaj.message_id };
      this.d.sonKayit = manifest.zaman;
      this.d.geriYuklendi = true;
      return `${paketler.length} uygulama kaydedildi`;
    });
  }
}

// ---- HTTP uçları (kontrol.js, kapının arkasında: /k/<sır>/_ctl/kayit/...) ----
//   POST /kayit/ayarla      gövde (text/plain, JSON): { bot, sohbet, anahtar }  — ön kontrolsüz basit istek
//   GET  /kayit/yukle       en son kaydı geri yükle (oturumda bir kez; ?tekrar=1 yeniden dener)
//   GET  /kayit/kaydet      şimdi kaydet (?zorla=1: geri yüklenmemişken de; ?bekle=1: bitene kadar bekle)
//   GET  /kayit/durum       { ayarli, islem, asama, geriYuklendi, sonKayit, sonuc }
// Uzun işlemler 202 ile hemen döner (tünel 100 sn'de keser); sonuç /kayit/durum'dan izlenir.
function kayitIstegi(kayit, req, res) {
  const u = new URL(req.url, 'http://yerel');
  const yanit = (kod, veri) => {
    res.statusCode = kod;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(veri));
  };
  if (u.pathname === '/kayit/ayarla') {
    if (req.method !== 'POST') { yanit(405, { hata: 'POST' }); return; }
    let govde = '';
    let asti = false;
    req.setEncoding('utf8');
    req.on('data', (p) => { govde += p; if (govde.length > 4096 && !asti) { asti = true; yanit(413, { hata: 'büyük' }); req.destroy(); } });
    req.on('end', () => {
      if (asti) return;
      try { kayit.ayarla(JSON.parse(govde)); yanit(200, kayit.durum()); } catch (e) { yanit(400, { hata: e.message }); }
    });
    return;
  }
  if (u.pathname === '/kayit/durum') { yanit(200, kayit.durum()); return; }
  if (u.pathname === '/kayit/yukle' || u.pathname === '/kayit/kaydet') {
    if (!kayit.durum().ayarli) { yanit(409, { hata: 'Telegram kaydı ayarlı değil', ...kayit.durum() }); return; }
    const bekle_ = u.searchParams.get('bekle') === '1';
    let is;
    if (u.pathname === '/kayit/yukle') {
      const tekrar = u.searchParams.get('tekrar') === '1';
      is = kayit.durum().geriYuklendi && !tekrar ? null : kayit.geriYukle();
    } else {
      const zorla = u.searchParams.get('zorla') === '1';
      is = bekle_ ? kayit.sonra(() => kayit.kaydet({ zorla })) : kayit.kaydet({ zorla });
    }
    if (bekle_ && is) { is.then((s) => yanit(200, { ...kayit.durum(), sonuc: s })); return; }
    yanit(202, kayit.durum());
    return;
  }
  yanit(404, { hata: 'bilinmeyen kayıt yolu' });
}

module.exports = { Kayit, AdbCihaz, Telegram, kayitIstegi, sifrele, coz, PARCA, MANIFEST_ADI };
