/* Range-scan presets (ENABLE_RXJA_PRESET)
 *
 * A list of named frequency ranges (特小, air band, ...) read from the
 * Japanese resource image in SPI flash, see tools/ja/presets_ja.tsv. Picking
 * one tunes the active VFO to the start of the range with the preset's step,
 * modulation and bandwidth, and starts a range scan over it.
 */

#ifndef APP_PRESET_H
#define APP_PRESET_H

#include <stdbool.h>

#include "driver/keyboard.h"

#ifdef ENABLE_RXJA_PRESET
void PRESET_Open(void);
void PRESET_ProcessKeys(KEY_Code_t Key, bool bKeyPressed, bool bKeyHeld);
void UI_DisplayPreset(void);
#endif

#endif
