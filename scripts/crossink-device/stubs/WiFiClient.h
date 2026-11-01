#pragma once

#include <Client.h>

#include <vector>

// POSIX TCP Client used as SecureClient's transport (the hardware WiFi layer).
class WiFiClient : public Client {
 public:
  WiFiClient() = default;
  WiFiClient(const WiFiClient&) = delete;
  WiFiClient& operator=(const WiFiClient&) = delete;
  ~WiFiClient() override { stop(); }

  int connect(IPAddress ip, uint16_t port) override;
  int connect(const char* host, uint16_t port) override;
  size_t write(uint8_t b) override;
  size_t write(const uint8_t* buf, size_t size) override;
  int available() override;
  int read() override;
  int read(uint8_t* buf, size_t size) override;
  int peek() override;
  void flush() override {}
  void stop() override;
  uint8_t connected() override;
  operator bool() override { return connected(); }

  void setConnectionTimeout(unsigned long ms) { connTimeoutMs_ = ms; }

 private:
  int waitWritable(int fd, int timeoutMs) const;
  int waitReadable(int fd, int timeoutMs) const;

  int fd_ = -1;
  bool peerClosed_ = false;
  unsigned long connTimeoutMs_ = 60000;
  std::vector<uint8_t> unread_;
};
