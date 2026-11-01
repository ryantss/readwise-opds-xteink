#include "ff.h"
#include "diskio.h"

#include <stdio.h>
#include <string.h>

enum { kSectorSize = 512 };

static FILE* gImage;
static uint64_t gBytes;

int fat_disk_bind(FILE* image, uint64_t bytes) {
  gImage = image;
  gBytes = bytes;
  return image && bytes >= kSectorSize ? 0 : -1;
}

DSTATUS disk_status(BYTE pdrv) {
  (void)pdrv;
  return gImage ? 0 : STA_NOINIT;
}

DSTATUS disk_initialize(BYTE pdrv) {
  (void)pdrv;
  return gImage ? 0 : STA_NOINIT;
}

DRESULT disk_read(BYTE pdrv, BYTE* buff, LBA_t sector, UINT count) {
  (void)pdrv;
  if (!gImage || !buff) return RES_NOTRDY;
  const uint64_t offset = (uint64_t)sector * kSectorSize;
  const size_t want = (size_t)count * kSectorSize;
  if (offset + want > gBytes) return RES_PARERR;
  if (fseeko(gImage, (off_t)offset, SEEK_SET) != 0) return RES_ERROR;
  return fread(buff, 1, want, gImage) == want ? RES_OK : RES_ERROR;
}

DRESULT disk_write(BYTE pdrv, const BYTE* buff, LBA_t sector, UINT count) {
  (void)pdrv;
  if (!gImage || !buff) return RES_NOTRDY;
  const uint64_t offset = (uint64_t)sector * kSectorSize;
  const size_t want = (size_t)count * kSectorSize;
  if (offset + want > gBytes) return RES_PARERR;
  if (fseeko(gImage, (off_t)offset, SEEK_SET) != 0) return RES_ERROR;
  if (fwrite(buff, 1, want, gImage) != want) return RES_ERROR;
  return RES_OK;
}

DRESULT disk_ioctl(BYTE pdrv, BYTE cmd, void* buff) {
  (void)pdrv;
  switch (cmd) {
    case CTRL_SYNC:
      return gImage && fflush(gImage) == 0 ? RES_OK : RES_ERROR;
    case GET_SECTOR_COUNT:
      if (!buff || gBytes < kSectorSize) return RES_PARERR;
      *(LBA_t*)buff = (LBA_t)(gBytes / kSectorSize);
      return RES_OK;
    case GET_SECTOR_SIZE:
      if (!buff) return RES_PARERR;
      *(WORD*)buff = kSectorSize;
      return RES_OK;
    case GET_BLOCK_SIZE:
      if (!buff) return RES_PARERR;
      *(DWORD*)buff = 1;
      return RES_OK;
    default:
      return RES_PARERR;
  }
}
