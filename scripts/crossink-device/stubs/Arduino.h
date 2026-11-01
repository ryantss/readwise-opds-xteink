#pragma once

#include <cstdarg>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

inline unsigned long millis() {
  using clock = std::chrono::steady_clock;
  static const auto start = clock::now();
  return static_cast<unsigned long>(
      std::chrono::duration_cast<std::chrono::milliseconds>(clock::now() - start).count());
}

inline unsigned long micros() { return millis() * 1000UL; }

inline void delay(unsigned long ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

class String {
 public:
  String() = default;
  String(const char* s) : s_(s ? s : "") {}
  String(const std::string& s) : s_(s) {}
  const char* c_str() const { return s_.c_str(); }
  size_t length() const { return s_.size(); }
  String operator+(const String& other) const { return String(s_ + other.s_); }
  friend String operator+(const char* left, const String& right) { return String(std::string(left) + right.s_); }

 private:
  std::string s_;
};

class IPAddress {
 public:
  uint8_t operator[](int i) const { return i >= 0 && i < 4 ? octets_[i] : 0; }
  uint8_t& operator[](int i) { return octets_[i]; }
  bool operator!=(const IPAddress& other) const {
    return memcmp(octets_, other.octets_, 4) != 0;
  }

 private:
  uint8_t octets_[4] = {0, 0, 0, 0};
};

struct EspStub {
  size_t getMaxAllocHeap() const { return 8u * 1024u * 1024u; }
  size_t getFreeHeap() const { return 16u * 1024u * 1024u; }
};
inline EspStub ESP;

struct SerialStub {
  operator bool() const { return true; }
  void println(const char* line) const { std::fprintf(stderr, "%s\n", line ? line : ""); }
  void printf(const char* fmt, ...) const {
    va_list args;
    va_start(args, fmt);
    std::vfprintf(stderr, fmt, args);
    va_end(args);
  }
};
inline SerialStub Serial;
