#!/usr/bin/env bash
# Android ekranını sanal X ekranında (:1) gösterir; kapanırsa yeniden açar.
# Gerekli ortam değişkenleri: SCR_DIR, ADB, SERIAL, EKRAN_W, EKRAN_H
export DISPLAY=:1
export SCRCPY_SERVER_PATH="$SCR_DIR/scrcpy-server"

while true; do
  "$SCR_DIR/scrcpy" -s "$SERIAL" \
    --no-audio \
    --render-driver=software \
    --max-fps=30 \
    --video-bit-rate=4M \
    --prefer-text \
    --no-mouse-hover \
    --window-borderless \
    --window-x=0 --window-y=0 \
    --window-width="$EKRAN_W" --window-height="$EKRAN_H"
  echo "scrcpy kapandı, 2 sn sonra yeniden açılıyor"
  sleep 2
done
