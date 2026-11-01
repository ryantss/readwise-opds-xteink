// Host harness for CrossInk v1.6.1's OPDS browse + download path.
// Compiles the firmware's own HttpDownloader, SecureHttpClient, SecureClient
// (wolfSSL), OpdsParser, StringUtils, UrlUtils, ZipFile, and DownloadFileSwap.
// Only the hardware layers are stubbed: WiFi/TCP, FatFs-backed HalStorage,
// Arduino clock, and the unused ESP-HTTP transport.
//
// English strings are copied from lib/I18n/translations/english.yaml so a
// failing step prints the same text the X3 puts after "Error:".

#include <AppVersion.h>
#include <HalStorage.h>
#include <OpdsParser.h>
#include <OpdsStream.h>
#include <SecureClient.h>
#include <ZipFile.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <strings.h>
#include <string>
#include <vector>

#include "network/DownloadFileSwap.h"
#include "network/HttpDownloader.h"
#include "util/StringUtils.h"
#include "util/UrlUtils.h"

enum class OpdsFilenameFormat : uint8_t { AUTHOR_TITLE = 0, TITLE_AUTHOR = 1 };

namespace {
// english.yaml
constexpr const char* STR_ERROR_MSG = "Error:";
constexpr const char* STR_DOWNLOAD_FAILED = "Download failed";
constexpr const char* STR_FETCH_FEED_FAILED = "Failed to fetch feed";
constexpr const char* STR_PARSE_FEED_FAILED = "Failed to parse feed";
constexpr const char* STR_SD_CARD_FULL = "Insufficient SD card space";
constexpr const char* STR_NO_ENTRIES = "No entries found";
constexpr const char* STR_MEMORY_ERROR = "Memory error";

// OpdsBookBrowserActivity.cpp:41
constexpr size_t OPDS_DOWNLOAD_BUFFER_SIZE = 2048;
constexpr uint64_t FAT_IMAGE_BYTES = 64ull * 1024ull * 1024ull;

// OpdsBookBrowserActivity.cpp:48-53
std::string buildBookFilenameBase(const OpdsEntry& book, const OpdsFilenameFormat format) {
  if (book.author.empty()) return book.title;
  if (book.title.empty()) return book.author;
  if (format == OpdsFilenameFormat::TITLE_AUTHOR) return book.title + " - " + book.author;
  return book.author + " - " + book.title;
}

// OpdsBookBrowserActivity.cpp:653-657
std::string deviceDestPath(const OpdsEntry& book, const char* folder, const OpdsFilenameFormat format) {
  std::string path = folder ? folder : "";
  path += '/';
  path += StringUtils::sanitizeFilename(buildBookFilenameBase(book, format));
  path += ".epub";
  return path;
}

const char* downloadErrorName(const HttpDownloader::DownloadError error) {
  switch (error) {
    case HttpDownloader::OK:
      return "OK";
    case HttpDownloader::HTTP_ERROR:
      return "HTTP_ERROR";
    case HttpDownloader::FILE_ERROR:
      return "FILE_ERROR";
    case HttpDownloader::ABORTED:
      return "ABORTED";
    case HttpDownloader::INSUFFICIENT_SPACE:
      return "INSUFFICIENT_SPACE";
  }
  return "UNKNOWN";
}

// OpdsBookBrowserActivity.cpp:782-784
const char* uiErrorForDownload(const HttpDownloader::DownloadError error) {
  if (error == HttpDownloader::INSUFFICIENT_SPACE) return STR_SD_CARD_FULL;
  return STR_DOWNLOAD_FAILED;
}

void fail(const char* step, const char* ui, const std::string& detail) {
  std::cout << "FAIL step=" << step << "\n";
  std::cout << STR_ERROR_MSG << " " << ui << "\n";
  if (!detail.empty()) std::cout << "detail: " << detail << "\n";
}

void pass(const char* step, const std::string& detail) {
  std::cout << "PASS step=" << step;
  if (!detail.empty()) std::cout << " " << detail;
  std::cout << "\n";
}

bool validateContainer(const std::string& path) {
  ZipFile zip(path);
  size_t size = 0;
  return zip.getInflatedFileSize("META-INF/container.xml", &size) && size > 0;
}

HttpDownloader::DownloadOptions wolfOptions(const std::string& origin, const bool forDownload) {
  HttpDownloader::DownloadOptions options;
  options.transport = HttpDownloader::Transport::WOLFSSL;
  options.authorizationOrigin = origin;
  if (forDownload) {
    options.bufferSize = OPDS_DOWNLOAD_BUFFER_SIZE;
    options.stageAsPart = true;
    options.checkFreeSpace = true;
    options.validate = [](const std::string& path) { return validateContainer(path); };
  }
  return options;
}

int fetchAndParse(const std::string& url, const std::string& origin, const std::string& user,
                  const std::string& password, const char* stepFetch, const char* stepParse, OpdsEntry* entries,
                  const size_t capacity, OpdsParser& parser) {
  std::cout << "GET " << UrlUtils::forLog(url) << " UA=" << AppVersion::userAgent()
            << " transport=WOLFSSL timeout_ms=60000\n";
  {
    OpdsParserStream stream{parser};
    const auto result = HttpDownloader::streamUrl(
        url, [&stream](const uint8_t* data, const size_t len) { return stream.write(data, len) == len; }, nullptr, user,
        password, wolfOptions(origin, false));
    if (result != HttpDownloader::OK) {
      fail(stepFetch, STR_FETCH_FEED_FAILED,
           std::string("HttpDownloader::streamUrl=") + downloadErrorName(result) +
               " (OpdsBookBrowserActivity.cpp:552-555)");
      return 1;
    }
  }
  pass(stepFetch, std::string("status=200 via ") + AppVersion::userAgent());
  if (!parser) {
    fail(stepParse,
         parser.getErrorReason() == OpdsParserError::BUFFER_MEMORY ? STR_MEMORY_ERROR : STR_PARSE_FEED_FAILED,
         "OpdsBookBrowserActivity.cpp:560-564");
    return 1;
  }
  std::cout << "next page: " << parser.getNextPageUrl() << "\n";
  std::cout << "prev page: " << parser.getPrevPageUrl() << "\n";
  size_t books = 0;
  size_t navigation = 0;
  for (size_t i = 0; i < parser.getEntryCount(); ++i) {
    const auto& entry = entries[i];
    const bool isBook = entry.type == OpdsEntryType::BOOK;
    (isBook ? books : navigation)++;
    std::cout << (isBook ? "BOOK " : "NAV  ") << entry.title << " | " << entry.author << " | " << entry.href << "\n";
  }
  if (parser.getEntryCount() == 0) {
    fail(stepParse, STR_NO_ENTRIES, "OpdsBookBrowserActivity.cpp:598-599");
    return 1;
  }
  pass(stepParse, "books=" + std::to_string(books) + " navigation=" + std::to_string(navigation));
  return 0;
}

int copyHostFileToFat(const std::string& hostPath, const std::string& destPath) {
  std::ifstream in(hostPath, std::ios::binary);
  if (!in) return 1;
  HalFile file;
  if (!Storage.openFileForWrite("HARNESS", destPath, file)) return 1;
  std::vector<char> buf(4096);
  while (in) {
    in.read(buf.data(), static_cast<std::streamsize>(buf.size()));
    const auto n = static_cast<size_t>(in.gcount());
    if (n == 0) break;
    if (file.write(buf.data(), n) != n) {
      file.close();
      return 1;
    }
  }
  const bool ok = file.sync() && file.close();
  return ok ? 0 : 1;
}

void printFilename(const std::string& title, const std::string& author, const OpdsFilenameFormat format) {
  OpdsEntry book;
  book.title = title;
  book.author = author;
  const std::string dest = deviceDestPath(book, "", format);
  std::cout << "filename title=" << title << " author=" << author << " format="
            << (format == OpdsFilenameFormat::TITLE_AUTHOR ? "title-author" : "author-title") << " -> " << dest
            << " bytes=" << dest.size() - 1 << "\n";
}

void usage() {
  std::cerr << "usage:\n"
            << "  crossink-device-harness --url URL --user USER --password PASS [--shelf inbox]\n"
            << "      [--folder FOLDER] [--image FILE] [--book-index N]\n"
            << "  crossink-device-harness --sanitize --title T [--author A]\n"
            << "  crossink-device-harness --validate-zip FILE [--title T --author A]\n";
}
}  // namespace

