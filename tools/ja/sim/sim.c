/* Host-side check of App/ui/ja.c: the real renderer, string lookup and fonts
 * draw into a frame buffer, SPI reads come from the resource image, output is
 * a PGM of the whole 128x64 LCD.
 * usage: sim <ja_res.bin|-> <out.pgm> <cmd> ...   ("-" = erased SPI flash)
 *   p Y X0 X1 TEXT    UI_JaPrint(TEXT, X0, X1, Y)
 *   t Y X0 X1 KEY     UI_JaPrint(UI_JaText(KEY), X0, X1, Y)
 *   V MENU X0 X1 BOTTOM VALUE
 *                     UI_JaPrintValue (menu value column; MENU "-" = NULL,
 *                     "\n" in VALUE = line break); prints "miss" if untranslated
 *   i X0 X1 Y0 Y1     UI_JaInvert
 *   b LINE X0 X1 TEXT UI_PrintString (8x16 ASCII, as the menu value column)
 *   B LINE X0 X1 W TEXT
 *                     same with a character pitch of W px (UI_PrintString's Width)
 *   v X               vertical line over the 56 px area (menu separator)
 *   d X1              dotted line on row 46 for x < X1 (menu index divider)
 *   s LINE X0 X1 TEXT UI_PrintStringSmallNormal (6x8 ASCII)
 *   S X Y TEXT        GUI_DisplaySmallest (3x5 ASCII) at pixel row Y; Y < 0 = status line
 *   x PAGE X0 X1 MASK XOR MASK into gFrameBuffer[PAGE][X0..X1] (capsules, inverse)
 *   c X0 X1 Y0 Y1     clear pixels X0..X1 x Y0..Y1 (inclusive)
 * Y is a pixel row of gFrameBuffer (0 = first row below the status line). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/py25q16.h"
#include "driver/st7565.h"
#include "font.h"
#include "ui/ja.h"

uint8_t gStatusLine[LCD_WIDTH];
uint8_t gFrameBuffer[FRAME_LINES][LCD_WIDTH];

static uint8_t *img;
static long     img_len;
unsigned        spi_reads;

void PY25Q16_ReadBuffer(uint32_t Address, void *pBuffer, uint32_t Size)
{
    spi_reads++;
    for (uint32_t i = 0; i < Size; i++) {
        long o = (long)(Address + i) - JA_FLASH_BASE;
        ((uint8_t *)pBuffer)[i] = (img && o >= 0 && o < img_len) ? img[o] : 0xFF;
    }
}

// same as App/ui/helper.c
static void PrintBig(const char *s, unsigned Start, unsigned End, unsigned Line, unsigned Width)
{
    size_t len = strlen(s);
    if (End > Start)
        Start += (((End - Start) - (len * Width)) + 1) / 2;
    for (size_t i = 0; i < len; i++)
        if (s[i] > ' ' && s[i] < 127) {
            memcpy(gFrameBuffer[Line + 0] + Start + i * Width, &gFontBig[s[i] - ' ' - 1][0], 7);
            memcpy(gFrameBuffer[Line + 1] + Start + i * Width, &gFontBig[s[i] - ' ' - 1][7], 7);
        }
}

// same as App/ui/helper.c
static void PrintSmall(const char *s, unsigned Start, unsigned End, unsigned Line)
{
    size_t len = strlen(s);
    if (End > Start)
        Start += (((End - Start) - len * 7) + 1) / 2;
    for (size_t i = 0; i < len; i++)
        if (s[i] > ' ' && s[i] < 127 && Start + i * 7 + 6 <= LCD_WIDTH)
            memcpy(gFrameBuffer[Line] + Start + i * 7, &gFontSmall[s[i] - ' ' - 1][0], 6);
}

static void PrintSmallest(const char *s, int x, int y)
{
    for (; *s; s++, x += 4)
        for (int i = 0; i < 3; i++) {
            uint8_t px = gFont3x5[*s - 0x20][i];
            for (int j = 0; j < 6; j++, px >>= 1)
                if ((px & 1) && x + i < LCD_WIDTH) {
                    if (y < 0)
                        gStatusLine[x + i] |= 1u << (y + 8 + j);
                    else
                        gFrameBuffer[(y + j) / 8][x + i] |= 1u << ((y + j) % 8);
                }
        }
}

int main(int argc, char **argv)
{
    if (argc < 3) return 2;
    if (strcmp(argv[1], "-")) {
        FILE *f = fopen(argv[1], "rb");
        if (!f) { perror(argv[1]); return 1; }
        fseek(f, 0, SEEK_END); img_len = ftell(f); rewind(f);
        img = malloc(img_len);
        if (fread(img, 1, img_len, f) != (size_t)img_len) return 1;
        fclose(f);
    }
    printf("ready=%d\n", UI_JaReady());

    char **a = argv + 3, **end = argv + argc;
#define NEED(n) if (end - a < (n) + 1) { fprintf(stderr, "%s: needs %d args\n", *a, n); return 2; }
    while (a < end) {
        unsigned before = spi_reads;
        switch (a[0][0]) {
        case 'p': case 't': {
            NEED(4);
            const char *s = a[0][0] == 't' ? UI_JaText(a[4]) : a[4];
            uint8_t x = UI_JaPrint(s, atoi(a[2]), atoi(a[3]), atoi(a[1]));
            printf("%c y=%-2s width=%3u end=%3u spi_reads=%-3u %s%s%s\n", a[0][0], a[1], UI_JaWidth(s),
                   x, spi_reads - before, a[4], s == a[4] ? "" : " -> ", s == a[4] ? "" : s);
            a += 5;
            break;
        }
        case 'V': {
            NEED(5);
            char v[64], *o = v;
            for (const char *q = a[5]; *q && o < v + sizeof(v) - 1; q++)
                if (q[0] == '\\' && q[1] == 'n') { *o++ = '\n'; q++; } else *o++ = *q;
            *o = '\0';
            const char *menu = strcmp(a[1], "-") ? a[1] : NULL;
            bool ok = UI_JaPrintValue(menu, v, atoi(a[2]), atoi(a[3]), atoi(a[4]));
            printf("V %s|%s bottom=%s %s spi_reads=%u\n", a[1], a[5], a[4], ok ? "ok" : "miss",
                   spi_reads - before);
            a += 6;
            break;
        }
        case 'i':
            NEED(4);
            UI_JaInvert(atoi(a[1]), atoi(a[2]), atoi(a[3]), atoi(a[4]));
            a += 5;
            break;
        case 'b':
            NEED(4);
            PrintBig(a[4], atoi(a[2]), atoi(a[3]), atoi(a[1]), 8);
            a += 5;
            break;
        case 'B':
            NEED(5);
            PrintBig(a[5], atoi(a[2]), atoi(a[3]), atoi(a[1]), atoi(a[4]));
            a += 6;
            break;
        case 'v':
            NEED(1);
            for (int p = 0; p < FRAME_LINES; p++) gFrameBuffer[p][atoi(a[1])] = 0xFF;
            a += 2;
            break;
        case 'd':
            NEED(1);
            for (int x = 0; x < atoi(a[1]); x += 2) gFrameBuffer[5][x] = 0x40;
            a += 2;
            break;
        case 's':
            NEED(4);
            PrintSmall(a[4], atoi(a[2]), atoi(a[3]), atoi(a[1]));
            a += 5;
            break;
        case 'S':
            NEED(3);
            PrintSmallest(a[3], atoi(a[1]), atoi(a[2]));
            a += 4;
            break;
        case 'c':
            NEED(4);
            for (int y = atoi(a[3]); y <= atoi(a[4]); y++)
                for (int x = atoi(a[1]); x <= atoi(a[2]); x++)
                    gFrameBuffer[y >> 3][x] &= (uint8_t)~(1u << (y & 7));
            a += 5;
            break;
        case 'x':
            NEED(4);
            for (int x = atoi(a[2]); x <= atoi(a[3]); x++)
                (atoi(a[1]) < 0 ? gStatusLine : gFrameBuffer[atoi(a[1])])[x] ^= (uint8_t)strtol(a[4], NULL, 0);
            a += 5;
            break;
        default:
            fprintf(stderr, "unknown command %s\n", *a);
            return 2;
        }
    }

    FILE *o = fopen(argv[2], "wb");
    fprintf(o, "P5 %d %d 1\n", LCD_WIDTH, LCD_HEIGHT);
    for (int y = 0; y < LCD_HEIGHT; y++)
        for (int x = 0; x < LCD_WIDTH; x++) {
            int on = y < 8 ? (gStatusLine[x] >> y & 1) : (gFrameBuffer[(y - 8) / 8][x] >> ((y - 8) % 8) & 1);
            fputc(!on, o);
        }
    fclose(o);
    return 0;
}
