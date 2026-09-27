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

#include <string.h>
#include <stdint.h>

#include "driver/py25q16.h"
#include "driver/st7565.h"
#include "external/printf/printf.h"
#include "font.h"
#include "helper/battery.h"
#include "settings.h"
#include "misc.h"
#include "ui/helper.h"
#ifdef ENABLE_JAPANESE
    #include "ui/ja.h"
#endif
#include "ui/welcome.h"
#include "ui/status.h"
#include "version.h"
#include "bitmaps.h"

#ifdef ENABLE_FEAT_F4HWN_K5VIEWER
    #include "k5viewer.h"
#endif

#ifdef ENABLE_FEAT_F4HWN_LOGO
// Boot logo storage in PY25Q16 external flash, aligned on a 4 KB sector,
// placed past the calibration zone (0x010000-0x010200).
//
// Layout inside the sector starting at LOGO_FLASH_ADDR:
//   [0x00..0x07] : 8-byte header (reserved for future magic/version/flags)
//   [0x08..0x407]: 128x64 monochrome bitmap (1024 B)
//                  ST7565-native: 8 pages * 128 columns, column-major LSB-top
#define LOGO_FLASH_ADDR     0x011000
#define LOGO_HEADER_SIZE    8
#define LOGO_BITMAP_ADDR    (LOGO_FLASH_ADDR + LOGO_HEADER_SIZE)

static void UI_LoadLogo(void)
{
    // Skip 8-byte header, then read 128x64 bitmap (1024 B):
    // page 0 -> gStatusLine, pages 1..7 -> gFrameBuffer.
    PY25Q16_ReadBuffer(LOGO_BITMAP_ADDR, gStatusLine, sizeof(gStatusLine));
    PY25Q16_ReadBuffer(LOGO_BITMAP_ADDR + sizeof(gStatusLine), gFrameBuffer, sizeof(gFrameBuffer));
}

void UI_DisplayLogo(void)
{
    UI_LoadLogo();
    ST7565_BlitStatusLine();
    ST7565_BlitFullScreen();
}
#endif

#ifdef ENABLE_FEAT_F4HWN_QRCODE
// QR codes (version 4, 33x33 modules, no quiet zone) made by tools/ja/gen_qr.py.
// Rows 0..31: 4 fb-lines x 33 columns, each byte packs 8 vertical pixels
// (bit 0 = top). Row 32: 5 bytes, bit (x & 7) of byte x >> 3.
// https://github.com/dosei/uvk1-japanese (version 4, EC level Q)
static const uint8_t BITMAP_QR_GitHub_Compressed[137] = {
    0x7F, 0x41, 0x5D, 0x5D, 0x5D, 0x41, 0x7F, 0x00, 0x71, 0x2A, 0x75, 0x8E, 0xE7, 0x3F, 0xE9, 0x83,
    0xF9, 0x20, 0x6A, 0xAD, 0xD7, 0x95, 0x4C, 0x11, 0x40, 0x00, 0x7F, 0x41, 0x5D, 0x5D, 0x5D, 0x41,
    0x7F, 0xA0, 0x4B, 0x59, 0x0B, 0x7D, 0x17, 0x55, 0x8D, 0x54, 0xD8, 0x29, 0x32, 0x0C, 0x71, 0x8D,
    0xEF, 0xB8, 0xEF, 0xAA, 0x03, 0x5A, 0x9E, 0x4C, 0xB2, 0x5C, 0xD0, 0xEE, 0x13, 0x9D, 0xFA, 0xEE,
    0x7E, 0x3B, 0xF6, 0x3F, 0x16, 0xD2, 0xEE, 0xF4, 0x55, 0x1B, 0x7D, 0x31, 0x3E, 0x24, 0x66, 0x10,
    0x72, 0xAD, 0x20, 0xA5, 0xC6, 0xDA, 0xAE, 0xBE, 0x81, 0x23, 0x95, 0xF9, 0xA2, 0xBF, 0x1D, 0xBB,
    0xAE, 0x48, 0xB3, 0xFD, 0x04, 0x75, 0x74, 0x75, 0x04, 0xFD, 0x01, 0xFF, 0x4A, 0xD2, 0xBC, 0x71,
    0xEF, 0xC0, 0x1D, 0xCE, 0x46, 0x1E, 0x13, 0x5C, 0x90, 0xD5, 0x2E, 0x3F, 0x31, 0x55, 0x51, 0xBF,
    0x58, 0x8E, 0x1D, 0x22, 0x7F, 0xEA, 0xC7, 0xA9, 0x00,
};