int main(int argc, char** argv) {
  std::string url;
  std::string user;
  std::string password;
  std::string shelf = "Inbox";
  std::string folder;
  std::string imagePath = "/tmp/crossink-device.fat";
  std::string zipPath;
  std::string title;
  std::string author;
  int bookIndex = 0;
  bool sanitizeOnly = false;
  bool validateZip = false;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    auto need = [&](std::string& dest) {
      if (i + 1 >= argc) return false;
      dest = argv[++i];
      return true;
    };
    if (arg == "--url") {
      if (!need(url)) return 2;
    } else if (arg == "--user") {
      if (!need(user)) return 2;
    } else if (arg == "--password") {
      if (!need(password)) return 2;
    } else if (arg == "--shelf") {
      if (!need(shelf)) return 2;
    } else if (arg == "--folder") {
      if (!need(folder)) return 2;
    } else if (arg == "--image") {
      if (!need(imagePath)) return 2;
    } else if (arg == "--title") {
      if (!need(title)) return 2;
    } else if (arg == "--author") {
      if (!need(author)) return 2;
    } else if (arg == "--validate-zip") {
      if (!need(zipPath)) return 2;
      validateZip = true;
    } else if (arg == "--sanitize") {
      sanitizeOnly = true;
    } else if (arg == "--book-index") {
      if (i + 1 >= argc) return 2;
      bookIndex = std::atoi(argv[++i]);
    } else if (arg == "--help" || arg == "-h") {
      usage();
      return 0;
    } else {
      std::cerr << "unknown flag: " << arg << "\n";
      usage();
      return 2;
    }
  }

  std::cout << "CrossInk pin v1.6.1 9914146eeae7b46b300f475a16c32426fc02ec1f\n";
  std::cout << "UA " << AppVersion::userAgent() << " wolfSSL=" << (freeink::SecureClient::tls13Available() ? "yes" : "no")
            << " HTTP_TIMEOUT_MS=60000 DOWNLOAD_IDLE_TIMEOUT_MS=30000 buffer=" << OPDS_DOWNLOAD_BUFFER_SIZE
            << " MAX_LINE=4096 READ_CHUNK=2048 MAX_REDIRECTS=5\n";
  std::cout << "cannot-model: ESP32 heap/fragmentation, WiFi timing, real SD card behaviour\n";

  if (sanitizeOnly) {
    if (title.empty()) {
      usage();
      return 2;
    }
    printFilename(title, author, OpdsFilenameFormat::AUTHOR_TITLE);
    printFilename(title, author, OpdsFilenameFormat::TITLE_AUTHOR);
    return 0;
  }

  if (!fatImageOpen(imagePath.c_str(), FAT_IMAGE_BYTES)) {
    fail("fat-mount", STR_DOWNLOAD_FAILED, "could not create FAT32 image at " + imagePath);
    return 1;
  }

  if (validateZip) {
    OpdsEntry book;
    book.title = title.empty() ? zipPath : title;
    book.author = author;
    const std::string dest = deviceDestPath(book, folder.c_str(), OpdsFilenameFormat::AUTHOR_TITLE);
    printFilename(book.title, book.author, OpdsFilenameFormat::AUTHOR_TITLE);
    if (!folder.empty() && !Storage.mkdir(folder.c_str())) {
      fail("mkdir", STR_DOWNLOAD_FAILED, "OpdsBookBrowserActivity.cpp:705-708");
      fatImageClose();
      return 1;
    }
    if (copyHostFileToFat(zipPath, dest) != 0) {
      fail("fat-write", STR_DOWNLOAD_FAILED, "could not copy " + zipPath + " to " + dest);
      fatImageClose();
      return 1;
    }
    if (!validateContainer(dest)) {
      fail("validate", STR_DOWNLOAD_FAILED,
           "ZipFile::getInflatedFileSize(META-INF/container.xml) failed (HttpDownloader.cpp:628-631)");
      fatImageClose();
      return 1;
    }
    ZipFile zip(dest);
    size_t size = 0;
    zip.getInflatedFileSize("META-INF/container.xml", &size);
    pass("validate", dest + " container.xml uncompressed=" + std::to_string(size));
    fatImageClose();
    return 0;
  }

  if (url.empty()) {
    usage();
    fatImageClose();
    return 2;
  }

  const std::string serverUrl = UrlUtils::ensureProtocol(url);
  const std::string origin = serverUrl;
  OpdsEntry rootEntries[MAX_OPDS_FEED_ENTRIES];
  OpdsParser rootParser(rootEntries);
  if (fetchAndParse(UrlUtils::buildUrl(serverUrl, ""), origin, user, password, "fetch-root", "parse-root", rootEntries,
                    MAX_OPDS_FEED_ENTRIES, rootParser) != 0) {
    fatImageClose();
    return 1;
  }

  std::string inboxHref;
  for (size_t i = 0; i < rootParser.getEntryCount(); ++i) {
    if (rootEntries[i].type == OpdsEntryType::NAVIGATION &&
        strcasecmp(rootEntries[i].title.c_str(), shelf.c_str()) == 0) {
      inboxHref = rootEntries[i].href;
      break;
    }
  }
  if (inboxHref.empty()) {
    fail("find-shelf", STR_NO_ENTRIES, "no navigation entry titled " + shelf);
    fatImageClose();
    return 1;
  }
  const std::string inboxUrl = UrlUtils::buildUrl(serverUrl, inboxHref);
  pass("find-shelf", shelf + " -> " + UrlUtils::forLog(inboxUrl));

  OpdsEntry shelfEntries[MAX_OPDS_FEED_ENTRIES];
  OpdsParser shelfParser(shelfEntries);
  if (fetchAndParse(inboxUrl, origin, user, password, "fetch-shelf", "parse-shelf", shelfEntries, MAX_OPDS_FEED_ENTRIES,
                    shelfParser) != 0) {
    fatImageClose();
    return 1;
  }

  const OpdsEntry* book = nullptr;
  int seenBooks = 0;
  for (size_t i = 0; i < shelfParser.getEntryCount(); ++i) {
    if (shelfEntries[i].type != OpdsEntryType::BOOK) continue;
    if (seenBooks++ == bookIndex) {
      book = &shelfEntries[i];
      break;
    }
  }
  if (!book) {
    fail("find-book", STR_NO_ENTRIES, "no BOOK at --book-index " + std::to_string(bookIndex));
    fatImageClose();
    return 1;
  }

  const std::string dest = deviceDestPath(*book, folder.c_str(), OpdsFilenameFormat::AUTHOR_TITLE);
  const std::string downloadUrl = UrlUtils::buildUrl(inboxUrl, book->href);
  std::cout << "download title=" << book->title << " author=" << book->author << " href=" << book->href << "\n";
  std::cout << "device path=" << dest << " (sanitizeFilename 150-byte cap, AUTHOR_TITLE)\n";
  printFilename(book->title, book->author, OpdsFilenameFormat::AUTHOR_TITLE);

  if (!DownloadFileSwap::recover(dest)) {
    fail("recover", STR_DOWNLOAD_FAILED, "DownloadFileSwap::recover (OpdsBookBrowserActivity.cpp:659-661)");
    fatImageClose();
    return 1;
  }
  pass("recover", dest);

  if (!folder.empty() && !Storage.exists(folder.c_str()) && !Storage.mkdir(folder.c_str())) {
    fail("mkdir", STR_DOWNLOAD_FAILED, "OpdsBookBrowserActivity.cpp:705-708");
    fatImageClose();
    return 1;
  }

  const auto result = HttpDownloader::downloadToFile(downloadUrl, dest, nullptr, nullptr, user, password,
                                                     wolfOptions(origin, true));
  if (result != HttpDownloader::OK) {
    fail("download", uiErrorForDownload(result),
         std::string("HttpDownloader::downloadToFile=") + downloadErrorName(result) +
             " (OpdsBookBrowserActivity.cpp:782-784)");
    fatImageClose();
    return 1;
  }
  pass("download", dest + " via wolfSSL GET Connection=keep-alive");

  if (!Storage.exists(dest.c_str())) {
    fail("publish", STR_DOWNLOAD_FAILED, "DownloadFileSwap::publish left no dest file");
    fatImageClose();
    return 1;
  }
  HalFile published;
  if (!Storage.openFileForRead("HARNESS", dest, published)) {
    fail("publish", STR_DOWNLOAD_FAILED, "published dest could not be opened");
    fatImageClose();
    return 1;
  }
  const size_t publishedSize = published.size();
  published.close();
  pass("publish", dest + " size=" + std::to_string(publishedSize));

  if (!validateContainer(dest)) {
    fail("validate", STR_DOWNLOAD_FAILED, "container.xml missing after publish");
    fatImageClose();
    return 1;
  }
  ZipFile zip(dest);
  size_t containerSize = 0;
  zip.getInflatedFileSize("META-INF/container.xml", &containerSize);
  pass("validate", "META-INF/container.xml uncompressed=" + std::to_string(containerSize));

  std::cout << "ALL PASS " << dest << " " << publishedSize << " bytes\n";
  fatImageClose();
  return 0;
}
