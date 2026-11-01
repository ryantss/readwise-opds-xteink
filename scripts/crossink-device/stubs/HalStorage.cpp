#include "HalStorage.h"

#include "ff.h"

#include <cstdio>
#include <cstring>
#include <string>

extern "C" int fat_disk_bind(FILE* image, uint64_t bytes);

struct FatFil {
  FIL fil{};
};

namespace {
FILE* gImageFile = nullptr;
FATFS gFs{};
bool gMounted = false;

std::string fatPath(const char* path) {
  if (!path || path[0] == '\0') return "/";
  return path;
}

BYTE fatMode(const oflag_t oflag) {
  BYTE mode = 0;
  if (oflag & O_APPEND) return FA_WRITE | FA_OPEN_APPEND;
  if (oflag & (O_CREAT | O_TRUNC)) return FA_WRITE | FA_CREATE_ALWAYS;
  if (oflag & O_WRONLY) return FA_WRITE | FA_OPEN_EXISTING;
  if (oflag & O_RDWR) return FA_READ | FA_WRITE | FA_OPEN_EXISTING;
  return FA_READ | FA_OPEN_EXISTING;
}
}  // namespace

HalFile::HalFile() = default;
HalFile::~HalFile() { close(); }
HalFile::HalFile(HalFile&& other) noexcept : fil_(std::move(other.fil_)) {}

HalFile& HalFile::operator=(HalFile&& other) noexcept {
  if (this != &other) {
    close();
    fil_ = std::move(other.fil_);
  }
  return *this;
}

bool HalFile::isOpen() const { return static_cast<bool>(fil_); }

bool HalFile::close() {
  if (!fil_) return true;
  const FRESULT rc = f_close(&fil_->fil);
  fil_.reset();
  return rc == FR_OK;
}

bool HalFile::seek(const size_t pos) { return fil_ && f_lseek(&fil_->fil, pos) == FR_OK; }

bool HalFile::seekCur(const int64_t offset) {
  if (!fil_) return false;
  const auto next = static_cast<FSIZE_t>(static_cast<int64_t>(f_tell(&fil_->fil)) + offset);
  return f_lseek(&fil_->fil, next) == FR_OK;
}

size_t HalFile::position() const { return fil_ ? static_cast<size_t>(f_tell(&fil_->fil)) : 0; }

size_t HalFile::size() { return fil_ ? static_cast<size_t>(f_size(&fil_->fil)) : 0; }

int HalFile::available() const {
  if (!fil_) return 0;
  const FSIZE_t remaining = f_size(&fil_->fil) - f_tell(&fil_->fil);
  return remaining > 0 ? static_cast<int>(remaining) : 0;
}

int HalFile::read(void* buf, const size_t count) {
  if (!fil_ || !buf) return -1;
  UINT got = 0;
  if (f_read(&fil_->fil, buf, static_cast<UINT>(count), &got) != FR_OK) return -1;
  return static_cast<int>(got);
}

int HalFile::read() {
  uint8_t b = 0;
  return this->read(&b, 1) == 1 ? b : -1;
}

size_t HalFile::write(const void* buf, const size_t count) {
  if (!fil_ || !buf) return 0;
  UINT put = 0;
  if (f_write(&fil_->fil, buf, static_cast<UINT>(count), &put) != FR_OK) return 0;
  return put;
}

bool HalFile::sync() { return fil_ && f_sync(&fil_->fil) == FR_OK; }

HalStorage& HalStorage::getInstance() {
  static HalStorage storage;
  return storage;
}

