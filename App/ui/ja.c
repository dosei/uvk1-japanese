/* Japanese text rendering (ENABLE_JAPANESE), see ja.h */

#include <string.h>

#include "driver/py25q16.h"
#include "driver/st7565.h"
#include "font.h"
#include "misc.h"
#include "ui/ja.h"

#define JA_HDR_SIZE     12u
#define JA_MAGIC        "JF03"  // withdrawn test builds used "JF12" at 0x0C0000, see ja.h
#define JA_VERSION      3u
#define JA_GLYPH_BYTES  18u     // 12 columns x 12 bits packed LSB first, bit 0 = top row

#define ASCII_WIDTH     7u      // gFontSmall 6 px + 1 px gap
#define ASCII_DY        4u      // drop 7 px ASCII onto the 12 px baseline
#define WIDE_WIDTH      12u     // glyph cell already includes its gap
#define HALF_WIDTH      6u      // half-width katakana, likewise

#define CP_HALF_FIRST   0xFF61u // U+FF61..U+FF9F: glyph columns 6..11 are empty
#define CP_HALF_LAST    0xFF9Fu

#define CP_GETA         0x3013u // shown for anything missing from the font

static uint16_t gJaCount = 0xFFFF;  // glyphs in the image; 0xFFFF = not read yet
static uint32_t gJaTextOff;         // UI string table, 0 = none
static uint16_t gJaTextCount;
static char     gJaText[JA_TEXT_MAX];
#ifdef ENABLE_RXJA_PRESET
static uint32_t gJaPresetOff;       // preset table, 0 = none
static uint16_t gJaPresetCount;
static uint16_t gJaPresetSize;      // record size in the image
#endif

bool UI_JaReady(void)
{
    if (gJaCount == 0xFFFF)
    {
        uint8_t hdr[JA_HDR_SIZE];
        PY25Q16_ReadBuffer(JA_FLASH_BASE, hdr, sizeof(hdr));
        const uint16_t version = hdr[6] | (hdr[7] << 8);
        gJaCount = (memcmp(hdr, JA_MAGIC, 4) == 0 && version == JA_VERSION)
                 ? (uint16_t)(hdr[4] | (hdr[5] << 8)) : 0;
        if (gJaCount == 0xFFFF)     // erased flash reads as FF, never valid
            gJaCount = 0;

        gJaTextOff   = 0;
        gJaTextCount = 0;
#ifdef ENABLE_RXJA_PRESET
        gJaPresetOff   = 0;
        gJaPresetCount = 0;
#endif
        if (gJaCount)
        {
            uint16_t n[2] = {0, 0};     // count, pad (= preset table offset / 4)
            memcpy(&gJaTextOff, hdr + 8, 4);
            if (gJaTextOff && gJaTextOff < JA_FLASH_SIZE)
                PY25Q16_ReadBuffer(JA_FLASH_BASE + gJaTextOff, n, sizeof(n));
            gJaTextCount = (n[0] == 0xFFFF) ? 0 : n[0];
#ifdef ENABLE_RXJA_PRESET
            if (gJaTextCount && n[1] && n[1] != 0xFFFF)
            {
                const uint32_t off = gJaTextOff + n[1] * 4u;
                uint16_t       p[2];
                if (off + sizeof(p) <= JA_FLASH_SIZE)
                {
                    PY25Q16_ReadBuffer(JA_FLASH_BASE + off, p, sizeof(p));
                    if (p[0] != 0xFFFF && p[1] >= sizeof(JA_Preset_t) &&
                        off + sizeof(p) + (uint32_t)p[0] * p[1] <= JA_FLASH_SIZE)
                    {
                        gJaPresetOff   = off;
                        gJaPresetCount = p[0];
                        gJaPresetSize  = p[1];
                    }
                }
            }
#endif
        }
    }
    return gJaCount != 0;
}

void UI_JaInvalidate(void)
{
    gJaCount = 0xFFFF;
}

// FNV-1a, must match tools/ja/gen_ja_font.py
static uint32_t Hash(const char *s)
{
    uint32_t h = 2166136261u;
    while (*s)
        h = (h ^ (uint8_t)*s++) * 16777619u;
    return h;
}

