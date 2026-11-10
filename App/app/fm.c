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

#ifdef ENABLE_FMRADIO

#include <string.h>

#include "app/action.h"
#include "app/fm.h"
#include "app/generic.h"
#include "audio.h"
#include "driver/bk1080.h"
#include "driver/bk4819.h"
#include "driver/py25q16.h"
#include "driver/gpio.h"
#include "functions.h"
#include "misc.h"
#include "settings.h"
#include "ui/inputbox.h"
#include "ui/ui.h"

uint16_t          gFM_Channels[FM_CHANNELS_MAX];
#ifdef ENABLE_FMRADIO_EMBEDDED
bool              gFmRadioMode;
uint8_t           gFmRadioCountdown_500ms;
volatile uint16_t gFmPlayCountdown_10ms;
volatile int8_t   gFM_ScanState;
bool              gFM_AutoScan;
uint8_t           gFM_ChannelPosition;
uint8_t           gFM_ScanFirstAdded;
bool              gFM_FoundFrequency;
uint16_t          gFM_RestoreCountdown_10ms;



const uint8_t BUTTON_STATE_PRESSED = 1 << 0;
const uint8_t BUTTON_STATE_HELD = 1 << 1;

const uint8_t BUTTON_EVENT_PRESSED = BUTTON_STATE_PRESSED;
const uint8_t BUTTON_EVENT_HELD = BUTTON_STATE_PRESSED | BUTTON_STATE_HELD;
const uint8_t BUTTON_EVENT_SHORT =  0;
const uint8_t BUTTON_EVENT_LONG =  BUTTON_STATE_HELD;

static void Key_FUNC(KEY_Code_t Key, uint8_t state);
#endif

// Old table (v1.3.0 and earlier, and what CHIRP still writes): 48 x uint16 at 0x00A028.
#define FM_LEGACY_ADDR   0x00A028u
#define FM_LEGACY_COUNT  48u
#define FM_STORE_MAGIC   0x314D4652u    // "RFM1"

typedef struct {
    uint32_t magic;
    uint16_t count;     // number of entries written
    uint16_t flags;     // bit 0 = 0: the name sector has been cleared (older layouts left data there)
} __attribute__((packed)) FM_StoreHeader_t;

#define FM_FLAGS_NAMES_OK 0xFFFEu

void FM_LoadChannels(void)
{
    FM_StoreHeader_t hdr;

    memset(gFM_Channels, 0xFF, sizeof(gFM_Channels));
    PY25Q16_ReadBuffer(FM_STORE_ADDR, &hdr, sizeof(hdr));

    if (hdr.magic == FM_STORE_MAGIC) {
        const uint16_t n = hdr.count < FM_CHANNELS_MAX ? hdr.count : FM_CHANNELS_MAX;
        PY25Q16_ReadBuffer(FM_STORE_ADDR + sizeof(hdr), gFM_Channels, n * sizeof(gFM_Channels[0]));
        if (hdr.flags & 1u) {
            // Table from a build without names: whatever is in the name sector is not ours
            PY25Q16_SectorErase(FM_NAME_ADDR);
            FM_SaveChannels();
        }
        return;
    }

    // No valid header: start from the old table, then write the new sector. The old
    // table is left untouched so that going back to an older firmware keeps the stations.
    PY25Q16_ReadBuffer(FM_LEGACY_ADDR, gFM_Channels, FM_LEGACY_COUNT * sizeof(gFM_Channels[0]));
    PY25Q16_SectorErase(FM_STORE_ADDR);     // drop whatever an older layout left here
    PY25Q16_SectorErase(FM_NAME_ADDR);
    FM_SaveChannels();
}

void FM_SaveChannels(void)
{
    const FM_StoreHeader_t hdr = { FM_STORE_MAGIC, FM_CHANNELS_MAX, FM_FLAGS_NAMES_OK };

    // PY25Q16_WriteBuffer skips unchanged data and erases only when a bit has to go 0->1.
    PY25Q16_WriteBuffer(FM_STORE_ADDR, &hdr, sizeof(hdr), false);
    PY25Q16_WriteBuffer(FM_STORE_ADDR + sizeof(hdr), gFM_Channels, sizeof(gFM_Channels), false);
}

