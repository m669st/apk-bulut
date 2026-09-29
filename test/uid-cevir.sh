# Android içinde (su 0): başka bir kurulumdan (farklı uid) gelmiş kaydı taklit eder ve geri yükler.
# Arşivdeki her şey eski uid'e (gerçek uid + 7) çevrilir; geri yükleme sonrası hiçbir dosya eski uid'de kalmamalı.
P="$1"
K=/data/local/tmp/kb/$P
T=/data/local/tmp/uidtest
B=/data/local/tmp/kayit-cihaz.sh
U=$(stat -c %u /data/data/$P)
ESKI=$((U + 7))
sh $B yedekle "$P" > /dev/null || { echo "yedek-hata"; exit 1; }
for tur in veri dis; do
  [ -f "$K/$tur.tar" ] || continue
  rm -rf $T; mkdir -p $T; cd $T || exit 1
  tar -xf "$K/$tur.tar"
  find data | while read -r f; do
    g=$(stat -c %g "$f"); [ "$g" = "$U" ] && g=$ESKI
    chown -h "$ESKI:$g" "$f"
  done
  tar -cf "$K/$tur.tar" data
  cd /
done
rm -rf $T
sed -i "s/^ic .*/ic $ESKI/; s/^dis $U /dis $ESKI /" "$K/sahip"
echo bozuk > /data/data/$P/files/alt/isaret.txt
sh $B geriyukle "$P" > /dev/null || { echo "geri-hata"; exit 2; }
kalan=$(find /data/data/$P /data/media/0/Android/data/$P 2>/dev/null | while read -r f; do stat -c %u "$f"; done | grep -c "^$ESKI\$")
echo "U=$U eski=$ESKI kalan=$kalan icerik=$(cat /data/data/$P/files/alt/isaret.txt) sahip=$(stat -c %u:%g /data/data/$P/files/alt/isaret.txt) etiket=$(ls -Z /data/data/$P/files/alt/isaret.txt | cut -d' ' -f1)"