const char *UI_JaText(const char *pEnglish)
{
    if (!UI_JaReady() || !gJaTextCount)
        return pEnglish;

    // table: u16 count, u16 pad, u32 hash[count] ascending, u16 offset[count], strings
    const uint32_t hashes = JA_FLASH_BASE + gJaTextOff + 4u;
    const uint32_t key    = Hash(pEnglish);
    uint16_t       lo     = 0;
    uint16_t       hi     = gJaTextCount;

    while (lo < hi)
    {
        const uint16_t mid = (lo + hi) / 2;
        uint32_t       v;
        PY25Q16_ReadBuffer(hashes + mid * 4u, &v, 4);
        if (v == key)
        {
            uint16_t off;
            PY25Q16_ReadBuffer(hashes + gJaTextCount * 4u + mid * 2u, &off, 2);
            PY25Q16_ReadBuffer(hashes + gJaTextCount * 6u + off, gJaText, sizeof(gJaText) - 1);
            gJaText[sizeof(gJaText) - 1] = '\0';
            return gJaText;
        }
        if (v < key)
            lo = mid + 1;
        else
            hi = mid;
    }
    return pEnglish;
}

void UI_JaInvert(uint8_t Start, uint8_t End, uint8_t y0, uint8_t y1)
{
    for (uint8_t y = y0; y < y1 && (y >> 3) < FRAME_LINES; y++)
    {
        const uint8_t bit = 1u << (y & 7);
        for (uint8_t x = Start; x < End; x++)
            gFrameBuffer[y >> 3][x] ^= bit;
    }
}