bool FM_FetchName(char *s, uint8_t Channel)
{
    uint8_t i;

    s[0] = 0;
    if (Channel >= FM_CHANNELS_MAX)
        return false;

    PY25Q16_ReadBuffer(FM_NAME_ADDR + (uint32_t)Channel * FM_NAME_LEN, s, FM_NAME_LEN);

    for (i = 0; i < FM_NAME_LEN; i++)
        // Shift_JIS: bytes 0x80..0xFE belong to the name; control codes and 0xFF end it
        if ((uint8_t)s[i] < 32 || (uint8_t)s[i] == 127 || (uint8_t)s[i] == 0xFF)
            break;
    s[i] = 0;
    while (i > 0 && s[i - 1] == ' ')
        s[--i] = 0;

    return s[0] != 0;
}

bool FM_CheckValidChannel(uint8_t Channel)
{
    return  Channel < ARRAY_SIZE(gFM_Channels) && 
            gFM_Channels[Channel] >= BK1080_GetFreqLoLimit(gEeprom.FM_Band) && 
            gFM_Channels[Channel] < BK1080_GetFreqHiLimit(gEeprom.FM_Band);
}

uint8_t FM_FindNextChannel(uint8_t Channel, uint8_t Direction)
{
    for (unsigned i = 0; i < ARRAY_SIZE(gFM_Channels); i++) {
        if (Channel == 0xFF)
            Channel = ARRAY_SIZE(gFM_Channels) - 1;
        else if (Channel >= ARRAY_SIZE(gFM_Channels))
            Channel = 0;
        if (FM_CheckValidChannel(Channel))
            return Channel;
        Channel += Direction;
    }

    return 0xFF;
}

int FM_ConfigureChannelState(void)
{
    gEeprom.FM_FrequencyPlaying = gEeprom.FM_SelectedFrequency;

    if (gEeprom.FM_IsMrMode) {
        const uint8_t Channel = FM_FindNextChannel(gEeprom.FM_SelectedChannel, FM_CHANNEL_UP);
        if (Channel == 0xFF) {
            gEeprom.FM_IsMrMode = false;
            return -1;
        }
        gEeprom.FM_SelectedChannel  = Channel;
        gEeprom.FM_FrequencyPlaying = gFM_Channels[Channel];
    }

    return 0;
}

#ifdef ENABLE_FMRADIO_EMBEDDED
void FM_SetFrequency(void)
{
    BK1080_SetFrequency(gEeprom.FM_FrequencyPlaying, gEeprom.FM_Band/*, gEeprom.FM_Space*/);
}

void FM_TurnOff(void)
{
    gFmRadioMode              = false;
    gFM_ScanState             = FM_SCAN_OFF;
    gFM_RestoreCountdown_10ms = 0;

    AUDIO_AudioPathOff();
    gEnableSpeaker = false;

    BK1080_Init0();

    // Enable relevant LNA based on VFO frequency
    BK4819_PickRXFilterPathBasedOnFrequency(gRxVfo->freq_config_RX.Frequency);


    gUpdateStatus  = true;

    #ifdef ENABLE_FEAT_F4HWN_RESUME_STATE
        gEeprom.CURRENT_STATE = 0;
        SETTINGS_WriteCurrentState();
    #endif
}

// The name belongs to the frequency the PC tool wrote it for. When the radio puts another
// frequency in a slot (save, delete, auto-scan), the old name is cut off by programming a 0
// over its first byte: a 1->0 change, so no sector erase. The PC tool rewrites names whole.
static void FM_ClearName(uint8_t Slot)
{
    const uint32_t Addr = FM_NAME_ADDR + (uint32_t)Slot * FM_NAME_LEN;
    uint8_t First;

    PY25Q16_ReadBuffer(Addr, &First, 1);
    if (First != 0x00 && First != 0xFF) {
        const uint8_t Zero = 0;
        PY25Q16_WriteBuffer(Addr, &Zero, 1, false);
    }
}

static void FM_StoreSlot(uint8_t Slot, uint16_t Frequency)
{
    if (gFM_Channels[Slot] != Frequency)
        FM_ClearName(Slot);
    gFM_Channels[Slot] = Frequency;
}

// A slot is free when it holds no frequency that any FM band could use (0xFFFF or junk).
static bool FM_SlotIsFree(uint8_t Slot)
{
    return gFM_Channels[Slot] < 640 || gFM_Channels[Slot] > 1080;
}

static uint8_t FM_FirstFreeSlot(void)
{
    for (uint8_t i = 0; i < FM_CHANNELS_MAX; i++)
        if (FM_SlotIsFree(i))
            return i;
    return 0;
}

