#!/usr/bin/env bash
# Builds LiquidTube.apk without Gradle.
# Needs: JDK 17, Android SDK build-tools 34.0.0, platform android-34, zip, keytool.
set -euo pipefail

: "${JAVA_HOME:?set JAVA_HOME to a JDK 17}"
: "${ANDROID_HOME:?set ANDROID_HOME to your Android SDK}"
export PATH="$JAVA_HOME/bin:$PATH"

BT="$ANDROID_HOME/build-tools/34.0.0"
PLATFORM="$ANDROID_HOME/platforms/android-34/android.jar"
APP="$(cd "$(dirname "$0")" && pwd)/app"
OUT="$(pwd)/build"
KS="${KS:-$HOME/.liquidtube/liquidtube.jks}"
KSPASS="${KSPASS:-liquidtube}"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "== 1/6 compiling resources"
"$BT/aapt2" compile --dir "$APP/res" -o "$OUT/res.zip"

echo "== 2/6 linking manifest, resources and assets"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLATFORM" \
  --manifest "$APP/AndroidManifest.xml" \
  -R "$OUT/res.zip" \
  --java "$OUT/gen" \
  -A "$APP/assets" \
  --min-sdk-version 21 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name 1.0 \
  --auto-add-overlay

echo "== 3/6 compiling java"
find "$APP/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
javac --release 8 -nowarn -classpath "$PLATFORM" -d "$OUT/classes" @"$OUT/sources.txt"

echo "== 4/6 dexing"
find "$OUT/classes" -name '*.class' > "$OUT/classes.txt"
"$BT/d8" --lib "$PLATFORM" --min-api 21 --release --output "$OUT/dex" @"$OUT/classes.txt"

echo "== 5/6 packaging"
cp "$OUT/base.apk" "$OUT/unaligned.apk"
( cd "$OUT/dex" && zip -q -X ../unaligned.apk classes.dex )
"$BT/zipalign" -f -p 4 "$OUT/unaligned.apk" "$OUT/aligned.apk"

echo "== 6/6 signing"
mkdir -p "$(dirname "$KS")"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v -keystore "$KS" -alias liquidtube \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=LiquidTube, OU=Apps, O=LiquidTube, L=India, C=IN" > /dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-key-alias liquidtube \
  --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$(dirname "$OUT")/LiquidTube.apk" "$OUT/aligned.apk"

echo "== done: $(dirname "$OUT")/LiquidTube.apk"
