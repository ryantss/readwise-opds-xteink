#pragma once

#include <Print.h>

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

using oflag_t = uint8_t;
inline constexpr oflag_t O_RDONLY = 0x00;
inline constexpr oflag_t O_WRONLY = 0x01;
inline constexpr oflag_t O_RDWR = 0x02;
inline constexpr oflag_t O_APPEND = 0x04;
inline constexpr oflag_t O_CREAT = 0x08;
inline constexpr oflag_t O_TRUNC = 0x10;

struct FatFil;

class HalFile : public Print {
 public:
  HalFile();
  ~HalFile() override;
  HalFile(HalFile&&) noexcept;
  HalFile& operator=(HalFile&&) noexcept;
  HalFile(const HalFile&) = delete;
  HalFile& operator=(const HalFile&) = delete;

  bool seek(size_t pos);
  bool seekCur(int64_t offset);
  bool seekSet(size_t offset) { return seek(offset); }
  size_t position() const;
  size_t size();
  size_t fileSize() { return size(); }
  int available() const;
  int read(void* buf, size_t count);
  int read();
  size_t write(const void* buf, size_t count);
  size_t write(const uint8_t* buf, size_t count) override { return write(static_cast<const void*>(buf), count); }
  size_t write(uint8_t b) override { return write(&b, 1); }
  bool sync();
  bool close();
  bool isOpen() const;
  operator bool() const { return isOpen(); }

 private:
  friend class HalStorage;
  std::unique_ptr<FatFil> fil_;
};

using FsFile = HalFile;

class HalStorage {
 public:
  static HalStorage& getInstance();

  bool mountImage(const char* imagePath, uint64_t bytes);
  void unmount();

  uint64_t totalBytes() const;
  uint64_t usedBytes();
  bool mkdir(const char* path, bool pFlag = true);
  bool exists(const char* path);
  bool remove(const char* path);
  bool rename(const char* oldPath, const char* newPath);

  HalFile open(const char* path, oflag_t oflag = O_RDONLY);
  bool openFileForRead(const char* moduleName, const char* path, HalFile& file);
  bool openFileForRead(const char* moduleName, const std::string& path, HalFile& file) {
    return openFileForRead(moduleName, path.c_str(), file);
  }
  bool openFileForWrite(const char* moduleName, const char* path, HalFile& file);
  bool openFileForWrite(const char* moduleName, const std::string& path, HalFile& file) {
    return openFileForWrite(moduleName, path.c_str(), file);
  }

 private:
  HalStorage() = default;
  bool ready_ = false;
  uint64_t imageBytes_ = 0;
};

#define Storage HalStorage::getInstance()

bool fatImageOpen(const char* path, uint64_t bytes);
void fatImageClose();
uint64_t fatImageBytes();