// https://github.com/dosei/uvk1-japanese/wiki (version 4, EC level Q)
static const uint8_t BITMAP_QR_GitHub_Wiki_Compressed[137] = {
    0x7F, 0x41, 0x5D, 0x5D, 0x5D, 0x41, 0x7F, 0x00, 0xE8, 0xA6, 0x76, 0x19, 0xFD, 0x22, 0xC8, 0x9A,
    0x78, 0x32, 0xDE, 0x18, 0x52, 0x3F, 0x59, 0x04, 0xEA, 0x00, 0x7F, 0x41, 0x5D, 0x5D, 0x5D, 0x41,
    0x7F, 0x94, 0x37, 0xA5, 0x16, 0xC0, 0x16, 0x55, 0xEA, 0x36, 0x22, 0x0D, 0xA9, 0x6E, 0x3F, 0x14,
    0x58, 0x63, 0x54, 0x7C, 0x57, 0x1F, 0x24, 0x19, 0xE7, 0xF6, 0x84, 0xBB, 0xB9, 0xC8, 0xAF, 0x44,
    0x2A, 0x6E, 0x5E, 0x66, 0x0F, 0x02, 0x3C, 0x83, 0x55, 0xDE, 0x89, 0xAD, 0x22, 0x0C, 0xBE, 0xAB,
    0xE1, 0xED, 0x70, 0xC4, 0x2A, 0xEE, 0x3B, 0x02, 0xE8, 0x76, 0x3F, 0xAC, 0xF7, 0x15, 0x48, 0xEE,
    0x04, 0x9D, 0xE6, 0xFD, 0x05, 0x75, 0x74, 0x75, 0x05, 0xFD, 0x01, 0xC3, 0xE2, 0xC7, 0x38, 0xAB,
    0x0F, 0xAA, 0xDB, 0x2A, 0x9A, 0x09, 0x66, 0x39, 0x20, 0x88, 0x7B, 0x9F, 0x71, 0x15, 0xF1, 0xFF,
    0x0D, 0x24, 0x49, 0x76, 0x7F, 0x16, 0x13, 0x1F, 0x01,
};
#endif

#ifdef ENABLE_FEAT_F4HWN_MEM
// Linker symbols (provided by the linker script)
extern uint8_t _sdata;          // Start of .data in RAM
extern uint8_t _edata;          // End of .data in RAM
extern uint8_t _sbss;           // Start of .bss in RAM
extern uint8_t _ebss;           // End of .bss in RAM

// _eflash_used is defined by the linker at the end of the final section with a
// FLASH load image. This is currently .mb_ramfunc (empty without the overlay),
// after the load images for .data and .noncacheable. It therefore gives the
// exact byte count that the linker reports as FLASH used.
extern uint8_t _eflash_used;

// Absolute symbols: their *address* IS the numeric size value (ARM/CMSIS convention).
// RAM = .data + gap + .bss + heap_reserve + stack_reserve
extern uint8_t _Min_Heap_Size;
extern uint8_t _Min_Stack_Size;

// Region sizes (must match your linker MEMORY regions)
#define RAM_SIZE_BYTES     (16u * 1024u)
#define FLASH_SIZE_BYTES   (118u * 1024u)

// Base address of FLASH — must match ORIGIN(FLASH) in your linker script
#define FLASH_BASE         (0x08002800u)

static inline uint32_t span(const void* a, const void* b)
{
    return (uint32_t)((uintptr_t)b - (uintptr_t)a);
}

