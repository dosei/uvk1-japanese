/* Range-scan presets (ENABLE_RXJA_PRESET), see preset.h */

#ifdef ENABLE_RXJA_PRESET

#include <string.h>

#include "app/action.h"
#include "app/chFrScanner.h"
#include "app/generic.h"
#include "app/preset.h"
#include "app/scanner.h"
#ifdef ENABLE_FMRADIO_EMBEDDED
    #include "app/fm.h"
#endif
#include "audio.h"
#include "driver/st7565.h"
#include "external/printf/printf.h"
#include "frequencies.h"
#include "misc.h"
#include "radio.h"
#include "settings.h"
#include "ui/helper.h"
#include "ui/ja.h"
#include "ui/ui.h"

#define ROWS        3u      // list rows above the two detail lines (pages 5, 6)
#define ROW_PITCH   13u     // 12 px text + 1 px, rows at y = 0, 13, 26
#define NAME_X      18u     // after the right-aligned 2-digit number

static uint16_t gCursor;    // kept between visits
static uint16_t gTop;

static bool PresetValid(const JA_Preset_t *p)
{
    return p->lower < p->upper
        && p->step < STEP_N_ELEM
        && p->modulation < MODULATION_UKNOWN
        && p->bandwidth <= BANDWIDTH_NARROW
        && RX_freq_check(p->lower) == 0
        && RX_freq_check(p->upper) == 0;
}

// Tune the active VFO to the start of the range, as a frequency (not memory)
// channel with the preset's step, modulation and bandwidth, and scan the range.
static bool PresetApply(const JA_Preset_t *p)
{
    if (!PresetValid(p) || SCANNER_IsScanning())
        return false;

    if (gScanStateDir != SCAN_OFF)
        CHFRSCANNER_Stop();

    const uint8_t          vfo  = gEeprom.TX_VFO;
    const FREQUENCY_Band_t band = FREQUENCY_GetBand(p->lower);
    VFO_Info_t            *v    = &gEeprom.VfoInfo[vfo];

    gEeprom.ScreenChannel[vfo] = FREQ_CHANNEL_FIRST + band;
    gEeprom.FreqChannel[vfo]   = FREQ_CHANNEL_FIRST + band;
    SETTINGS_SaveVfoIndices();
    RADIO_ConfigureChannel(vfo, VFO_CONFIGURE_RELOAD);

    // RADIO_ConfigureChannel reads frequency channels back from flash, so the
    // new settings have to be saved before the VFO is configured with them
    v->freq_config_RX.Frequency = p->lower;
    v->STEP_SETTING             = p->step;
    v->StepFrequency            = gStepFrequencyTable[p->step];
    v->Modulation               = p->modulation;
    v->CHANNEL_BANDWIDTH        = p->bandwidth;
    v->FrequencyReverse         = false;
    SETTINGS_SaveChannel(v->CHANNEL_SAVE, vfo, v, 1);
    RADIO_ConfigureChannel(vfo, VFO_CONFIGURE);
    RADIO_SelectVfos();
    RADIO_SetupRegisters(true);

    CHFRSCANNER_SetRange(p->lower, p->upper);
    ACTION_Scan(false);     // back to the main screen, scanning
    return true;
}

void PRESET_Open(void)
{
#ifdef ENABLE_FMRADIO_EMBEDDED
    if (gFmRadioMode) {
        gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
        return;
    }
#endif
    gUpdateStatus = true;
    GUI_SelectNextDisplay(DISPLAY_PRESET);
}

