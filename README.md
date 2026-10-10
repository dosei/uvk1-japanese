# UVK1-RxJa: UV-K1 受信専用・日本語化ファームウェア（F4HWN ベース）

> [!NOTE]
> **AI の利用について**: このリポジトリのうち、F4HWN から変更した部分（受信専用化・日本語化。`App/ui/ja.c`、`tools/ja/` 以下、各所の `ENABLE_RX_ONLY` / `ENABLE_JAPANESE` の変更など）のコードと説明文は、AI（Anthropic の Claude Code）を使って作成しました。仕様・方針・訳語は作者が決めています。元の F4HWN の部分には手を加えておらず、この派生版で AI を使ったのは変更部分だけです。どこが変更部分かはコミット履歴で確認できます。

Quansheng UV-K1 / UV-K5 V3（PY32F071）用の [F4HWN Fusion ファームウェア](https://github.com/armel/uv-k1-k5v3-firmware-custom) をもとにした派生版 UVK1-RxJa（以下 RxJa）です。次の 2 点を加えています。

- **受信専用**: 送信できないようにしてあります（下記）。
- **日本語表示**: メニュー名・カテゴリ名、メニュー右列の選択肢、起動画面、キーロック・電池切れ・周波数/トーン検索・FM ラジオ・受信ログのメッセージを日本語で表示します（OFF/ON・数字・単位・略語は英語のまま）。チャンネル名にも日本語が使えます（Shift_JIS、全角 5 文字・半角 10 文字まで。v1.1.0 から）。漢字・かな・半角カナのフォントは本体の外付け SPI フラッシュに置くので、本体側の容量はほとんど使いません。

使い方（書き込み方、キー操作、メニュー全項目の説明など）は **[説明書のページ](https://dosei.github.io/uvk1-japanese/)** にまとめています（原稿は [`manual/`](manual/)。前の Wiki から移しました）。ファームの書き込みはブラウザだけでできる [RxJa Tools](https://dosei.github.io/uvk1-japanese/tools/) が簡単です。

ビルドは `RxJa` プリセットです。ほかのプリセット（Fusion など）は元の F4HWN と同じ動きです。

画面に出る名前と版は RxJa 自身のもの（起動画面・本体情報の「UVK1-RxJa v1.2.0」、マルチブートの「UVK1-RxJa MULTIBOOT」、本体情報の QR コードはこのリポジトリと Wiki）で、もとにした F4HWN の版は「F4HWN v6.1.0 ベース」として添えています。パソコンのツールが UART で読む版の文字列は「F4HWN v6.1.0」のままです（UV Studio などがこれを見て動きを変えるため）。

> [!WARNING]
> v1.2.0 は、作者の実機（UV-K1）で、RxJa Tools での書き込み（日本語データの自動書き込みまで）、起動と日本語表示、受信、FM ラジオやスペクトラムなどの動作、日本語のチャンネル名を確かめています。それでも書き込みは自己責任でお願いします。最悪の場合は無線機が起動しなくなります。書き込んだら、まず [UV Studio](https://armel.github.io/uvstudio/#dump-calib) で校正データをバックアップしてください。

> [!IMPORTANT]
> 技適のない無線機から電波を出すのは電波法違反です。このファームは送信を止めますが、無線機が技適を取ったことにはなりません。受信だけで使ってください。

## 送信の止め方（`ENABLE_RX_ONLY`）

- 送信状態への切り替えを入口で拒否します（`App/functions.c`）。
- PTT を押すと「送信禁止」（日本語データを入れる前は「TX DISABLE」）を表示してビープを鳴らし、送信の準備・設定・終了処理を行いません（`App/radio.c` の `RADIO_PrepareTX` / `RADIO_SetTxParameters` / `RADIO_SendEndOfTransmission`）。
- 無線チップ BK4819 のレジスタ書き込みで、パワーアンプを有効にするビットとバイアスを常に 0 にし、PA 有効化の GPIO も立てません（`App/driver/bk4829.c`）。通常の送信のほか、フォックスハント、追加アプリ、UART からのレジスタ書き込みも最後はここを通るので、どの経路でもここで止まります。
- 送信用のメニュー（出力、CTCSS/DCS 送信、VOX、ロジャー音、RP STE など）とサイドキーの送信機能を隠しています。

## ビルド済みファイル

自分でビルドしなくても、[Releases](https://github.com/dosei/uvk1-japanese/releases) に最新のビルド済みファイルを置いています。

- `f4hwn.rxja.bin`: ファーム本体
- `ja_res.bin`: 日本語データ

ファームと日本語データは同じリリースのものを組にして使ってください。ふつうは下の RxJa Tools を使えば、ファイルをダウンロードしなくても両方をまとめて書き込めます。

## ブラウザで書き込む（UVK1-RxJa Tools）

[UVK1-RxJa Tools](https://dosei.github.io/uvk1-japanese/tools/)（以下 RxJa Tools）は、F4HWN の作者による [UV Studio](https://armel.github.io/uvstudio/) をもとに RxJa 用に手を入れたページです（ソースは `web/`、変更点は `web/NOTICE.txt`）。パソコン版の Chrome か Edge で開きます（Web Serial を使うので Firefox と Safari、スマートフォンでは動きません）。

- **ファーム書き込み**: 一覧から RxJa の版を選び、無線機を DFU モード（PTT を押したまま電源を入れる）にして書き込みます。書き終わると、同じ版の日本語データを続けて自動で書き込みます。
- **日本語データ**: ファームはそのままで、日本語データだけを書き直すページです。訳語を直したときや、自分で作った `ja_res.bin` を入れるときに使います。
- **メモリーチャンネル**: 本体のチャンネル（1〜1024）を読み込み、表で編集して書き込みます。日本語の名前、CHIRP 互換の CSV、同梱の「日本(関西中心)のよくある周波数」（299 件）に対応しています（→ [説明書](https://dosei.github.io/uvk1-japanese/docs/メモリーチャンネル.html)）。
- ほかに、ライブビューア、RF ログ、校正データの保存・復元も UV Studio と同じように使えます。

ページには各リリースの `f4hwn.rxja.bin` と `ja_res.bin` が同梱されています（GitHub の Releases のファイルはブラウザから直接読めないため）。`.github/workflows/pages.yml` が `rxja-v` で始まるリリースをすべて取り込み、`SHA256SUMS` で照合してから GitHub Pages に公開します。新しいリリースを公開すると自動で作り直されます。反映されないときは `gh workflow run pages.yml -R dosei/uvk1-japanese` で手動で作り直せます。

## ビルド

Docker がある場合:

```bash
./compile-firmware.sh RxJa
```

ARM GCC（arm-none-eabi 13.3 で確認）と CMake を直接使う場合:

```bash
cmake --preset RxJa
cmake --build build/RxJa
```

`build/RxJa/f4hwn.rxja.bin` ができます。自分でビルドしたファームは、RxJa Tools（または元の [UV Studio](https://armel.github.io/uvstudio/#flash)）のファーム書き込みで「ローカルの .bin」を選んで書き込みます。この場合、日本語データは自動では書き込まれないので、RxJa Tools の日本語データのページか下のコマンドで入れてください。

## 日本語データの作成と転送

日本語のフォントと訳語はファームとは別のデータ（`ja_res.bin`、約 140KB）で、外付け SPI フラッシュの 0x122000〜0x14BFFF（F4HWN の Apps 領域と音声データの間の空き）に書き込みます。データを入れるまでは英語で表示されます。訳語を直したいときも、このデータを入れ直すだけで済み、ファームの書き直しは不要です。

> [!CAUTION]
> 2026-09-27 に試作版（旧 rxja-v0.1.0〜v0.2.1）を公開していましたが、取り下げて v0.1.0 からやり直しました。最初の試作版（2026-09-27 公開の旧 v0.1.0）は日本語データを 0x0C0000 に置いていて、そこは F4HWN のマルチブートの設定バンク 1〜4 でした（`App/driver/mb_flash.h`）。手元に試作版のファイルが残っていたら使わないでください。今の版とはデータの識別子・形式と転送コマンドの番号が違うので、混ぜて使っても転送が拒否されるか英語表示のままになり、0x0C0000 には書き込まれません。

いちばん簡単なのは [RxJa Tools](https://dosei.github.io/uvk1-japanese/tools/)（上記）です。RxJa のファームを書き込むと日本語データも続けて書き込まれます。日本語データだけを入れ直すときは、RxJa Tools の日本語データのページで、同梱の版か自分で作った `ja_res.bin` を選び、RxJa ファームで起動した状態でポートを選ぶと、書き込みと照合をします。

コマンドラインで書く場合:

```bash
python3 tools/ja/gen_ja_font.py                # tools/ja/ja_res.bin を作る（標準ライブラリのみ。Releases の ja_res.bin を使うなら不要）
pip install pyserial
python3 tools/ja/upload.py /dev/ttyUSB0        # Windows なら COM3 など。RxJa ファームで起動した状態で
python3 tools/ja/upload.py COM3 ja_res.bin     # ダウンロードした ja_res.bin を指定する場合
```

- 訳語は `tools/ja/strings_ja.tsv` です（英語の元の文字列<TAB>日本語）。左の列（メニュー名）は 48px、右の列（値）は 78px など、画面ごとの幅を `@width` で決めてあり、全角 1 文字 12px、半角英数 7px、半角カナ 6px です。はみ出す訳は `gen_ja_font.py` がエラーにします。
- 右の列の値は、OFF/ON・数字・単位・略語（FM/AM など）は英語のまま残し、言葉だけを訳しています。改行は `\n` と書き、同じ英語をメニューごとに訳し分けるときは `メニュー名|値` をキーにします。
- 転送は本体の UART コマンド（0x0744 書き込み / 0x0746 読み出し）で行い、最後に読み戻して照合します。先頭の識別子を最後に書くので、途中で切れても壊れたデータは使われず、英語表示に戻るだけです。
- `tools/ja/sim/` は表示をパソコン上で確かめるためのシミュレータです。

## まだできていないこと

- 本体のキーでのチャンネル名の日本語入力（日本語の名前は RxJa Tools の「メモリーチャンネル」で付けます）
- SDR で、実機から電波が出ていないことを測って確かめること

## ライセンスと出典

元のファームと同じく Apache License 2.0 です（`LICENSE`、`NOTICE`）。フォントは東雲フォント（12x12 は efont-unicode-bdf 経由、6x12 半角カナは shnm6x12r）で、どちらもパブリックドメインです。F4HWN からの変更は、このリポジトリのコミット履歴のとおりです。

---

# Stats

![Alt](https://repobeats.axiom.co/api/embed/ecdd86aa536b716f088339a0c5ee734558f78c28.svg "Repobeats analytics image")

# F4HWN firmware port for the UV-K1 and UV-K5 V3 using the PY32F071 MCU

This repository is a fork of the [F4HWN custom firmware](https://github.com/armel/uv-k5-firmware-custom), who was a fork of [Egzumer custom firmware](https://github.com/egzumer/uv-k5-firmware-custom). It extends the work done for the UV-K5 V1, based on the DP32G030 MCU, and adapts it to the newer UV-K1 and UV-K5 V3 built around the PY32F071 MCU. It is the result of the joint work of [@muzkr](https://github.com/muzkr) and [@armel](https://github.com/armel).

A big thanks to DualTachyon, who paved the way by releasing the very first open-source [firmware](https://github.com/DualTachyon/uv-k5-firmware) for the UV-K5 V1. None of this would have been possible without that initial work !

# A note for developers who intend to fork this project

This firmware is distributed under the Apache 2.0 License, carrying forward the original copyright of DualTachyon, whose work laid the foundation for the UV-K5 open-source ecosystem.
If you create a fork or a derived version, **we strongly encourage you to keep your work open source**.

Keeping your fork open:

- aligns with the intent and spirit of the Apache 2.0 License
- supports the amateur-radio and embedded-development community
- avoids unnecessary fragmentation
- allows others to study, audit and improve the firmware

It is also very much in line with the **ham spirit**: sharing knowledge, experimenting together and helping each other, rather than closing things off or claiming them as your own.

Maintaining an open-source fork is the best way to help build a healthy and sustainable ecosystem for everyone.

> [!WARNING]
> EN - THIS FIRMWARE HAS NO REAL BRAIN. PLEASE USE YOUR OWN. Use this firmware at your own risk (entirely). There is absolutely no guarantee that it will work in any way shape or form on your radio(s), it may even brick your radio(s), in which case, you'd need to buy another radio.
Anyway, have fun.
>
> _FR - CE FIRMWARE N'A PAS DE VÉRITABLE CERVEAU. VEUILLEZ UTILISER LE VÔTRE. Utilisez ce firmware à vos risques et périls. Il n'y a absolument aucune garantie qu'il fonctionnera d'une manière ou d'une autre sur votre (vos) radio(s), il peut même bousiller votre (vos) radio(s), dans ce cas, vous devrez acheter une autre radio. Quoi qu'il en soit, amusez-vous bien._

> [!NOTE]
> EN - About CHIRP, as with many other firmwares, you need to use a dedicated driver. The matching CHIRP driver is now bundled with each release of this repository, so you can download the firmware and its driver together from the [Releases page](https://github.com/armel/uv-k1-k5v3-firmware-custom/releases).
>
> _FR - A propos de CHIRP, comme pour beaucoup d'autres firmwares, vous devez utiliser un pilote dédié. Le driver CHIRP correspondant est désormais fourni avec chaque release de ce dépôt, ce qui permet de récupérer ensemble le firmware et son pilote depuis la page des [Releases](https://github.com/armel/uv-k1-k5v3-firmware-custom/releases)._

> [!CAUTION]
> EN - I recommend backing up your calibration data with [UV Studio](https://armel.github.io/uvstudio/#dump-calib) immediately after flashing this firmware. It is a good habit to adopt.
>
> _FR - Je recommande de sauvegarder vos données de calibration avec [UV Studio](https://armel.github.io/uvstudio/#dump-calib) juste après avoir flashé ce firmware. C'est un bon réflexe à adopter._

# Donations

Special thanks to Jean-Cyrille F6IWW (3 times), Fabrice 14RC123, David F4BPP (2 times), Olivier 14RC206, Frédéric F4ESO, Stéphane F5LGW (2 times), Jorge Ornelas (4 times), Laurent F4AXK, Christophe Morel, Clayton W0LED, Pierre Antoine F6FWB, Jean-Claude 14FRS3306, Thierry F4GVO, Eric F1NOU, PricelessToolkit, Ady M6NYJ, Tom McGovern (4 times), Joseph Roth, Pierre-Yves Colin, Frank DJ7FG, Marcel Testaz, Brian Frobisher, Yannick F4JFO, Paolo Bussola, Dirk DL8DF, Levente Szőke (2 times), Bernard-Michel Herrera, Jérôme Saintespes, Paul Davies, RS (3 times), Johan F4WAT, Robert Wörle, Rafael Sundorf, Paul Harker, Peter Fintl, Pascal F4ICR (2 times), Mike DL2MF (3 times), Eric KI1C / F4WFS (3 times), Phil G0ELM, Jérôme Lambert, Eliot Vedel, Alfonso EA7KDF, Jean-François F1EVM, Robert DC1RDB (2 times), Ian KE2CHJ, Daryl VK3AWA, Roberto Brunelli, Robert Boardman, Stephen Oliver, Nicolas F4INE, William Bruno, Daniel OK2VLK, Tayler Chew, Peter DL7RFP, Philippe Kopp, Rune LA6YMA, Jeremy Luna, Steef Wagenaar (2 times), Zhuo BG7SGA, Jamie M0JLB, Antoine LIBERT, Vince K0DKR, Julia DF7JA, Ken 2E0UMK, Victor TI2SYS, Tobi DG9LAY, Deaglan K4DFQ, Catherine PALMER, Brian WA6JFK, Stéphane Hintzy, Roger F1HCN, Marcin Kusaj, Flavio Cottarelli, Bob N1MLZ, Carlos EA1IJ, Brian M7YLF, Giuseppe IT9LLH, 邓 月, Jon M1JRH, Antonios Chouchoumis, Cédric Thomas and Justin White for their [donations](https://www.paypal.com/paypalme/F4HWN). That’s so kind of them. Thanks so much 🙏🏻

## Table of Contents

* [Main features and improvements from F4HWN](#main-features-and-improvements-from-f4hwn)
* [Main Features from Egzumer](#main-features-from-egzumer)
* [Manual](#manual)
* [Compiling and Building from Docker](#compiling-and-Building-from-docker)
* [Flashing the Firmware with UV Studio](#flashing-the-firmware-with-uv-studio)
* [Credits](#credits)
* [Other sources of information](#other-sources-of-information)
* [License](#license)

## Main features and improvements from F4HWN

### Fusion edition

Fusion is the generic reference edition for the UV-K1 and UV-K5 V3. It is intended
for everyday use and is the base inherited by the specialized editions. It includes:

- Fagci's spectrum analyzer,
- broadcast FM radio and VOX,
- [UV Studio](https://armel.github.io/uvstudio/) with integrated K5Viewer screen mirroring, screenshots and remote keyboard control,
- advanced RX audio profiles and Audio Scope,
- automatic RX/TX activity logging with RF Log,
- Full Watch across VFO A, VFO B and up to two priority channels,
- Multiboot with one protected Main backup and four user firmware slots,
- independent Multiconfig banks, switchable at runtime through `SetCfg`.

Specialized presets extend Fusion for specific uses:

- **Transfer** adds AirCopy and BEAM wireless channel transfer.
- **FieldOps** adds first-responder controls, Fox Hunt and Morse Beacon support.
- **Labs** is the experimental edition. It carries the broad feature selection of the
  other releases and adds the overlay-apps platform (apps loaded from external Flash and
  run in a 4 KiB RAM overlay) — the newest, least-settled work. Expect rough edges. It is
  not a strict superset of every other edition: features may be exchanged between releases
  to preserve stability and memory headroom.
- **Custom** remains a manually configured build based directly on the hidden technical default.

### Multiboot and Multiconfig

Multiboot uses the radio's external Flash to keep one automatically maintained
**Main** firmware backup and four additional firmware slots. Each image is
validated before it is restored to internal Flash, and the selector displays
the edition and version stored in every valid slot.

To open the Multiboot selector, power off the radio, hold `MENU`, power it on,
then release the key when the selector appears. Use `UP` and `DOWN` to choose a
slot, `MENU` to restore it and `EXIT` to leave without making changes.

> [!CAUTION]
> Never power off the radio while a firmware slot is being restored.

Multiconfig provides one independent configuration bank for Main and for each
of the four user slots. A bank contains the memory channels and names, VFO
settings, scan lists, radio settings and edition-specific settings. By default,
each firmware slot uses the bank with the same number.

The `SetCfg` menu can select and apply another bank immediately, without
restarting the radio or changing firmware. The status bar shows the active bank
as `CFG M` or `CFG 1` to `CFG 4`, so several operating configurations can be
used with the same firmware and compatible configurations can be shared across
editions.

### Full Watch

Full Watch extends the normal dual-watch cycle to monitor:

- VFO A,
- VFO B,
- priority channel 1,
- priority channel 2.

The priority channels come from the existing scan-list priority settings.
Duplicates, invalid entries and channels already loaded in VFO A or B are
ignored automatically.

The `RxMode` menu provides two Full Watch modes:

- `FULL RX / RESPOND` replies on the channel that opened the squelch,
- `MAIN TX / FULL RX` always transmits on the selected main VFO.

Animated chevrons show the background watch cycle while the normal VFO display
remains available for navigation and operation.

### Overlay applications and APRS

Labs can store up to 16 applications from the current collection of 18 in
external Flash. Each app is loaded into a dedicated 4 KiB RAM overlay only
while it is running, while larger read-only assets such as text, fonts, bitmaps
and lookup tables remain in external Flash.

The current app collection includes:

- radio tools: Broadcast FM, Fox Hunt, Beacon, Beam and Spectrum3D,
- digital and signal apps: APRS RX, APRS TX, SSTV and EPIRB 406,
- diagnostics: System Info,
- games and demos: Breakout, Cube3D, Minesweeper, Plasma, Rapid Roll, Snake,
  Space Impact and Tetris.

APRS RX receives AX.25 UI frames using Bell 202 AFSK at 1200 baud, displays
common position formats and Mic-E data, and keeps a five-frame history. APRS TX
provides an on-radio editor for the source callsign and SSID, digipeater path,
position, symbol and comment before transmitting a position beacon.

> [!IMPORTANT]
> Overlay apps, including APRS RX and APRS TX, are experimental and intended for
> Labs. Use the app files supplied with the same firmware release so their ABI
> and required capabilities match the installed firmware.

> [!CAUTION]
> Transmitting apps must only be used on frequencies, power levels and modes
> permitted by your licence and local regulations.

### Radio and signal handling

- Reworked output-power levels:
  - `Low 1`: below approximately 20 mW,
  - `Low 2`: approximately 125 mW,
  - `Low 3`: approximately 250 mW,
  - `Low 4`: approximately 500 mW,
  - `Low 5`: approximately 1 W,
  - `Mid`: approximately 2 W,
  - `High`: approximately 5 W,
  - `User`: configurable through `SetPwr`.
- S-meter calibrated according to the [IARU Region 1 recommendation for VHF/UHF](https://hamwaves.com/decibel/en/):
  - fixed S0 to S9+ values replace the former EEPROM S-meter thresholds,
  - Classic and Tiny display styles are available.
- Configurable 12.5 kHz or 6.25 kHz narrow-FM bandwidth.
- Per-channel TX lock.
- Adjustable RX audio volume.
- Advanced RX audio profiles for FM and AM reception.
- Regional frequency-lock profiles for amateur bands, PMR446, FRS, GMRS and MURS.
- Support for 1600, 2200 and 3500 mAh battery profiles.

### Spectrum analyzer

- Channel names displayed in the spectrum view.
- Persistent spectrum settings.
- Faster and smoother spectrum rendering.
- Improved behavior when freezing the spectrum or disconnecting USB-C.
- Spectrum analyzer state can be restored automatically at startup.

### Scanning

- Support for up to 24 named scan lists + 1 mixed list.
- Each memory channel can be assigned to:
  - `OFF`,
  - one scan list from `01` to `24`,
  - `ALL`.
- The `ALL` list scans every channel except those assigned to `OFF`.
- The `MIX` list combines any selected subset of the 24 named lists into one
  scan set.
- Automatic selection of the next valid list when the requested list is empty.
- Direct scan-list selection while scanning:
  - `00` selects `ALL`,
  - `01` to `24` select the corresponding list,
  - `25` selects `MIX`.
- Long press on `MENU` while scanning to exclude the current memory channel.
- Up to 64 frequency exclusions.
- Very fast scanning mode, reaching approximately 150 frequencies per second.
- Scan progress, RSSI and detected CTCSS/DCS information.
- Configurable scan resume behavior.
- Scan state can be restored automatically at startup.

### User interface

- Improved VFO screen with:
  - Classic and Tiny S-meter styles,
  - Classic and Tiny frequency-information layouts,
  - `MAIN ONLY`, `DUAL`, `FULL` and `CROSS` display modes,
  - RX activity indication on the active VFO,
  - optional RX LED blinking,
  - squelch, monitor, step and CTCSS/DCS information,
  - last-RX indication,
  - RX and TX timers.
- Improved status bar with updated fonts and icons.
- Menu index remains visible while editing an entry.
- Improved frequency and memory-channel input.
- Improved audio-level display.
- AirCopy progress percentage and gauge.
- Smooth backlight fading.
- Manual backlight controls for quickly switching between minimum and maximum brightness.
- Configurable contrast and inverted-display mode.
- Configurable navigation layout for the different radio models.
- Improved power-on message and optional startup logo.
- System-information pages for:
  - firmware version and build information,
  - battery information,
  - Flash and SRAM usage,
  - project and documentation QR codes.

### Audio and transmission controls

- Classic and OnePush PTT modes.
- Configurable timeout-timer alerts:
  - disabled,
  - sound,
  - visual,
  - sound and visual.
- Configurable end-of-transmission alerts using the same modes.
- Audio Scope during RX and TX.
- Improved Audio Scope behavior with OnePush PTT, DTMF and the 1750 Hz tone.
- Configurable automatic deep-sleep timeout.
- Quick actions for:
  - RX mode,
  - main-VFO-only display,
  - PTT,
  - wide/narrow bandwidth,
  - 1750 Hz tone,
  - mute,
  - RX audio profile,
  - maximum power,
  - offset removal.

### Fox Hunt and Beacon

- Dedicated Fox Hunt receiver with:
  - calibrated S-meter display,
  - scrolling signal-history graph,
  - peak, minimum and trend indicators,
  - selectable RF attenuation,
  - silent, Geiger-style and received-audio modes,
  - long-press `F` keypad lock (attenuation stays adjustable with the arrow keys).
- Independent Morse Beacon transmitter with:
  - `MOE`, `MOI`, `MOS`, `MOH`, `MO5` and `MO` identifiers,
  - optional callsign identification,
  - configurable TX and idle periods,
  - live TX and idle countdowns,
  - persisted Beacon settings,
  - interactive control during transmission,
  - shared long-press `F` keypad lock,
  - TX-lock, modulation and battery-safety checks.
- Fox Hunt and Beacon screens are mirrored to UV Studio's integrated K5Viewer.

### RF Log

- Automatic logging of RX and TX activity when RF Log is enabled.
- Logs stored in the radio's external Flash memory.
- Recorded information includes:
  - RX or TX direction,
  - frequency and channel,
  - channel name,
  - activity duration,
  - S-meter level,
  - battery voltage.
- On-radio history with RX/TX filtering and detailed views.
- Live RF Log dashboard and history access through UV Studio.

### Connectivity and data transfer

- Live screen streaming to [UV Studio](https://armel.github.io/uvstudio/) over a USB serial connection.
- Screenshot capture and download.
- Remote keyboard control through the integrated K5Viewer.
- Automatic reconnection after a USB disconnect.
- RF Log monitoring, analytics and CSV export.
- Firmware flashing, calibration backup and restore, and boot-logo management from the same interface.
- BEAM transfer of complete channel settings between compatible radios.

#### AirCopy (Transfer edition)

AirCopy can transfer one 128-channel bank, the radio settings, or all memory
banks and settings in one operation. Version 6.1 adds a stop-and-wait protocol
with acknowledgements in both directions:

- the receiver acknowledges CRC32 comparison frames and every stored data frame,
- a missing acknowledgement automatically triggers a retry, up to three times,
- invalid, out-of-sequence or mismatched selections are rejected instead of
  being applied silently,
- the progress screen reports retries or receive errors and distinguishes
  blocks that were already identical from blocks that were copied.

Before sending data, the two radios compare CRC32 values in groups of up to 24
blocks. The receiver returns a difference bitmap, so only blocks whose contents
differ are transmitted. Each radio data frame can carry up to three consecutive
64-byte blocks, approximately doubling over-the-air throughput compared with
the previous one-block framing.

Transfer also supports direct radio-to-radio cable cloning over UART at 460800
baud. Press `*` in AirCopy to switch between `AIR COPY` and `CABLE COPY`; use
`UP` and `DOWN` to select a memory bank, `Settings` or `All (Mem+Set)`, then
`MENU` on the sender and `EXIT` on the receiver.

Cable mode additionally provides `Flash 2M`, which clones the complete 2 MiB
external Flash. Sectors are compared by CRC32 and only different sectors are
written. The device-specific calibration sector is never copied or erased, and
the receiving radio must be restarted after a successful Flash clone.

> [!IMPORTANT]
> The new AirCopy wire format is not compatible with earlier versions. Both
> radios must run the same firmware version.

### Settings and controls

- New or extended menu entries:
  - `SetPwr`: configurable User output power,
  - `SetPTT`: Classic or OnePush PTT,
  - `SetTOT`: timeout-timer alert,
  - `SetEOT`: end-of-transmission alert,
  - `SetCtr`: display contrast,
  - `SetInv`: inverted display,
  - `SetLck`: keypad or keypad-and-PTT lock,
  - `SetMet`: S-meter style,
  - `SetGUI`: VFO information style,
  - `SetRxA`: RX audio profile,
  - `SetTmr`: RX and TX timers,
  - `SetOff`: automatic deep-sleep delay,
  - `SetNFM`: narrow-FM bandwidth,
  - `SetVol`: RX audio volume,
  - `SetScn`: scan mode,
  - `SetNav`: radio-specific navigation layout,
  - `SetCfg`: apply another Multiconfig bank without restarting.
- Improved `PonMsg`, `BackLt`, `TxTOut`, `ScnRev` and `KeyLck` menus.
- Full VFO state restoration with a long press on `EXIT`.
- Squelch changes made with `F + UP` or `F + DOWN` are persisted.

### Keyboard shortcuts and assignable actions

- `F + UP` or `F + DOWN`: adjust the squelch level.
- `F + F1` or `F + F2`: adjust the frequency step.
- `F + 8`: temporarily switch the backlight between minimum and maximum brightness.
- `F + 9`: return to the configured backlight strategy.
- Configurable short- and long-press actions include:
  - RX mode,
  - main-VFO-only display,
  - virtual PTT,
  - wide/narrow bandwidth,
  - 1750 Hz tone,
  - mute,
  - RX audio profile,
  - maximum power,
  - offset removal,
  - BEAM,
  - RF Log,
  - Fox Hunt,
  - Beacon.

### Reliability and optimization

- Improved squelch and S-meter behavior.
- Fixed DTMF overlay issues.
- Fixed scan-range limits.
- Cleaner startup display.
- Removed PWM-related audio noise.
- Improved serial and K5Viewer key handling.
- Improved VFO persistence and restoration.
- Extensive code refactoring and memory optimization.
- DTMF calling and the scrambler remain disabled in Fusion.
- Legacy AM Fix support has been removed.

## Main features from Egzumer:
* many of OneOfEleven mods:
   * long press buttons functions replicating F+ action
   * fast scanning
   * channel name editing in the menu
   * channel name + frequency display option
   * shortcut for scan-list assignment (long press `5 NOAA`)
   * scan-list toggle (long press `* Scan` while scanning)
   * configurable button function selectable from menu
   * battery percentage/voltage on status bar, selectable from menu
   * longer backlight times
   * mic bar
   * RSSI s-meter
   * more frequency steps
   * squelch more sensitive
* fagci spectrum analyzer (**F+5** to turn on)
* some other mods introduced by me:
   * SSB demodulation (adopted from fagci)
   * backlight dimming
   * battery voltage calibration from menu
   * better battery percentage calculation, selectable for 1600mAh or 2200mAh
   * more configurable button functions
   * long press MENU as another configurable button
   * better DCS/CTCSS scanning in the menu (`* SCAN` while in RX DCS/CTCSS menu item)
   * Piotr022 style s-meter
   * restore initial freq/channel when scanning stopped with EXIT, remember last found transmission with MENU button
   * reordered and renamed menu entries
   * LCD interference crash fix
   * many others...

 ## Manual

Up to date manual is available in the [Wiki section](https://github.com/armel/uv-k1-k5v3-firmware-custom/wiki)

## Radio performance

Please note that the Quansheng UV-Kx radios are not professional quality transceivers, their
performance is strictly limited. The RX front end has no track-tuned band pass filtering
at all, and so are wide band/wide open to any and all signals over a large frequency range.

Using the radio in high intensity RF environments will most likely make reception difficult,
especially in AM mode. The receiver simply does not have a great dynamic range, so stronger
signals can easily cause distortion, desensitization and poor AM audio.
This is fundamentally a hardware limitation: firmware can improve behavior at the margins, but
it cannot overcome the front-end design of the radio.
In practice, AM reception will degrade first and most severely, while FM reception is generally
more tolerant and should remain more usable.

But, they are nice toys for the price, fun to play with.

## Compiling and Building from Docker

This project provides a Docker-based build system for the UV-K1 and UV-K5 V3.
Everything is handled through the `compile-firmware.sh` helper script. Fusion is
the default generic preset, while specialized builds are generated in their own
`build/<Preset>` directories.

### Prerequisites

- Docker installed on your system
- Bash environment (Linux, macOS, WSL, Git Bash on Windows)

### Build Script Overview

The script `compile-firmware.sh`:

1. Builds the Docker image (`uvk1-uvk5v3`) if it does not already exist.
2. Configures the selected preset with `cmake --fresh`.
3. Builds the firmware and outputs matching `.elf`, `.bin` and `.hex` files.
4. Displays Flash and RAM usage; `All` keeps the individual build logs quiet.

### Usage

```bash
./compile-firmware.sh [Preset] [extra CMake options]
```

The default preset is **Fusion**. Available presets are:

- **Custom**
- **Fusion**
- **Transfer**
- **FieldOps**
- **Labs**
- **All** (Fusion, Transfer, FieldOps and Labs)

Examples:

```bash
./compile-firmware.sh
./compile-firmware.sh Fusion
./compile-firmware.sh Transfer
./compile-firmware.sh FieldOps
./compile-firmware.sh Labs
./compile-firmware.sh All
```

### Passing Additional CMake Options

You can pass extra configuration options after the preset name.  
These are forwarded directly to `cmake --preset` inside the container.

Examples:

```bash
./compile-firmware.sh FieldOps -DENABLE_VOX=OFF
./compile-firmware.sh Fusion -DENABLE_FEAT_F4HWN_GAME=ON
./compile-firmware.sh Fusion -DSQL_TONE=600
```

To prepare the rolling development firmware:

```bash
./compile-firmware.sh Fusion -DDEV=ON
```

This keeps the regular build output in `build/Fusion` and also updates
`archive/f4hwn.fusion.development.bin`. The development build is identified as
`DEV` in the firmware information screen. Publishing the updated archive file
remains an explicit Git operation.

### Notes

- The first run may take a few minutes while Docker builds the base image.
- Each build runs inside Docker, so your host environment remains clean.

## Flashing the Firmware with UV Studio

You can flash the UV-K5 V3 and UV-K1 directly from your web browser using the Web Serial-based [UV Studio](https://armel.github.io/uvstudio/).

UV Studio combines firmware flashing, calibration maintenance, boot-logo management, K5Viewer and RF Log in a single interface. It requires no application installation, server or account. Use a desktop browser with Web Serial support, such as Chrome, Brave, Edge, Opera or Firefox 151+.

## Steps to flash the firmware

- Open the [Flash Firmware](https://armel.github.io/uvstudio/#flash) view in UV Studio.
- Connect your radio to your computer using a compatible USB programming cable (USB-C or Baofeng/Kenwood like double jack USB cable).
- Make sure your radio is in **DFU mode (flash mode)**.
- Select an official F4HWN Fusion release from the catalog or load a local `.bin` firmware file.
- Click on `Flash Firmware`, then select the serial port associated with your radio.
- The progress bar will guide you through the flashing steps.

Once finished, your radio restarts with the new firmware.

## Steps to dump or restore calibration data

[UV Studio](https://armel.github.io/uvstudio/) can also dump and restore calibration data, which is highly recommended. It is best to create a dump immediately after installing the F4HWN firmware, and to restore it before installing another firmware or returning to the stock firmware.

### Dump

- Open the [Dump Calibration](https://armel.github.io/uvstudio/#dump-calib) view in UV Studio.
- Power on your radio in **normal mode**.
- Click `Dump Calibration Data`.

When the process is complete, click `Download calibration.dat` to save the file to your computer.

> [!NOTE]
> A good practice is to rename your calibration file using the serial number of your radio, which you can find on the label on the back of the device once you remove the battery. This helps avoid mixing up calibration files when you own multiple units.

### Restore

- Open the [Restore Calibration](https://armel.github.io/uvstudio/#restore-calib) view in UV Studio.
- Power on your radio in **normal mode**.
- Select your `calibration.dat` file on your computer.

Click `Restore Calibration Data` and wait until the process fully completes.

## Other sources of information

- [k1-teardown](https://github.com/armel/k1-teardown) 

## Credits

Many thanks to various people:

* [Muzkr](https://github.com/muzkr)
* [Mrkusypl](https://github.com/mrkusypl)
* [Andrej](https://github.com/Tunas1337)
* [Egzumer](https://github.com/egzumer)
* [OneOfEleven](https://github.com/OneOfEleven)
* [DualTachyon](https://github.com/DualTachyon)
* [Mikhail](https://github.com/fagci)
* [Manuel](https://github.com/manujedi)
* @wagner
* @Lohtse Shar
* [@Matoz](https://github.com/spm81)
* @Davide
* @Ismo OH2FTG
* [OneOfEleven](https://github.com/OneOfEleven)
* @d1ced95
* and others I forget

## License

Copyright 2023 Dual Tachyon
https://github.com/DualTachyon

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
