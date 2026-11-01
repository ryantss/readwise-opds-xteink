#pragma once

#include <cstddef>
#include <cstdint>

// ZipFile.cpp needs this type even though post-download validation only reads
// the central directory via getInflatedFileSize.
class InflateStream {
 public:
  enum class Status { Ok, Done, Error };
  using FillFn = size_t (*)(void* ctx, const uint8_t** data);

  InflateStream() = default;
  ~InflateStream() = default;
  bool init(bool) { return false; }
  void deinit() {}
  void setSource(const uint8_t*, size_t) {}
  void setFill(FillFn, void*) {}
  bool read(uint8_t*, size_t) { return false; }
  Status readAtMost(uint8_t*, size_t, size_t* produced) {
    if (produced) *produced = 0;
    return Status::Error;
  }
};
