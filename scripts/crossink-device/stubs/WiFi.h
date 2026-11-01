#pragma once

#include <Arduino.h>

constexpr int WL_CONNECTED = 3;
constexpr int WIFI_MODE_NULL = 0;

class WiFiClass {
 public:
  int status() const { return WL_CONNECTED; }
  int RSSI() const { return -50; }
  int getMode() const { return 1; }
  void disconnect(bool = false) {}
  IPAddress localIP() const {
    IPAddress ip;
    ip[0] = 192;
    ip[1] = 168;
    ip[2] = 1;
    ip[3] = 2;
    return ip;
  }
};

inline WiFiClass WiFi;
