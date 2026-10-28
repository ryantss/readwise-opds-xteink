// Parses an OPDS feed with CrossInk's OpdsParser (v1.6.1) and prints what
// the device would show. Exit 1 when the parser errors or finds no entries.
// CrossInk requires a caller-supplied entry buffer (MAX_OPDS_FEED_ENTRIES=50).
#include <OpdsParser.h>

#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: opds-check-crossink <feed.xml>\n";
    return 2;
  }
  std::ifstream in(argv[1], std::ios::binary);
  std::stringstream buffer;
  buffer << in.rdbuf();
  const std::string xml = buffer.str();

  OpdsEntry entries[MAX_OPDS_FEED_ENTRIES];
  OpdsParser parser(entries);
  // The device streams network-sized chunks into OpdsParserStream; mimic that.
  for (size_t offset = 0; offset < xml.size(); offset += 1460) {
    const size_t len = std::min<size_t>(1460, xml.size() - offset);
    parser.write(reinterpret_cast<const uint8_t*>(xml.data() + offset), len);
  }
  parser.flush();

  if (parser.error()) {
    std::cout << "PARSE ERROR reason=" << static_cast<int>(parser.getErrorReason()) << "\n";
    return 1;
  }
  std::cout << "next page: " << parser.getNextPageUrl() << "\n";
  std::cout << "prev page: " << parser.getPrevPageUrl() << "\n";
  std::cout << "truncated: " << (parser.wasTruncated() ? "yes" : "no") << "\n";
  size_t books = 0;
  size_t navigation = 0;
  for (const auto& entry : parser.getEntries()) {
    const bool isBook = entry.type == OpdsEntryType::BOOK;
    (isBook ? books : navigation)++;
    std::cout << (isBook ? "BOOK " : "NAV  ") << entry.title << " | " << entry.author << " | " << entry.href
              << " | count=" << entry.count << "\n";
  }
  std::cout << "books: " << books << "\nnavigation: " << navigation << "\n";
  return books + navigation > 0 ? 0 : 1;
}
