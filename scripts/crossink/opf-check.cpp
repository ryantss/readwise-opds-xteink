// Parses content.opf with CrossInk's ContentOpfParser (v1.6.1) and prints the
// metadata the device extracts. Exit 1 on parse failure or missing title.
// Paths are named locals because the parser stores them by reference.
#include <ContentOpfParser.h>

#include <fstream>
#include <iostream>
#include <sstream>

int main(int argc, char** argv) {
  if (argc != 2) {
    std::cerr << "usage: opf-check-crossink <content.opf>\n";
    return 2;
  }
  std::ifstream in(argv[1], std::ios::binary);
  std::stringstream buffer;
  buffer << in.rdbuf();
  const std::string xml = buffer.str();

  const std::string cachePath;
  const std::string baseContentPath;
  ContentOpfParser parser(cachePath, baseContentPath, xml.size(), nullptr);
  if (!parser.setup()) return 1;
  const size_t written = parser.write(reinterpret_cast<const uint8_t*>(xml.data()), xml.size());
  std::cout << "title: " << parser.title << "\n"
            << "author: " << parser.author << "\n"
            << "language: " << parser.language << "\n"
            << "toc ncx: " << parser.tocNcxPath << "\n"
            << "toc nav: " << parser.tocNavPath << "\n"
            << "cover: " << parser.coverItemHref << "\n";
  return written == xml.size() && !parser.title.empty() ? 0 : 1;
}
