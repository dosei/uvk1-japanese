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

#ifndef APP_FM_H
#define APP_FM_H

#ifdef ENABLE_FMRADIO

#include "misc.h"

#ifdef ENABLE_FMRADIO_EMBEDDED
#include "driver/keyboard.h"
#endif

#define FM_CHANNEL_UP   0x01
#define FM_CHANNEL_DOWN 0xFF

enum {
    FM_SCAN_OFF = 0U,
};

extern uint16_t          gFM_Channels[FM_CHANNELS_MAX];

// The FM memories live in their own SPI sector (header + FM_CHANNELS_MAX x uint16,
// 0.1 MHz, 0xFFFF = empty). It is not part of the CHIRP image; RxJa Tools edits it.
#define FM_STORE_ADDR   0x00B000u

// Station names: FM_NAME_LEN bytes each (Shift_JIS, NUL/0xFF padded), one per station, in their
// own sector so that tuning (which rewrites the frequency sector) never touches them. Only the PC
// tool writes them. 20 bytes = 10 full-width characters = one full 12 px line of the display.
#define FM_NAME_ADDR    0x00C000u
#define FM_NAME_LEN     20u

// Reads the name of station Channel into s (at least FM_NAME_LEN + 1 bytes), trimmed.
// Returns false (and s = "") when the station has no name.
bool    FM_FetchName(char *s, uint8_t Channel);

// Loads the table. When the sector has no valid header (first start after the update,
// or after a factory reset) the old 48-entry table at 0x00A028 is copied once.
void    FM_LoadChannels(void);
void    FM_SaveChannels(void);

bool    FM_CheckValidChannel(uint8_t Channel);
// returns first valid channel starting at Channel
uint8_t FM_FindNextChannel(uint8_t Channel, uint8_t Direction);
int     FM_ConfigureChannelState(void);
int     FM_CheckFrequencyLock(uint16_t Frequency, uint16_t LowerLimit);

#ifdef ENABLE_FMRADIO_EMBEDDED
extern bool              gFmRadioMode;
extern uint8_t           gFmRadioCountdown_500ms;
extern volatile uint16_t gFmPlayCountdown_10ms;
extern volatile int8_t   gFM_ScanState;
extern bool              gFM_AutoScan;
extern uint8_t           gFM_ChannelPosition;   // save slot, or stations added by the running auto-scan
extern uint8_t           gFM_ScanFirstAdded;    // first slot filled by the auto-scan, 0xFF = none
extern bool              gFM_FoundFrequency;
extern uint16_t          gFM_RestoreCountdown_10ms;

void    FM_TurnOff(void);

void    FM_Tune(uint16_t Frequency, int8_t Step, bool bFlag);
void    FM_PlayAndUpdate(void);

void    FM_ProcessKeys(KEY_Code_t Key, bool bKeyPressed, bool bKeyHeld);

void    FM_Play(void);
void    FM_Start(void);
#endif

#endif

#endif
