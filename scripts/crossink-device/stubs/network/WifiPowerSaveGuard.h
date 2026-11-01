#pragma once

class WifiPowerSaveGuard final {
 public:
  WifiPowerSaveGuard() = default;
  ~WifiPowerSaveGuard() = default;
  WifiPowerSaveGuard(const WifiPowerSaveGuard&) = delete;
  WifiPowerSaveGuard& operator=(const WifiPowerSaveGuard&) = delete;
};
