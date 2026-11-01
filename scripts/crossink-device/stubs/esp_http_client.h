#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

using esp_err_t = int;
inline constexpr int ESP_OK = 0;

enum { HTTP_EVENT_ON_HEADER = 1 };

struct esp_http_client_event_t {
  int event_id = 0;
  void* user_data = nullptr;
  const char* header_key = nullptr;
  const char* header_value = nullptr;
};

using esp_http_client_handle_t = void*;

struct esp_http_client_config_t {
  const char* url = nullptr;
  int buffer_size = 0;
  int buffer_size_tx = 0;
  int timeout_ms = 0;
  int (*crt_bundle_attach)(void*) = nullptr;
  bool keep_alive_enable = false;
  esp_err_t (*event_handler)(esp_http_client_event_t*) = nullptr;
  void* user_data = nullptr;
};

inline const char* esp_err_to_name(esp_err_t) { return "ESP_ERR"; }
inline esp_http_client_handle_t esp_http_client_init(const esp_http_client_config_t*) { return nullptr; }
inline void esp_http_client_set_header(esp_http_client_handle_t, const char*, const char*) {}
inline esp_err_t esp_http_client_open(esp_http_client_handle_t, int) { return -1; }
inline int64_t esp_http_client_fetch_headers(esp_http_client_handle_t) { return -1; }
inline int esp_http_client_get_status_code(esp_http_client_handle_t) { return 0; }
inline void esp_http_client_cleanup(esp_http_client_handle_t) {}
inline int esp_http_client_read(esp_http_client_handle_t, char*, int) { return -1; }
inline bool esp_http_client_is_complete_data_received(esp_http_client_handle_t) { return false; }
inline esp_err_t esp_http_client_get_and_clear_last_tls_error(esp_http_client_handle_t, int*, int*) { return ESP_OK; }
