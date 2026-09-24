// Oturum bilgisini başlatma sayfasının açık anahtarına şifreler.
// ECDH P-256 (tek kullanımlık anahtar) → HKDF-SHA256 (44 bayt: anahtar + IV) → AES-256-GCM.
// Çıktı: base64url( tek_kullanımlık_açık_anahtar[65] || şifreli_metin || etiket[16] )
// Kullanım: printf '%s' "<metin>" | node scripts/muhurle.js <alici_acik_anahtar_base64url>
const crypto = require('crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');

function muhurle(aliciB64u, metin) {
  const ham = Buffer.from(aliciB64u, 'base64url');
  if (ham.length !== 65 || ham[0] !== 4) throw new Error('geçersiz açık anahtar');
  const alici = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(ham.subarray(1, 33)), y: b64u(ham.subarray(33)) },
    format: 'jwk',
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ortak = crypto.diffieHellman({ privateKey, publicKey: alici });
  const j = publicKey.export({ format: 'jwk' });
  const tekPub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  const km = Buffer.from(crypto.hkdfSync('sha256', ortak, Buffer.alloc(0), Buffer.from('apk-bulut'), 44));
  const c = crypto.createCipheriv('aes-256-gcm', km.subarray(0, 32), km.subarray(32));
  const sifreli = Buffer.concat([c.update(metin, 'utf8'), c.final(), c.getAuthTag()]);
  return b64u(Buffer.concat([tekPub, sifreli]));
}

module.exports = { muhurle };

if (require.main === module) {
  let girdi = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (p) => { girdi += p; });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(muhurle(process.argv[2] || '', girdi));
    } catch (e) {
      console.error('muhurle: ' + e.message);
      process.exit(1);
    }
  });
}