// Decode one UTF-8 character and advance *pp. Only the BMP is supported;
// longer or broken sequences come back as CP_GETA.
static uint16_t NextCodePoint(const char **pp)
{
    const uint8_t *s = (const uint8_t *)*pp;
    uint16_t       c = s[0];

    if (c < 0x80)
    {
        *pp += 1;
        return c;
    }
    if ((c & 0xE0) == 0xC0 && (s[1] & 0xC0) == 0x80)
    {
        *pp += 2;
        return ((c & 0x1F) << 6) | (s[1] & 0x3F);
    }
    if ((c & 0xF0) == 0xE0 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80)
    {
        *pp += 3;
        return ((c & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F);
    }

    // skip the lead byte and whatever continuation bytes follow it
    s++;
    while ((*s & 0xC0) == 0x80)
        s++;
    *pp = (const char *)s;
    return CP_GETA;
}

static uint8_t CharWidth(uint16_t cp)
{
    if (cp < 0x80)
        return ASCII_WIDTH;
    return (cp >= CP_HALF_FIRST && cp <= CP_HALF_LAST) ? HALF_WIDTH : WIDE_WIDTH;
}

// glyph index of cp in the SPI image, or -1
static int16_t FindGlyph(uint16_t cp)
{
    uint16_t lo = 0;
    uint16_t hi = gJaCount;

    while (lo < hi)
    {
        const uint16_t mid = (lo + hi) / 2;
        uint16_t       v;
        PY25Q16_ReadBuffer(JA_FLASH_BASE + JA_HDR_SIZE + mid * 2u, &v, 2);
        if (v == cp)
            return (int16_t)mid;
        if (v < cp)
            lo = mid + 1;
        else
            hi = mid;
    }
    return -1;
}

// OR one pixel column (bit 0 = top) into the frame buffer at pixel row y
static void DrawColumn(uint8_t x, uint8_t y, uint32_t bits)
{
    uint8_t page = y >> 3;
    bits <<= (y & 7);
    for (; bits && page < FRAME_LINES; page++, bits >>= 8)
        gFrameBuffer[page][x] |= (uint8_t)bits;
}

uint8_t UI_JaWidth(const char *pString)
{
    unsigned width = 0;
    while (*pString)
        width += CharWidth(NextCodePoint(&pString));
    return (width > 255) ? 255 : (uint8_t)width;
}

uint8_t UI_JaPrint(const char *pString, uint8_t Start, uint8_t End, uint8_t y)
{
    unsigned x     = Start;
    unsigned limit = LCD_WIDTH;

    if (End > Start)
    {
        const uint8_t width = UI_JaWidth(pString);
        if (width < End - Start)
            x += (End - Start - width) / 2;
        limit = End;
    }

    const bool ready = UI_JaReady();

    while (*pString)
    {
        const uint16_t cp = NextCodePoint(&pString);
        const uint8_t  w  = CharWidth(cp);

        if (x + w > limit)
            break;

        if (cp < 0x80)
        {
            if (cp > ' ' && cp < 127)
            {
                const uint8_t *glyph = gFontSmall[cp - ' ' - 1];
                for (uint8_t i = 0; i < ARRAY_SIZE(gFontSmall[0]); i++)
                    DrawColumn(x + i, y + ASCII_DY, glyph[i]);
            }
        }
        else if (ready)
        {
            int16_t idx = FindGlyph(cp);
            if (idx < 0)
                idx = FindGlyph(CP_GETA);
            if (idx >= 0)
            {
                uint8_t g[JA_GLYPH_BYTES];
                PY25Q16_ReadBuffer(JA_FLASH_BASE + JA_HDR_SIZE + gJaCount * 2u + idx * JA_GLYPH_BYTES,
                                   g, sizeof(g));
                for (uint8_t i = 0; i < w; i++)
                {
                    const uint8_t *p = g + i + (i >> 1);    // column i starts at bit 12 * i
                    DrawColumn(x + i, y, ((p[0] | (p[1] << 8)) >> ((i & 1) * 4)) & 0xFFFu);
                }
            }
        }

        x += w;
    }

    return (uint8_t)x;
}

bool UI_JaPrintText(const char *pEnglish, uint8_t Start, uint8_t End, uint8_t y)
{
    const char *t = UI_JaText(pEnglish);
    if (t == pEnglish)
        return false;
    UI_JaPrint(t, Start, End, y);
    return true;
}

const char *UI_JaValue(const char *pMenu, const char *pValue)
{
    char key[JA_TEXT_MAX];
    const char *t;

    if (pMenu && strlen(pMenu) + 1 + strlen(pValue) < sizeof(key))
    {
        strcpy(key, pMenu);
        strcat(key, "|");
        strcat(key, pValue);
        t = UI_JaText(key);
        if (t != key)
            return t;
    }
    t = UI_JaText(pValue);
    return (t != pValue) ? t : NULL;
}

bool UI_JaPrintValue(const char *pMenu, const char *pValue, uint8_t Start, uint8_t End, uint8_t Bottom)
{
    char out[64];
    const char *t = UI_JaValue(pMenu, pValue);

    if (t)
        strcpy(out, t);
    else
    {   // "CARRIER\n00s:250ms": translate the word, keep the numbers
        const char *nl = strchr(pValue, '\n');
        if (!nl || (size_t)(nl - pValue) >= JA_TEXT_MAX)
            return false;
        memcpy(out, pValue, nl - pValue);
        out[nl - pValue] = '\0';
        t = UI_JaValue(pMenu, out);
        if (!t || strlen(t) + strlen(nl) >= sizeof(out))
            return false;
        strcpy(out, t);
        strcat(out, nl);
    }

    uint8_t lines = 1;
    for (const char *p = out; *p; p++)
        if (*p == '\n')
            lines++;
    if (lines > 4)
        lines = 4;
    // Like the 8x16 English values: page 0 stays empty, and one or two lines
    // keep clear of page 5 (confirmation, gauge, badge).
    if (lines <= 2 && Bottom > 40)
        Bottom = 40;
    const uint8_t h = JA_VALUE_PITCH * lines - 2;
    uint8_t top = 8;
    if (h > Bottom - top)
        top = 0;
    uint8_t y = (Bottom > top + h) ? top + (Bottom - top - h) / 2 : top;
    for (char *s = out; lines > 0; lines--)
    {
        char *nl = strchr(s, '\n');
        if (nl)
            *nl = '\0';
        UI_JaPrint(s, Start, End, y);
        if (!nl)
            break;
        s = nl + 1;
        y += JA_VALUE_PITCH;
    }
    return true;
}

#ifdef ENABLE_RXJA_PRESET
uint16_t UI_JaPresetCount(void)
{
    return UI_JaReady() ? gJaPresetCount : 0;
}

bool UI_JaPreset(uint16_t index, JA_Preset_t *pPreset)
{
    if (index >= UI_JaPresetCount())
        return false;
    PY25Q16_ReadBuffer(JA_FLASH_BASE + gJaPresetOff + 4u + (uint32_t)index * gJaPresetSize,
                       pPreset, sizeof(*pPreset));
    pPreset->name[JA_PRESET_NAME - 1] = '\0';
    return true;
}
#endif