static void build_usage(uint32_t* ram_used, uint32_t* flash_used)
{
    // RAM: span from start of .data to end of .bss covers .data + alignment gap + .bss.
    // Then add heap and stack reservations (absolute linker symbols: address = size).
    // Proof: (0x20002A60 - 0x20000000) + 0x200 + 0x400 = 10848 + 512 + 1024 = 12384 B ✓
    const uint32_t heap_size  = (uint32_t)(uintptr_t)&_Min_Heap_Size;
    const uint32_t stack_size = (uint32_t)(uintptr_t)&_Min_Stack_Size;
    *ram_used = span(&_sdata, &_ebss) + heap_size + stack_size;

    // FLASH: _eflash_used follows the final FLASH load image (.mb_ramfunc,
    // after the .data and .noncacheable load images).
    // Note: _etext is NOT usable here because this linker script places .rodata
    // sections AFTER _etext, making it an unreliable end-of-flash marker.
    *flash_used = span((void*)FLASH_BASE, &_eflash_used);
}

static inline uint16_t pct_x100(uint32_t used, uint32_t total)
{
    return (uint16_t)((used * 10000u) / total); // 7559 => 75.59%
}

void UI_GetMemPercents(uint16_t *flash_pct_x100, uint16_t *ram_pct_x100)
{
    uint32_t ram_used   = 0;
    uint32_t flash_used = 0;
    build_usage(&ram_used, &flash_used);
    if (flash_pct_x100) *flash_pct_x100 = pct_x100(flash_used, FLASH_SIZE_BYTES);
    if (ram_pct_x100)   *ram_pct_x100   = pct_x100(ram_used,   RAM_SIZE_BYTES);
}
#endif

#ifdef ENABLE_FEAT_F4HWN_QRCODE
// Set a single pixel at LCD-physical (x, y). y=0..7 maps to gStatusLine,
// y=8..63 maps to gFrameBuffer (line = (y-8)/8, bit = (y-8)%8).
static void QR_SetPixel(uint8_t x, uint8_t y)
{
    if (x >= 128 || y >= 64) return;
    if (y < 8) {
        gStatusLine[x] |= (uint8_t)(1u << y);
    } else {
        const uint8_t fb_y = (uint8_t)(y - 8u);
        gFrameBuffer[fb_y >> 3][x] |= (uint8_t)(1u << (fb_y & 7u));
    }
}

// Render a square QR bitmap stored in framebuffer column-major format
// (size cols × ceil(size/8) fb-lines, row-major in memory).
static void QR_Draw(const uint8_t *bitmap, uint8_t size, uint8_t origin_x, uint8_t origin_y)
{
    for (uint8_t qy = 0; qy < size; qy++) {
        for (uint8_t qx = 0; qx < size; qx++) {
            // const uint16_t idx = (uint16_t)(qy >> 3) * (uint16_t)size + (uint16_t)qx;
            // if ((bitmap[idx] >> (qy & 7u)) & 1u) {
            if (qy < 32 ?
                ((bitmap[(uint16_t)(qy >> 3) * (uint16_t)size + (uint16_t)qx] >> (qy & 7u)) & 1u) : 
                ((bitmap[132 + (qx >> 3)] >> (qx & 7u)) & 1u)) {
                QR_SetPixel((uint8_t)(origin_x + qx),
                            (uint8_t)(origin_y + qy));
            }
        }
    }
}

void UI_DrawQRCode(bool wiki, uint8_t origin_x, uint8_t origin_y)
{
//  QR_Draw(wiki ? (const uint8_t *)BITMAP_QR_GitHub_Wiki
//               : (const uint8_t *)BITMAP_QR_GitHub,
    QR_Draw(wiki ? (const uint8_t *)BITMAP_QR_GitHub_Wiki_Compressed
                 : (const uint8_t *)BITMAP_QR_GitHub_Compressed,
            33, origin_x, origin_y);
}
#endif