// Auto-scan: store a found station in the first free slot, skipping ones already stored.
// Returns false when the table is full.
static bool FM_AppendScanned(uint16_t Frequency)
{
    uint8_t Free = 0xFF;

    for (uint8_t i = 0; i < FM_CHANNELS_MAX; i++) {
        if (gFM_Channels[i] == Frequency)
            return true;
        if (Free == 0xFF && FM_SlotIsFree(i))
            Free = i;
    }

    if (Free == 0xFF)
        return false;

    FM_StoreSlot(Free, Frequency);
    if (gFM_ChannelPosition++ == 0)
        gFM_ScanFirstAdded = Free;
    return true;
}

uint16_t FM_WrapFrequency(uint16_t Frequency) {
    const uint16_t freqLoLimit = BK1080_GetFreqLoLimit(gEeprom.FM_Band);
    const uint16_t freqHiLimit = BK1080_GetFreqHiLimit(gEeprom.FM_Band);

    if (Frequency < freqLoLimit)
        return freqHiLimit;
    else if (Frequency > freqHiLimit)
        return freqLoLimit;

    return Frequency;
}

void FM_Tune(uint16_t Frequency, int8_t Step, bool bFlag)
{
    AUDIO_AudioPathOff();

    gEnableSpeaker = false;

    gFmPlayCountdown_10ms = (gFM_ScanState == FM_SCAN_OFF) ? fm_play_countdown_noscan_10ms : fm_play_countdown_scan_10ms;

    gScheduleFM                 = false;
    gFM_FoundFrequency          = false;
    gAskToSave                  = false;
    gAskToDelete                = false;
    gEeprom.FM_FrequencyPlaying = Frequency;

    if (!bFlag) {
        Frequency += Step;
        Frequency = FM_WrapFrequency(Frequency);

        gEeprom.FM_FrequencyPlaying = Frequency;
    }

    gFM_ScanState = Step;

    FM_SetFrequency();
}

void FM_AudioPathOn(void) {
    AUDIO_AudioPathOn();
    gEnableSpeaker = true;
}

void FM_PlayAndUpdate(void)
{
    gFM_ScanState = FM_SCAN_OFF;

    if (gFM_AutoScan) {
        if (gFM_ScanFirstAdded != 0xFF) {
            // Land on the first station this scan added; with nothing added, stay as before.
            gEeprom.FM_IsMrMode        = true;
            gEeprom.FM_SelectedChannel = gFM_ScanFirstAdded;
        }
        // The counter is only a count while scanning; afterwards it is the save-slot
        // cursor (gFM_Channels[gFM_ChannelPosition]): point it at the next free slot so
        // that M (save) does not overwrite a stored station.
        gFM_ChannelPosition = FM_FirstFreeSlot();
    }

    FM_ConfigureChannelState();
    FM_SetFrequency();
    SETTINGS_SaveFM();

    gFmPlayCountdown_10ms = 0;
    gScheduleFM           = false;
    gAskToSave            = false;

    BACKLIGHT_TurnOn();
    FM_AudioPathOn();
}
#endif

int FM_CheckFrequencyLock(uint16_t Frequency, uint16_t LowerLimit)
{
    const uint16_t Test2     = BK1080_ReadRegister(BK1080_REG_07);
    const uint16_t Deviation = BK1080_REG_07_GET_FREQD(Test2);

    // Helper macro to update globals and return
    #define RETURN(val) \
        do { \
            BK1080_FrequencyDeviation = Deviation; \
            BK1080_BaseFrequency      = Frequency; \
            return (val); \
        } while (0)

    if (BK1080_REG_07_GET_SNR(Test2) <= 2)
        RETURN(-1);

    const uint16_t Status = BK1080_ReadRegister(BK1080_REG_10);
    if ((Status & BK1080_REG_10_MASK_AFCRL) != BK1080_REG_10_AFCRL_NOT_RAILED ||
        BK1080_REG_10_GET_RSSI(Status) < 10)
        RETURN(-1);

    if (Deviation >= 280 && Deviation <= 3815)
        RETURN(-1);

    // Scanning upward: previous deviation was negative (bit 11 set) or near zero
    if (Frequency > LowerLimit && (Frequency - BK1080_BaseFrequency) == 1) {
        if (BK1080_FrequencyDeviation & 0x800 || BK1080_FrequencyDeviation < 20)
            RETURN(-1);
    }

    // Scanning downward: previous deviation was positive or saturated high
    if (Frequency >= LowerLimit && (BK1080_BaseFrequency - Frequency) == 1) {
        if ((BK1080_FrequencyDeviation & 0x800) == 0 || BK1080_FrequencyDeviation > 4075)
            RETURN(-1);
    }

    #undef RETURN

    BK1080_FrequencyDeviation = Deviation;
    BK1080_BaseFrequency      = Frequency;
    return 0;
}

