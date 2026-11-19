/* Copyright 2023 Dual Tachyon
 * https://github.com/DualTachyon
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 */

#include <stdbool.h>
#include <string.h>
#include "app/scanner.h"
#include "dcs.h"
#include "driver/st7565.h"
#include "external/printf/printf.h"
#include "misc.h"
#include "ui/helper.h"
#ifdef ENABLE_JAPANESE
    #include "ui/ja.h"
#endif
#include "ui/scanner.h"

#ifdef ENABLE_JAPANESE
// A line in Japanese: "Label:value" as the translated label followed by the
// value in the 8x16 font, or in Japanese too ("Tone:None"). Returns false,
// drawing nothing, when the label (or the whole text) has no translation.
static bool PrintJa(const char *pStr, uint8_t line)
{
    char           label[8];
    const char    *value = strchr(pStr, ':');
    const uint8_t  y     = line * 8u + 2u;     // 12 px text centred in the two pages

    if (!value)
        return UI_JaPrintText(pStr, 2, 0, y);

    value++;
    if ((size_t)(value - pStr) >= sizeof(label))
        return false;
    memcpy(label, pStr, value - pStr);
    label[value - pStr] = '\0';

    const char *ja = UI_JaText(label);
    if (ja == label)
        return false;
    const uint8_t x = UI_JaPrint(ja, 2, 0, y);
    if (!UI_JaPrintText(value, x, 0, y))
        UI_PrintString(value, x, 0, line, 8);
    return true;
}

static void PrintLine(const char *pStr, uint8_t line)
{
    if (!PrintJa(pStr, line))
        UI_PrintString(pStr, 2, 0, line, 8);
}
#else
    #define PrintLine(pStr, line)   UI_PrintString(pStr, 2, 0, line, 8)
#endif

void UI_DisplayScanner(void)
{
    char String[16];

    UI_DisplayClear();

    // 1st line
    if (gScannerSaveState == SCAN_SAVE_CHANNEL) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_SAVE_PROMPT);
    } else if (gScannerSaveState == SCAN_SAVE_CHAN_SEL) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_SAVE_PREFIX);
        UI_GenerateChannelStringEx(String + 5, gShowChPrefix, gScanChannel);
    } else if ((gScanCssState < SCAN_CSS_STATE_FOUND) && ((gScanProgressIndicator & 1u) != 0)) {
        String[0] = '\0';
    } else if (gScanCssState == SCAN_CSS_STATE_OFF) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_SEARCH_FREQ);
    } else if (gScanCssState == SCAN_CSS_STATE_SCANNING) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_SEARCH_TONE);
    } else if (gScanCssState == SCAN_CSS_STATE_FOUND) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_COMPLETE);
    } else {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_FAILED);
    }

    PrintLine(String, 1);

    // 2nd line
    if (gScanSingleFrequency || (gScanCssState != SCAN_CSS_STATE_OFF && gScanCssState != SCAN_CSS_STATE_FAILED)) {
        sprintf(String, "Freq:%u.%05u", gScanFrequency / 100000, gScanFrequency % 100000);
    } else {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_FREQ_UNKNOWN);
    }

    PrintLine(String, 3);

    // 3rd line
    if (gScanCssState < SCAN_CSS_STATE_FOUND) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_TONE_UNKNOWN);
    } else if (!gScanUseCssResult) {
        UI_LoadText(String, sizeof(String), UI_TEXT_SCANNER_TONE_NONE);
    } else if (gScanCssResultType == CODE_TYPE_CONTINUOUS_TONE) {
        sprintf(String, "CTCSS:%u.%uHz", CTCSS_Options[gScanCssResultCode] / 10, CTCSS_Options[gScanCssResultCode] % 10);
    } else {
        sprintf(String, "DCS:D%03oN", DCS_GetOption(gScanCssResultCode));
    }
 
    PrintLine(String, 5);

    ST7565_BlitFullScreen();
}