void UI_DisplayReleaseKeys(void)
{
    UI_StatusClear();
#if defined(ENABLE_FEAT_F4HWN_CTR) || defined(ENABLE_FEAT_F4HWN_INV)
        ST7565_ContrastAndInv();
#endif
    UI_DisplayClear();

#ifdef ENABLE_JAPANESE
    if (!UI_JaPrintText("RELEASE ALL KEYS", 0, LCD_WIDTH, 18))    // centred in pages 1-4
#endif
    {
        UI_PrintString("RELEASE", 0, 127, 1, 10);
        UI_PrintString("ALL KEYS", 0, 127, 3, 10);
    }

    ST7565_BlitStatusLine();  // blank status line
    ST7565_BlitFullScreen();
}

void UI_DisplayWelcome(void)
{
    UI_StatusClear();

#if defined(ENABLE_FEAT_F4HWN_CTR) || defined(ENABLE_FEAT_F4HWN_INV)
        ST7565_ContrastAndInv();
#endif
    UI_DisplayClear();

#ifdef ENABLE_FEAT_F4HWN
    ST7565_BlitStatusLine();
    ST7565_BlitFullScreen();

    if (gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_NONE || gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_SOUND) {
        ST7565_FillScreen(0x00);
        return;
    }
#else
    if (gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_NONE || gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_FULL_SCREEN) {
        ST7565_FillScreen(0xFF);
        return;
    }
#endif
#ifdef ENABLE_FEAT_F4HWN_LOGO
    else if (gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_LOGO) {
        UI_LoadLogo();
    }
#endif
    else {
        char WelcomeString0[17];
        char WelcomeString1[17];
        char WelcomeString2[16];
        char WelcomeString3[32];

        // 0x0EB0
        PY25Q16_ReadBuffer(SETTINGS_BOOT_MESSAGE_LINE1_ADDR, WelcomeString0, 16);
        WelcomeString0[16] = '\0';
        // 0x0EC0
        PY25Q16_ReadBuffer(SETTINGS_BOOT_MESSAGE_LINE2_ADDR, WelcomeString1, 16);
        WelcomeString1[16] = '\0';

        sprintf(WelcomeString2, "%u.%02uV %u%%",
                gBatteryVoltageAverage / 100,
                gBatteryVoltageAverage % 100,
                BATTERY_VoltsToPercent(gBatteryVoltageAverage));

#ifdef ENABLE_JAPANESE
        // Only the built-in texts are translated, never a boot message the user set
        const uint8_t mode = gEeprom.POWER_ON_DISPLAY_MODE;
        const bool builtin0 = mode == POWER_ON_DISPLAY_MODE_VOLTAGE
            || (WelcomeString0[0] == '\0' && (mode == POWER_ON_DISPLAY_MODE_MESSAGE
                || (mode == POWER_ON_DISPLAY_MODE_ALL && WelcomeString1[0] == '\0')));
        const bool builtin1 = mode == POWER_ON_DISPLAY_MODE_MESSAGE && WelcomeString1[0] == '\0';
#endif

        if (gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_VOLTAGE)
        {
            strcpy(WelcomeString0, "VOLTAGE");
            strcpy(WelcomeString1, WelcomeString2);
        }
        else if(gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_ALL)
        {
            if(strlen(WelcomeString0) == 0 && strlen(WelcomeString1) == 0)
            {
                strcpy(WelcomeString0, "WELCOME");
                strcpy(WelcomeString1, WelcomeString2);
            }
            else if(strlen(WelcomeString0) == 0 || strlen(WelcomeString1) == 0)
            {
                if(strlen(WelcomeString0) == 0)
                {
                    strcpy(WelcomeString0, WelcomeString1);
                }
                strcpy(WelcomeString1, WelcomeString2);
            }
        }
        else if(gEeprom.POWER_ON_DISPLAY_MODE == POWER_ON_DISPLAY_MODE_MESSAGE)
        {
            if(strlen(WelcomeString0) == 0)
            {
                strcpy(WelcomeString0, "WELCOME");
            }

            if(strlen(WelcomeString1) == 0)
            {
                strcpy(WelcomeString1, "BIENVENUE");
            }
        }

#ifdef ENABLE_JAPANESE
        const bool ja0 = builtin0 && UI_JaPrintText(WelcomeString0, 0, LCD_WIDTH, 2);  // pages 0-1
        if (!ja0)
#endif
            UI_PrintString(WelcomeString0, 0, 127, 0, 10);
#ifdef ENABLE_JAPANESE
        // BIENVENUE is WELCOME again, in French: leave the line empty
        if (!(builtin1 && ja0))
#endif
            UI_PrintString(WelcomeString1, 0, 127, 2, 10);

#ifdef ENABLE_FEAT_F4HWN
        const size_t version_width = strlen(DisplayVersion) * (ARRAY_SIZE(gFontSmall[0]) + 1u);
        const uint8_t version_x = version_width < LCD_WIDTH
            ? (uint8_t)((LCD_WIDTH - version_width + 1u) / 2u)
            : 0u;
        const uint8_t capsule_left = version_x > 2u ? (uint8_t)(version_x - 3u) : 0u;
        const size_t capsule_right_candidate = version_x + version_width + 2u;
        const uint8_t capsule_right = capsule_right_candidate < LCD_WIDTH
            ? (uint8_t)capsule_right_candidate
            : (LCD_WIDTH - 1u);

        UI_PrintStringSmallNormal(DisplayVersion, version_x, 0, 4);

        if (capsule_left > 0u)
        {
            UI_DrawLineBuffer(gFrameBuffer, 0, 35, capsule_left - 1u, 35, 1);
        }
        gFrameBuffer[4][capsule_left] ^= 0x7F;
        for (uint8_t x = capsule_left + 1u; x < capsule_right; x++)
        {
            gFrameBuffer[4][x] ^= 0xFF;
            gFrameBuffer[3][x] ^= 0x80;
        }
        gFrameBuffer[4][capsule_right] ^= 0x7F;
        if (capsule_right < LCD_WIDTH - 1u)
        {
            UI_DrawLineBuffer(gFrameBuffer, capsule_right + 1u, 35, LCD_WIDTH - 1u, 35, 1);
        }

        /*
        #ifdef ENABLE_FEAT_F4HWN_MEM
            uint32_t ram_used   = 0;
            uint32_t flash_used = 0;
            build_usage(&ram_used, &flash_used);

            const uint16_t ram_pct   = pct_x100(ram_used,   RAM_SIZE_BYTES);
            const uint16_t flash_pct = pct_x100(flash_used, FLASH_SIZE_BYTES);

            // No floats: 7559 => 75.59%
            sprintf(WelcomeString3,
            "FLASH %u.%02u %% - SRAM  %u.%02u %%",
            (unsigned)(flash_pct / 100), (unsigned)(flash_pct % 100),
            (unsigned)(ram_pct / 100),   (unsigned)(ram_pct % 100));

            GUI_DisplaySmallest(WelcomeString3, 5, 1, true, true);
            ST7565_BlitStatusLine();
        #endif
        */

#ifdef RXJA_VERSION_STRING
        // the upstream release this build is based on
    #ifdef ENABLE_JAPANESE
        static const char base[] = "base";
        const char *base_ja = UI_JaText(base);
        snprintf(WelcomeString3, sizeof(WelcomeString3), "%s %s %s",
                 AUTHOR_STRING_2, DISPLAY_VERSION_STRING_2, base_ja);
        if (base_ja != base)
            UI_JaPrint(WelcomeString3, 0, LCD_WIDTH, 44);  // ASCII lands on page 6
        else
    #else
        sprintf(WelcomeString3, "%s %s base", AUTHOR_STRING_2, DISPLAY_VERSION_STRING_2);
    #endif
            UI_PrintStringSmallNormal(WelcomeString3, 0, 127, 6);
#else
        sprintf(WelcomeString3, "%s Edition", Edition);
        UI_PrintStringSmallNormal(WelcomeString3, 0, 127, 6);
#endif

#else
        UI_PrintStringSmallNormal(Version, 0, 127, 6);
#endif
    }

    ST7565_BlitStatusLine();
    ST7565_BlitFullScreen();

    #ifdef ENABLE_FEAT_F4HWN_K5VIEWER
        K5VIEWER_Update(true);
    #endif
}
