#!/usr/bin/env bash
# Tünelin önüne erişim kapısı (Caddy).
# Yalnızca /k/<sır>/ ile başlayan istekler geçer; önek kırpılıp ws-scrcpy-web'e aktarılır.
# Akış başlatma sitesinin (github.io) içinden gömülü açıldığı için tarayıcı bu sunucuya ne
# çerez ne de uygun Origin gönderir; kapı, uygulamanın beklediği Host/Origin'i ve oturum
# çerezini kendisi ekler. Sır 128 bit rastgeledir; bilmeyen her istek 403 alır.
# /k/<sır>/_ctl/ altı, yön ve tuş isteklerini kontrol sunucusuna (127.0.0.1:8001) yollar.
# Kullanım: kapi.sh <arka_port>   (sır: /tmp/oturum/sir, uygulama jetonu: /tmp/oturum/wsw_token)
set -euo pipefail
arka="$1"
sir="$(cat /tmp/oturum/sir)"
jeton="$(cat /tmp/oturum/wsw_token)"
CADDY_VER="2.11.4"

if [ ! -x /tmp/caddy ]; then
  curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_amd64.tar.gz" \
    | tar -xz -C /tmp caddy
fi

umask 077
cat > /tmp/oturum/Caddyfile <<EOF
{
	admin off
	auto_https off
	log default {
		output file /tmp/oturum/caddy.log
	}
}

:8080 {
	handle_path /k/${sir}/* {
		header Access-Control-Allow-Origin "*"
		# Başlatma sayfamız (github.io) akışı iframe ile gömebilsin: uygulamanın
		# çerçevelemeyi kısıtlayan başlıklarını kaldır. Erişim zaten gizli yol ile korunuyor.
		header -X-Frame-Options
		header -Content-Security-Policy
		handle_path /_ctl/* {
			reverse_proxy 127.0.0.1:8001
		}
		handle {
			reverse_proxy 127.0.0.1:${arka} {
				header_up Host 127.0.0.1
				header_up Origin http://127.0.0.1
				header_up Cookie "ws_scrcpy_token=${jeton}"
				flush_interval -1
			}
		}
	}

	handle {
		respond "Yetkisiz" 403
	}
}
EOF

/tmp/caddy validate --config /tmp/oturum/Caddyfile --adapter caddyfile > /tmp/oturum/caddy-validate.log 2>&1 \
  || { echo "::error::Caddy yapılandırması geçersiz"; tail -20 /tmp/oturum/caddy-validate.log; exit 1; }
nohup /tmp/caddy run --config /tmp/oturum/Caddyfile --adapter caddyfile > /tmp/oturum/caddy-run.log 2>&1 &

for i in $(seq 1 50); do
  kod=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ || true)
  [ "$kod" = "403" ] && exit 0
  sleep 0.2
done
echo "::error::Erişim kapısı açılmadı"
exit 1
