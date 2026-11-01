#pragma once

#include <cstdarg>
#include <cstdio>
#include <string>

inline void logPrintf(const char* level, const char* origin, const char* format, ...) {
  std::fprintf(stderr, "[%s] %s: ", level, origin ? origin : "?");
  va_list args;
  va_start(args, format);
  std::vfprintf(stderr, format, args);
  va_end(args);
}

#define LOG_ERR(origin, format, ...) logPrintf("ERR", origin, format "\n", ##__VA_ARGS__)
#define LOG_INF(origin, format, ...) logPrintf("INF", origin, format "\n", ##__VA_ARGS__)
#define LOG_DBG(origin, format, ...) logPrintf("DBG", origin, format "\n", ##__VA_ARGS__)

inline std::string getLastLogs() { return {}; }
inline void clearLastLogs() {}
inline bool sanitizeLogHead() { return false; }
