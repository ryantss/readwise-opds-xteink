#pragma once

#include <Arduino.h>

#include <cstdint>
#include <string>

struct base64 {
  static String encode(const char* input) {
    static constexpr char kTable[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const std::string data = input ? input : "";
    std::string out;
    out.reserve(((data.size() + 2) / 3) * 4);
    for (size_t n = 0; n < data.size(); n += 3) {
      const uint32_t b0 = static_cast<uint8_t>(data[n]);
      const uint32_t b1 = n + 1 < data.size() ? static_cast<uint8_t>(data[n + 1]) : 0;
      const uint32_t b2 = n + 2 < data.size() ? static_cast<uint8_t>(data[n + 2]) : 0;
      const uint32_t triple = (b0 << 16) | (b1 << 8) | b2;
      out.push_back(kTable[(triple >> 18) & 63]);
      out.push_back(kTable[(triple >> 12) & 63]);
      out.push_back(n + 1 < data.size() ? kTable[(triple >> 6) & 63] : '=');
      out.push_back(n + 2 < data.size() ? kTable[triple & 63] : '=');
    }
    return String(out);
  }
};
