#include <WiFiClient.h>

#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <string>

namespace {
int setNonBlock(const int fd) {
  const int flags = fcntl(fd, F_GETFL, 0);
  return flags < 0 ? -1 : fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
}  // namespace

int WiFiClient::waitWritable(const int fd, const int timeoutMs) const {
  pollfd p{};
  p.fd = fd;
  p.events = POLLOUT;
  return poll(&p, 1, timeoutMs);
}

int WiFiClient::waitReadable(const int fd, const int timeoutMs) const {
  pollfd p{};
  p.fd = fd;
  p.events = POLLIN;
  return poll(&p, 1, timeoutMs);
}

int WiFiClient::connect(IPAddress ip, const uint16_t port) {
  char host[16];
  std::snprintf(host, sizeof(host), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  return connect(host, port);
}

int WiFiClient::connect(const char* host, const uint16_t port) {
  stop();
  if (!host) return 0;

  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_protocol = IPPROTO_TCP;
  hints.ai_flags = AI_ADDRCONFIG;
  const std::string portText = std::to_string(port);
  addrinfo* result = nullptr;
  if (getaddrinfo(host, portText.c_str(), &hints, &result) != 0) {
    hints.ai_flags = 0;
    if (getaddrinfo(host, portText.c_str(), &hints, &result) != 0) return 0;
  }

  int connectedFd = -1;
  for (addrinfo* ai = result; ai; ai = ai->ai_next) {
    const int fd = socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol);
    if (fd < 0) continue;
    if (setNonBlock(fd) < 0) {
      ::close(fd);
      continue;
    }
    const int rc = ::connect(fd, ai->ai_addr, ai->ai_addrlen);
    if (rc != 0 && errno != EINPROGRESS) {
      ::close(fd);
      continue;
    }
    if (rc != 0) {
      const int ready = waitWritable(fd, static_cast<int>(connTimeoutMs_));
      if (ready <= 0) {
        ::close(fd);
        continue;
      }
    }
    int err = 0;
    socklen_t len = sizeof(err);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
      ::close(fd);
      continue;
    }
    connectedFd = fd;
    break;
  }
  freeaddrinfo(result);
  if (connectedFd < 0) return 0;
  fd_ = connectedFd;
  peerClosed_ = false;
  return 1;
}

size_t WiFiClient::write(const uint8_t b) { return write(&b, 1); }

size_t WiFiClient::write(const uint8_t* buf, const size_t size) {
  if (fd_ < 0 || !buf) return 0;
  size_t sent = 0;
  const unsigned long deadline = millis() + timeoutMs_;
  while (sent < size) {
    const ssize_t n = ::send(fd_, buf + sent, size - sent, MSG_NOSIGNAL);
    if (n > 0) {
      sent += static_cast<size_t>(n);
      continue;
    }
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      if (static_cast<int32_t>(millis() - deadline) >= 0) break;
      if (waitWritable(fd_, 20) < 0) break;
      continue;
    }
    peerClosed_ = true;
    break;
  }
  return sent;
}

int WiFiClient::available() {
  if (!unread_.empty()) return static_cast<int>(unread_.size());
  if (fd_ < 0) return 0;
  int queued = 0;
  if (ioctl(fd_, FIONREAD, &queued) != 0) return 0;
  return queued;
}

int WiFiClient::read() {
  uint8_t b = 0;
  return read(&b, 1) == 1 ? b : -1;
}

int WiFiClient::read(uint8_t* buf, const size_t size) {
  if (!buf || size == 0) return 0;
  size_t copied = 0;
  if (!unread_.empty()) {
    copied = std::min(size, unread_.size());
    std::memcpy(buf, unread_.data(), copied);
    unread_.erase(unread_.begin(), unread_.begin() + static_cast<std::ptrdiff_t>(copied));
    if (copied == size) return static_cast<int>(copied);
  }
  if (fd_ < 0) return copied > 0 ? static_cast<int>(copied) : -1;
  const ssize_t n = ::recv(fd_, buf + copied, size - copied, 0);
  if (n > 0) return static_cast<int>(copied + static_cast<size_t>(n));
  if (n == 0) {
    peerClosed_ = true;
    return copied > 0 ? static_cast<int>(copied) : 0;
  }
  if (errno == EAGAIN || errno == EWOULDBLOCK) return copied > 0 ? static_cast<int>(copied) : 0;
  peerClosed_ = true;
  return copied > 0 ? static_cast<int>(copied) : -1;
}

int WiFiClient::peek() {
  if (!unread_.empty()) return unread_.front();
  uint8_t b = 0;
  const ssize_t n = fd_ < 0 ? -1 : ::recv(fd_, &b, 1, MSG_PEEK);
  if (n > 0) return b;
  if (n == 0) peerClosed_ = true;
  return -1;
}

void WiFiClient::stop() {
  unread_.clear();
  if (fd_ >= 0) {
    ::close(fd_);
    fd_ = -1;
  }
  peerClosed_ = false;
}

uint8_t WiFiClient::connected() {
  if (fd_ < 0 || peerClosed_) return 0;
  int err = 0;
  socklen_t len = sizeof(err);
  if (getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &len) != 0 || err != 0) {
    peerClosed_ = true;
    return 0;
  }
  char probe = 0;
  const ssize_t n = ::recv(fd_, &probe, 1, MSG_PEEK);
  if (n == 0) {
    peerClosed_ = true;
    return 0;
  }
  return 1;
}