#ifdef ENABLE_FMRADIO_EMBEDDED
static void Key_DIGITS(KEY_Code_t Key, uint8_t state)
{
    enum { STATE_FREQ_MODE, STATE_MR_MODE, STATE_SAVE };

    if (state == BUTTON_EVENT_SHORT && !gWasFKeyPressed) {
        uint8_t State;

        if (gAskToDelete) {
            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            return;
        }

        if (gAskToSave) {
            State = STATE_SAVE;
        }
        else {
            if (gFM_ScanState != FM_SCAN_OFF) {
                gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
                return;
            }

            State = gEeprom.FM_IsMrMode ? STATE_MR_MODE : STATE_FREQ_MODE;
        }

        INPUTBOX_Append(Key);
        gKeyInputCountdown = key_input_timeout_500ms;

        gRequestDisplayScreen = DISPLAY_FM;

        if (State == STATE_FREQ_MODE) {
            if (gInputBoxIndex == 1) {
                if (gInputBox[0] > 1) {
                    gInputBox[1] = gInputBox[0];
                    gInputBox[0] = 0;
                    gInputBoxIndex = 2;
                }
            }
            else if (gInputBoxIndex > 3) {
                uint32_t Frequency;

                gInputBoxIndex = 0;
                gKeyInputCountdown = 1;

                Frequency = StrToUL(INPUTBOX_GetAscii());

                if (Frequency < BK1080_GetFreqLoLimit(gEeprom.FM_Band) || BK1080_GetFreqHiLimit(gEeprom.FM_Band) < Frequency) {
                    gBeepToPlay           = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
                    gRequestDisplayScreen = DISPLAY_FM;
                    return;
                }

                gEeprom.FM_SelectedFrequency = (uint16_t)Frequency;
#ifdef ENABLE_VOICE
                gAnotherVoiceID = (VOICE_ID_t)Key;
#endif
                gEeprom.FM_FrequencyPlaying = gEeprom.FM_SelectedFrequency;
                FM_SetFrequency();
                gRequestSaveFM = true;
                return;
            }
        }
        else if (gInputBoxIndex == 2) {
            uint8_t Channel;

            gInputBoxIndex = 0;
            gKeyInputCountdown = 1;
            
            Channel = (gInputBox[0] * 10) + gInputBox[1];   // FM00..FM99

            if (State == STATE_MR_MODE) {
                if (FM_CheckValidChannel(Channel)) {
#ifdef ENABLE_VOICE
                    gAnotherVoiceID = (VOICE_ID_t)Key;
#endif
                    gEeprom.FM_SelectedChannel = Channel;
                    gEeprom.FM_FrequencyPlaying = gFM_Channels[Channel];
                    FM_SetFrequency();
                    gRequestSaveFM = true;
                    return;
                }
            }
            else if (Channel < FM_CHANNELS_MAX) {
#ifdef ENABLE_VOICE
                gAnotherVoiceID = (VOICE_ID_t)Key;
#endif
                gRequestDisplayScreen = DISPLAY_FM;
                gInputBoxIndex = 0;
                gFM_ChannelPosition = Channel;
                return;
            }

            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            return;
        }

#ifdef ENABLE_VOICE
        gAnotherVoiceID = (VOICE_ID_t)Key;
#endif
    }
    else
        Key_FUNC(Key, state);
}

