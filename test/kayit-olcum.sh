#!/usr/bin/env bash
# Oyun kaydı sisteminin gerçek Android'deki testi (Telegram yerine sahte sunucu).
# F-Droid kurulur, verisine işaretler konur → kaydet → uygulama silinir → geri yükle → işaretler,
# sahiplik, SELinux etiketi ve uygulamanın açılması kontrol edilir.
set -uo pipefail
ADB="$ANDROID_HOME/platform-tools/adb"
a() { "$ADB" -s emulator-5554 "$@"; }
kok() { a shell su 0 sh -c "\"$1\"" | tr -d '\r'; }
not() { echo "::notice title=kayıt · $1::$2"; }
hata=0
kontrol() { if [ "$2" = 1 ]; then not "$1" "GEÇTİ · $3"; else not "$1" "KALDI · $3"; hata=1; fi; }
P=org.fdroid.fdroid
JETON="1234567:$(openssl rand -hex 20)"
SOHBET=4242
ANAHTAR=$(openssl rand -base64 32)
K=http://127.0.0.1:8001/kayit

not "su" "$(a shell su 0 id 2>&1 | tr -d '\r' | head -c 100)"
not "toybox tar" "$(a shell tar --help 2>&1 | tr -d '\r' | grep -m1 -i -- '-T' | head -c 100)"

# --- Uygulama + işaretler ---
curl -fsSL --retry 3 -o /tmp/fdroid.apk https://f-droid.org/F-Droid.apk
a install -r -g /tmp/fdroid.apk > /dev/null
a shell monkey -p $P -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 15
a shell am force-stop $P
U=$(kok "stat -c %u /data/data/$P")
kok "mkdir -p /data/data/$P/files/alt; echo ic-$RANDOM > /data/data/$P/files/alt/isaret.txt; chown -R $U:$U /data/data/$P/files; restorecon -R /data/data/$P/files"
IC=$(kok "cat /data/data/$P/files/alt/isaret.txt")
# Dış veri: klasörü Android'in kendisi yaratsın (FUSE üzerinden), sahipliği ona bırak
a shell mkdir -p /sdcard/Android/data/$P/files
a shell "echo dis-isaret > /sdcard/Android/data/$P/files/dis.txt"
E=/data/media/0/Android/data/$P
not "dış klasör (Android'in yarattığı)" "$(kok "ls -lnZd $E $E/files $E/files/dis.txt" | tr '\n' ' ' | head -c 400)"
not "iç klasör" "$(kok "ls -lnZd /data/data/$P /data/data/$P/files/alt/isaret.txt /data/data/$P/cache" | tr '\n' ' ' | head -c 400)"
DIS_ONCE=$(kok "stat -c '%u:%g %a' $E/files/dis.txt")
IC_ETIKET=$(kok "ls -Zd /data/data/$P" | cut -d' ' -f1)

# --- Kontrol sunucusu + sahte Telegram ---
JETON=$JETON SOHBET=$SOHBET PORT=8099 nohup node test/sahte-telegram.js > /tmp/tg.log 2>&1 &
ADB="$ADB" SERIAL=emulator-5554 TG_API=http://127.0.0.1:8099 nohup node scripts/kontrol.js > /tmp/kontrol.log 2>&1 &
sleep 2
curl -s -X POST -H 'Content-Type: text/plain' --data "{\"bot\":\"$JETON\",\"sohbet\":\"$SOHBET\",\"anahtar\":\"$ANAHTAR\"}" $K/ayarla > /dev/null
R=$(curl -s -m 600 "$K/yukle?bekle=1" | jq -c .sonuc)
kontrol "ilk oturum (kayıt yok)" "$(echo "$R" | grep -c 'Kayıt yok')" "$R"
T0=$(date +%s)
R=$(curl -s -m 900 "$K/kaydet?bekle=1" | jq -c .sonuc)
kontrol "kaydet" "$(echo "$R" | grep -c '"basari":true')" "$R · $(( $(date +%s) - T0 )) sn"
R=$(curl -s -m 900 "$K/kaydet?bekle=1" | jq -c .sonuc)
kontrol "hemen tekrar kaydet" "$(echo "$R" | grep -c 'Değişiklik yok')" "$R"

# --- Yeni oturum gibi: uygulama ve verisi silinir ---
a shell pm uninstall $P > /dev/null
kontrol "silindi" "$( [ -z "$(a shell pm list packages $P | tr -d '\r')" ] && [ -z "$(kok "ls -d $E 2>/dev/null")" ] && echo 1 || echo 0)" "paket ve dış klasör yok"
T0=$(date +%s)
R=$(curl -s -m 900 "$K/yukle?tekrar=1&bekle=1" | jq -c .sonuc)
kontrol "geri yükle" "$(echo "$R" | grep -c '"basari":true')" "$R · $(( $(date +%s) - T0 )) sn"
U2=$(kok "stat -c %u /data/data/$P")
IC2=$(kok "cat /data/data/$P/files/alt/isaret.txt")
kontrol "iç veri" "$( [ "$IC2" = "$IC" ] && echo 1 || echo 0)" "işaret '$IC2' (beklenen '$IC'), uid $U → $U2"
kontrol "iç sahiplik" "$( [ "$(kok "stat -c %u:%g /data/data/$P/files/alt/isaret.txt")" = "$U2:$U2" ] && echo 1 || echo 0)" "$(kok "stat -c %u:%g /data/data/$P/files/alt/isaret.txt")"
ET2=$(kok "ls -Z /data/data/$P/files/alt/isaret.txt" | cut -d' ' -f1)
KAT=$(kok "ls -Zd /data/data/$P" | cut -d' ' -f1 | sed 's/.*:s0//')
kontrol "iç SELinux" "$(echo "$ET2" | grep -c "app_data_file:s0$KAT\$")" "$ET2 (klasör kategorisi $KAT)"
kontrol "dış veri" "$( [ "$(kok "cat $E/files/dis.txt")" = "dis-isaret" ] && echo 1 || echo 0)" "$(kok "ls -lnZ $E/files/dis.txt" | head -c 200)"
kontrol "dış sahiplik" "$( [ "$(kok "stat -c '%u:%g %a' $E/files/dis.txt")" = "$(echo "$DIS_ONCE" | sed "s/^$U:/$U2:/")" ] && echo 1 || echo 0)" "önce $DIS_ONCE, sonra $(kok "stat -c '%u:%g %a' $E/files/dis.txt")"
a logcat -c
a shell monkey -p $P -c android.intent.category.LAUNCHER 1 > /dev/null 2>&1
sleep 10
PID=$(a shell pidof $P | tr -d '\r')
COKME=$(a logcat -d | grep -c "FATAL EXCEPTION" || true)
kontrol "uygulama açılıyor" "$( [ -n "$PID" ] && [ "$COKME" = 0 ] && echo 1 || echo 0)" "pid '$PID', çökme $COKME"
a shell am force-stop $P

# --- Farklı uid'den gelen kayıt (başka kurulum) ---
a push test/uid-cevir.sh /data/local/tmp/uid-cevir.sh > /dev/null
C=$(a shell su 0 sh /data/local/tmp/uid-cevir.sh $P | tr -d '\r')
kontrol "uid çevirisi" "$(echo "$C" | grep -c "kalan=0 icerik=$IC ")" "$C"

not "kontrol günlüğü" "$(grep -v '^$' /tmp/kontrol.log | tail -4 | tr '\n' ' ' | head -c 400)"
not "telegram" "$(tail -1 /tmp/tg.log | head -c 300)"
exit $hata