void PRESET_ProcessKeys(KEY_Code_t Key, bool bKeyPressed, bool bKeyHeld)
{
    const uint16_t count = UI_JaPresetCount();

    if (Key == KEY_PTT) {
        GENERIC_Key_PTT(bKeyPressed);
        return;
    }

    if (!bKeyPressed && !bKeyHeld && Key != KEY_MENU)
        return;

    switch (Key) {
    case KEY_UP:
    case KEY_DOWN:
        if (count) {
            if (Key == KEY_UP)
                gCursor = (gCursor == 0 || gCursor >= count) ? count - 1u : gCursor - 1u;
            else
                gCursor = (gCursor + 1u >= count) ? 0 : gCursor + 1u;
            gUpdateDisplay = true;
        }
        break;

    case KEY_1 ... KEY_9:
    case KEY_0:
        if (bKeyPressed && !bKeyHeld) {
            const uint16_t n = (Key == KEY_0) ? 9u : (uint16_t)(Key - KEY_1);
            if (n < count) {
                gCursor = n;
                gUpdateDisplay = true;
            } else {
                gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            }
        }
        break;

    case KEY_MENU:
        // on release, so that the release does not reach the main screen
        if (!bKeyPressed && !bKeyHeld) {
            JA_Preset_t p;
            if (!UI_JaPreset(gCursor, &p) || !PresetApply(&p))
                gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
        }
        break;

    case KEY_EXIT:
        if (bKeyPressed && !bKeyHeld) {
            gRequestDisplayScreen = DISPLAY_MAIN;
            gUpdateStatus = true;
        }
        break;

    default:
        if (!bKeyHeld)
            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
        break;
    }
}

// MHz with 3 to 5 decimals: 422.050, 422.0625
static char *FormatMHz(char *s, uint32_t f)
{
    s += sprintf(s, "%u.%05u", f / 100000u, f % 100000u);
    while (s[-1] == '0' && s[-4] != '.')
        s--;
    *s = '\0';
    return s;
}

void UI_DisplayPreset(void)
{
    const uint16_t count = UI_JaPresetCount();
    JA_Preset_t    p;
    char           str[24];

    UI_DisplayClear();

    if (count == 0) {
        if (!UI_JaPrintText("NO PRESET", 0, LCD_WIDTH, 16))
            UI_PrintString("NO PRESET", 0, 127, 2, 8);
        ST7565_BlitFullScreen();
        return;
    }

    if (gCursor >= count)
        gCursor = count - 1u;
    if (gCursor < gTop)
        gTop = gCursor;
    else if (gCursor >= gTop + ROWS)
        gTop = gCursor - (ROWS - 1u);

    for (uint8_t i = 0; i < ROWS && gTop + i < count; i++) {
        const uint16_t idx = gTop + i;
        const uint8_t  y   = i * ROW_PITCH;

        if (!UI_JaPreset(idx, &p))
            break;
        sprintf(str, "%2u", idx + 1u);
        UI_JaPrint(str, 2, 0, y + 1u);
        UI_JaPrint(p.name, NAME_X, 0, y + 1u);
        if (idx == gCursor)
            UI_JaInvert(0, LCD_WIDTH, y, y + ROW_PITCH);
    }

    if (UI_JaPreset(gCursor, &p)) {
        char *s = FormatMHz(str, p.lower);
        *s++ = '-';
        FormatMHz(s, p.upper);
        UI_PrintStringSmallNormal(str, 0, 0, 5);

        const uint16_t step = (p.step < STEP_N_ELEM) ? gStepFrequencyTable[p.step] : 0;
        s = str + sprintf(str, "%u.%02u", step / 100u, step % 100u);
        while (s[-1] == '0')
            s--;
        if (s[-1] == '.')
            s--;
        sprintf(s, "k %s %s",
                (p.modulation < MODULATION_UKNOWN) ? gModulationStr[p.modulation] : "?",
                (p.bandwidth == BANDWIDTH_NARROW) ? "N" : "W");
        UI_PrintStringSmallNormal(str, 0, 0, 6);
    }

    sprintf(str, "%u/%u", gCursor + 1u, count);
    UI_PrintStringSmallNormal(str, LCD_WIDTH - 1u - strlen(str) * 7u, 0, 6);

    ST7565_BlitFullScreen();
}

#endif