static void Key_FUNC(KEY_Code_t Key, uint8_t state)
{
    if (state == BUTTON_EVENT_SHORT || state == BUTTON_EVENT_HELD) {
        bool autoScan = gWasFKeyPressed || (state == BUTTON_EVENT_HELD);

        gBeepToPlay           = BEEP_1KHZ_60MS_OPTIONAL;
        HideFKeyIcon();
        gRequestDisplayScreen = DISPLAY_FM;

        switch (Key) {
            case KEY_0:
                ACTION_FM();
                break;

            case KEY_1:
                gEeprom.FM_Band++;
                gRequestSaveFM = true;
                break;

            // case KEY_2:
            //  gEeprom.FM_Space = (gEeprom.FM_Space + 1) % 3;
            //  gRequestSaveFM = true;
            //  break;

            case KEY_3:
                gEeprom.FM_IsMrMode = !gEeprom.FM_IsMrMode;

                if (!FM_ConfigureChannelState()) {
                    FM_SetFrequency();
                    gRequestSaveFM = true;
                }
                else
                    gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
                break;

            case KEY_8:
                ACTION_BackLightOnDemand();
                break;

            case KEY_9:
                ACTION_BackLight();
                break;

            case KEY_STAR:
                ACTION_Scan(autoScan);
                break;

            default:
                gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
                break;
        }
    }
}

static void Key_EXIT(uint8_t state)
{
    if (gInputBoxIndex) {
        if (state != BUTTON_EVENT_SHORT)
            return;
    } 
    else {
        if (state != BUTTON_EVENT_PRESSED)
            return;
    }

    gBeepToPlay = BEEP_1KHZ_60MS_OPTIONAL;

    if (gFM_ScanState == FM_SCAN_OFF) {
        if (gInputBoxIndex == 0) {
            if (!gAskToSave && !gAskToDelete) {
                ACTION_FM();
                return;
            }

            gAskToSave   = false;
            gAskToDelete = false;
        }
        else {
            gInputBox[--gInputBoxIndex] = 10;
            gKeyInputCountdown = key_input_timeout_500ms;

            if (gInputBoxIndex) {
                if (gInputBoxIndex != 1) {
                    gRequestDisplayScreen = DISPLAY_FM;
                    return;
                }

                if (gInputBox[0] != 0) {
                    gRequestDisplayScreen = DISPLAY_FM;
                    return;
                }
            }
            gInputBoxIndex = 0;
        }

#ifdef ENABLE_VOICE
        gAnotherVoiceID = VOICE_ID_CANCEL;
#endif
    }
    else {
        FM_PlayAndUpdate();
#ifdef ENABLE_VOICE
        gAnotherVoiceID = VOICE_ID_SCANNING_STOP;
#endif
    }

    gRequestDisplayScreen = DISPLAY_FM;
}

static void Key_MENU(uint8_t state)
{
    if (state == BUTTON_EVENT_HELD) {
        ACTION_Handle(KEY_MENU, true, true);
        return;
    }
    else if (state != BUTTON_EVENT_SHORT) {
        return;
    }

    gRequestDisplayScreen = DISPLAY_FM;
    gBeepToPlay           = BEEP_1KHZ_60MS_OPTIONAL;

    HideFKeyIcon();

    if (gFM_ScanState == FM_SCAN_OFF) {
        if (gInputBoxIndex) {
            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            return;
        }

        if (!gEeprom.FM_IsMrMode) {
            if (gAskToSave) {
                FM_StoreSlot(gFM_ChannelPosition, gEeprom.FM_FrequencyPlaying);
                gRequestSaveFM = true;
            }
            gAskToSave = !gAskToSave;
        }
        else {
            if (gAskToDelete) {
                FM_StoreSlot(gEeprom.FM_SelectedChannel, 0xFFFF);

                FM_ConfigureChannelState();
                FM_SetFrequency();

                gRequestSaveFM = true;
            }
            gAskToDelete = !gAskToDelete;
        }
    }
    else {
        if (gFM_AutoScan || !gFM_FoundFrequency) {
            gBeepToPlay    = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            gInputBoxIndex = 0;
            return;
        }

        if (gAskToSave) {
            FM_StoreSlot(gFM_ChannelPosition, gEeprom.FM_FrequencyPlaying);
            gRequestSaveFM = true;
        }
        gAskToSave = !gAskToSave;
    }
}