bool HalStorage::mountImage(const char* imagePath, const uint64_t bytes) {
  unmount();
  if (!imagePath || bytes < 512) return false;
  gImageFile = std::fopen(imagePath, "w+b");
  if (!gImageFile) return false;
  if (std::fseek(gImageFile, static_cast<long>(bytes - 1), SEEK_SET) != 0 || std::fputc(0, gImageFile) == EOF) {
    unmount();
    return false;
  }
  std::fflush(gImageFile);
  if (fat_disk_bind(gImageFile, bytes) != 0) {
    unmount();
    return false;
  }

  BYTE work[4096];
  MKFS_PARM opt = {FM_FAT32, 0, 0, 0, 0};
  FRESULT mk = f_mkfs("", &opt, work, sizeof(work));
  if (mk != FR_OK) {
    opt.fmt = FM_FAT;
    mk = f_mkfs("", &opt, work, sizeof(work));
  }
  if (mk != FR_OK) {
    std::fprintf(stderr, "[ERR] FAT: f_mkfs failed (%d)\n", static_cast<int>(mk));
    unmount();
    return false;
  }
  if (f_mount(&gFs, "", 1) != FR_OK) {
    std::fprintf(stderr, "[ERR] FAT: f_mount failed\n");
    unmount();
    return false;
  }
  gMounted = true;
  ready_ = true;
  imageBytes_ = bytes;
  return true;
}

void HalStorage::unmount() {
  if (gMounted) {
    f_mount(nullptr, "", 0);
    gMounted = false;
  }
  if (gImageFile) {
    std::fclose(gImageFile);
    gImageFile = nullptr;
  }
  fat_disk_bind(nullptr, 0);
  ready_ = false;
  imageBytes_ = 0;
}

uint64_t HalStorage::totalBytes() const { return imageBytes_; }

uint64_t HalStorage::usedBytes() {
  if (!gMounted) return 0;
  DWORD freeClusters = 0;
  FATFS* fs = nullptr;
  if (f_getfree("", &freeClusters, &fs) != FR_OK || !fs) return 0;
  const uint64_t clusterBytes = static_cast<uint64_t>(fs->csize) * 512ull;
  const uint64_t total = static_cast<uint64_t>(fs->n_fatent - 2) * clusterBytes;
  const uint64_t freeBytes = static_cast<uint64_t>(freeClusters) * clusterBytes;
  return total > freeBytes ? total - freeBytes : 0;
}

bool HalStorage::mkdir(const char* path, const bool pFlag) {
  if (!path || path[0] == '\0' || std::strcmp(path, "/") == 0) return true;
  std::string current;
  const std::string full = fatPath(path);
  for (size_t i = 0; i < full.size(); ++i) {
    current.push_back(full[i]);
    if ((i + 1 == full.size() || full[i + 1] == '/') && current != "/") {
      const FRESULT rc = f_mkdir(current.c_str());
      if (rc != FR_OK && rc != FR_EXIST) return false;
      if (!pFlag && i + 1 != full.size()) return false;
    }
  }
  return true;
}

bool HalStorage::exists(const char* path) {
  FILINFO info{};
  return path && f_stat(fatPath(path).c_str(), &info) == FR_OK;
}

bool HalStorage::remove(const char* path) { return path && f_unlink(fatPath(path).c_str()) == FR_OK; }

bool HalStorage::rename(const char* oldPath, const char* newPath) {
  return oldPath && newPath && f_rename(fatPath(oldPath).c_str(), fatPath(newPath).c_str()) == FR_OK;
}

bool HalStorage::openFileForRead(const char*, const char* path, HalFile& file) {
  file.close();
  auto fil = std::make_unique<FatFil>();
  if (f_open(&fil->fil, fatPath(path).c_str(), FA_READ | FA_OPEN_EXISTING) != FR_OK) return false;
  file.fil_ = std::move(fil);
  return true;
}

bool HalStorage::openFileForWrite(const char*, const char* path, HalFile& file) {
  file.close();
  auto fil = std::make_unique<FatFil>();
  if (f_open(&fil->fil, fatPath(path).c_str(), FA_WRITE | FA_CREATE_ALWAYS) != FR_OK) return false;
  file.fil_ = std::move(fil);
  return true;
}

HalFile HalStorage::open(const char* path, const oflag_t oflag) {
  HalFile file;
  auto fil = std::make_unique<FatFil>();
  if (f_open(&fil->fil, fatPath(path).c_str(), fatMode(oflag)) != FR_OK) return {};
  file.fil_ = std::move(fil);
  return file;
}

bool fatImageOpen(const char* path, const uint64_t bytes) { return Storage.mountImage(path, bytes); }
void fatImageClose() { Storage.unmount(); }
uint64_t fatImageBytes() { return Storage.totalBytes(); }
