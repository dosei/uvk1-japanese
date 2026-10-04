/* Japanese text rendering (ENABLE_JAPANESE)
 *
 * UTF-8 strings mixing ASCII and full-width characters. Full-width glyphs are
 * 12x12 and come from the resource image in external SPI flash (built by
 * tools/ja/gen_ja_font.py); ASCII uses the built-in gFontSmall. Text is drawn
 * into gFrameBuffer at a pixel row, so a line of text is 12 px tall and does
 * not have to sit on an 8 px page boundary.
 */

#ifndef UI_JA_H
#define UI_JA_H

#include <stdbool.h>
#include <stdint.h>

// SPI region between the overlay Apps (ends 0x122000) and the voice prompts
// (0x14C000), see the map in driver/mb_flash.h. 0x0C0000..0x100000 is NOT
// free: it holds the multiboot config banks 1..4.
#define JA_FLASH_BASE   0x122000u
#define JA_FLASH_SIZE   0x02A000u
#define JA_LINE_HEIGHT  12
#define JA_TEXT_MAX     48          // longest translated UI string in bytes, incl. NUL
#define JA_VALUE_PITCH  14          // line pitch of multi-line menu values

// true when a valid resource image is present in SPI flash
bool    UI_JaReady(void);

// forget the cached header, e.g. after the image was rewritten over UART
void    UI_JaInvalidate(void);

// Japanese UI text for an English UI string, looked up in the image's string
// table. Returns pEnglish itself when there is no image or no translation.
// The result lives in a static buffer that the next call overwrites.
const char *UI_JaText(const char *pEnglish);

// Draw the translation of pEnglish like UI_JaPrint. Returns false, drawing
// nothing, when there is no image or no translation (draw the English then).
bool    UI_JaPrintText(const char *pEnglish, uint8_t Start, uint8_t End, uint8_t y);

// Translation of a menu value: "<pMenu>|<pValue>" first (the same English
// word can mean different things in different menus), then pValue alone.
// pMenu may be NULL. Returns NULL when neither is translated; otherwise the
// static buffer of UI_JaText.
const char *UI_JaValue(const char *pMenu, const char *pValue);

// Draw a menu value ('\n' separates lines) in Japanese, centred in [Start, End)
// and vertically in pixel rows [8, Bottom) at JA_VALUE_PITCH (from row 0 if it
// does not fit); one or two lines stay above row 40, as the 8x16 English
// values do. When the whole
// value has no translation its first line is tried ("CARRIER\n00s:250ms").
// Returns false, drawing nothing, when there is no translation.
bool    UI_JaPrintValue(const char *pMenu, const char *pValue, uint8_t Start, uint8_t End, uint8_t Bottom);

// pixel width of pString as UI_JaPrint would draw it
uint8_t UI_JaWidth(const char *pString);

// Draw pString with its top edge at pixel row y of gFrameBuffer (0 = first
// row below the status line). If End > Start the text is centred in
// [Start, End), and nothing is drawn at or past End. Pixels are OR-ed in.
// Returns the x coordinate after the last character drawn.
uint8_t UI_JaPrint(const char *pString, uint8_t Start, uint8_t End, uint8_t y);

// Shift_JIS strings (channel names): JIS X 0208 double-byte characters,
// half-width katakana 0xA1..0xDF and ASCII, drawn like UI_JaPrint. Double-
// byte characters need the image's Shift_JIS table (tools/ja/gen_ja_font.py,
// after the preset table; RxJa v1.1.0 and later), see UI_JaSjisReady.
bool    UI_JaSjisReady(void);
uint8_t UI_JaWidthSjis(const char *pString);
uint8_t UI_JaPrintSjis(const char *pString, uint8_t Start, uint8_t End, uint8_t y);

// XOR pixel rows [y0, y1) between x Start and End, e.g. to highlight a 12 px line
void    UI_JaInvert(uint8_t Start, uint8_t End, uint8_t y0, uint8_t y1);

#ifdef ENABLE_RXJA_PRESET
// Range-scan presets (tools/ja/presets_ja.tsv), stored after the string table.
// The table's pad field holds its offset from the string table in 4-byte
// units (0 = none): u16 count, u16 record size, then count records.
#define JA_PRESET_NAME  28          // bytes, NUL-padded UTF-8

typedef struct {
    uint32_t lower;                 // 10 Hz units, inclusive
    uint32_t upper;
    uint8_t  step;                  // STEP_Setting_t
    uint8_t  modulation;            // ModulationMode_t
    uint8_t  bandwidth;             // BANDWIDTH_WIDE / BANDWIDTH_NARROW
    uint8_t  flags;                 // reserved, 0
    char     name[JA_PRESET_NAME];
} JA_Preset_t;                      // layout of a record in the image

uint16_t UI_JaPresetCount(void);

// read preset index (< UI_JaPresetCount()); the name is always NUL-terminated
bool    UI_JaPreset(uint16_t index, JA_Preset_t *pPreset);
#endif

#endif