static void Key_UP_DOWN(uint8_t state, int8_t Step)
{
    HideFKeyIcon();

    if (state == BUTTON_EVENT_PRESSED) {
        if (gInputBoxIndex) {
            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            return;
        }

        gBeepToPlay = BEEP_1KHZ_60MS_OPTIONAL;
    } else if (gInputBoxIndex || state!=BUTTON_EVENT_HELD) {
        return;
    }

    if (!gEeprom.SET_NAV) {
        Step = -Step;
    }

    if (gAskToSave) {
        gRequestDisplayScreen = DISPLAY_FM;
        gFM_ChannelPosition   = NUMBER_AddWithWraparound(gFM_ChannelPosition, Step, 0, FM_CHANNELS_MAX - 1);
        return;
    }

    if (gFM_ScanState != FM_SCAN_OFF) {
        if (gFM_AutoScan) {
            gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
            return;
        }

        FM_Tune(gEeprom.FM_FrequencyPlaying, Step, false);
        gRequestDisplayScreen = DISPLAY_FM;
        return;
    }

    if (gEeprom.FM_IsMrMode) {
        const uint8_t Channel = FM_FindNextChannel(gEeprom.FM_SelectedChannel + Step, Step);
        if (Channel == 0xFF || gEeprom.FM_SelectedChannel == Channel)
            goto Bail;

        gEeprom.FM_SelectedChannel  = Channel;
        gEeprom.FM_FrequencyPlaying = gFM_Channels[Channel];
    }
    else {
        uint16_t Frequency = gEeprom.FM_SelectedFrequency + Step;

        Frequency = FM_WrapFrequency(Frequency);

        gEeprom.FM_FrequencyPlaying  = Frequency;
        gEeprom.FM_SelectedFrequency = gEeprom.FM_FrequencyPlaying;
    }

    gRequestSaveFM = true;

Bail:
    FM_SetFrequency();

    gRequestDisplayScreen = DISPLAY_FM;
}

void FM_ProcessKeys(KEY_Code_t Key, bool bKeyPressed, bool bKeyHeld)
{
    uint8_t state = bKeyPressed + 2 * bKeyHeld;

    switch (Key) {
        case KEY_0...KEY_9:
            Key_DIGITS(Key, state);
            break;
        case KEY_STAR:
            Key_FUNC(Key, state);
            break;
        case KEY_MENU:
            Key_MENU(state);
            break;
        case KEY_UP:
        case KEY_DOWN:
            Key_UP_DOWN(state, Key == KEY_UP ? 1 : -1);
            break;
        case KEY_EXIT:
            Key_EXIT(state);
            break;
        case KEY_F:
            GENERIC_Key_F(bKeyPressed, bKeyHeld);
            break;
        case KEY_PTT:
            GENERIC_Key_PTT(bKeyPressed);
            break;
        case KEY_SIDE1:
        case KEY_SIDE2:
            if (state != BUTTON_EVENT_PRESSED) {
                gBeepToPlay = BEEP_500HZ_60MS_DOUBLE_BEEP_OPTIONAL;
                HideFKeyIcon();
            }
            break;
        default:
            break;
    }
}

void FM_Play(void)
{
    if (!FM_CheckFrequencyLock(gEeprom.FM_FrequencyPlaying, BK1080_GetFreqLoLimit(gEeprom.FM_Band))) {
        if (!gFM_AutoScan) {
            gFmPlayCountdown_10ms = 0;
            gFM_FoundFrequency    = true;

            if (!gEeprom.FM_IsMrMode)
                gEeprom.FM_SelectedFrequency = gEeprom.FM_FrequencyPlaying;

            BACKLIGHT_TurnOn();
            FM_AudioPathOn();

            goto Display;
        }

        if (!FM_AppendScanned(gEeprom.FM_FrequencyPlaying)) {
            FM_PlayAndUpdate();     // table full

            goto Display;
        }
    }

    if (gFM_AutoScan && gEeprom.FM_FrequencyPlaying >= BK1080_GetFreqHiLimit(gEeprom.FM_Band))
        FM_PlayAndUpdate();
    else
        FM_Tune(gEeprom.FM_FrequencyPlaying, gFM_ScanState, false);

Display:
    GUI_SelectNextDisplay(DISPLAY_FM);
}

void FM_Start(void)
{
    gDualWatchActive          = false;
    gFmRadioMode              = true;
    gFM_ScanState             = FM_SCAN_OFF;
    gFM_RestoreCountdown_10ms = 0;

    BK1080_Init(gEeprom.FM_FrequencyPlaying, gEeprom.FM_Band/*, gEeprom.FM_Space*/);
    // Disable UHF LNA, enable VHF LNA
    BK4819_PickRXFilterPathBasedOnFrequency(10320000); // 103.2 MHz < 280 MHz

    FM_AudioPathOn();

    gUpdateStatus        = true;

    #ifdef ENABLE_FEAT_F4HWN_RESUME_STATE
        gEeprom.CURRENT_STATE = 3;
        SETTINGS_WriteCurrentState();
    #endif
}
#endif

#endif
