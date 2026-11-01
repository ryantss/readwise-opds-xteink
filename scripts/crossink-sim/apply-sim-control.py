#!/usr/bin/env python3
"""Patch the pinned crossink-simulator HAL so sim:x3 can inject keys and
screenshots after log events, instead of a wall-clock schedule.

CROSSINK_SIM_CONTROL is a directory. Atomic rename of `key` (one button name)
or `shot` (destination BMP path) is consumed on the SDL thread.
"""
from __future__ import annotations

from pathlib import Path
import sys

MARKER = "CROSSINK_SIM_CONTROL"

GPIO_FN = f"""\
// {MARKER}
void pollControlKeys() {{
  const char *dir = std::getenv("CROSSINK_SIM_CONTROL");
  if (!dir || dir[0] == '\\0')
    return;
  const std::string path = std::string(dir) + "/key";
  FILE *file = std::fopen(path.c_str(), "r");
  if (!file)
    return;
  char buf[48] = {{}};
  const bool got = std::fgets(buf, sizeof(buf), file) != nullptr;
  std::fclose(file);
  std::remove(path.c_str());
  if (!got)
    return;
  std::string name;
  for (const char *p = buf; *p; ++p) {{
    if (*p == '\\n' || *p == '\\r' || *p == ' ')
      break;
    name.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(*p))));
  }}
  const unsigned long now = millis();
  if (name == "QUIT") {{
    syntheticEvents.push_back({{now, SyntheticAction::Quit}});
    return;
  }}
  const int button = namedButton(name);
  if (button < 0)
    return;
  syntheticEvents.push_back({{now, SyntheticAction::KeyDown, button}});
  syntheticEvents.push_back({{now + 80, SyntheticAction::KeyUp, button}});
}}

"""

DISPLAY_FN = f"""\
// {MARKER}
void pollControlShot() {{
  const char *dir = std::getenv("CROSSINK_SIM_CONTROL");
  if (!dir || dir[0] == '\\0')
    return;
  const std::string req = std::string(dir) + "/shot";
  FILE *file = std::fopen(req.c_str(), "r");
  if (!file)
    return;
  char buf[1024] = {{}};
  const bool got = std::fgets(buf, sizeof(buf), file) != nullptr;
  std::fclose(file);
  std::remove(req.c_str());
  if (!got)
    return;
  std::string dest(buf);
  while (!dest.empty() && (dest.back() == '\\n' || dest.back() == '\\r'))
    dest.pop_back();
  if (!dest.empty())
    saveRendererBmp(dest);
}}

"""

GPIO_CALL_OLD = "void processSyntheticEvents() {\n  initializeSyntheticEvents();"
GPIO_CALL_NEW = "void processSyntheticEvents() {\n  initializeSyntheticEvents();\n  pollControlKeys();"
DISPLAY_CALL_OLD = "void captureDueScreenshots() {\n  const unsigned long now = millis();"
DISPLAY_CALL_NEW = "void captureDueScreenshots() {\n  pollControlShot();\n  const unsigned long now = millis();"
PRESENT_OLD = "void HalDisplay::presentIfNeeded() {\n  const bool screenshotDue = hasDueScreenshot();"
WAIT_FN = """void crossinkSimWaitControlShot(unsigned timeoutMs) {
  const unsigned long start = millis();
  display.presentIfNeeded();
  while (millis() - start < timeoutMs) {
    if (hasControlShot()) {
      display.presentIfNeeded();
      return;
    }
    SDL_Delay(20);
  }
}

"""
PRESENT_PATCHED = (
    "void HalDisplay::presentIfNeeded() {\n"
    "  const bool screenshotDue = hasDueScreenshot() || hasControlShot();"
)
PRESENT_NEW = (
    """bool hasControlShot() {
  const char *dir = std::getenv("CROSSINK_SIM_CONTROL");
  if (!dir || dir[0] == '\\0')
    return false;
  FILE *file = std::fopen((std::string(dir) + "/shot").c_str(), "r");
  if (!file)
    return false;
  std::fclose(file);
  return true;
}

"""
    + WAIT_FN
    + PRESENT_PATCHED
)


def ensure_cstdio(text: str) -> str:
    if "#include <cstdio>" in text:
        return text
    if "#include <cstdlib>" in text:
        return text.replace("#include <cstdlib>", "#include <cstdio>\n#include <cstdlib>", 1)
    raise SystemExit("cannot add cstdio include")


def apply(sim_root: Path) -> None:
    gpio = sim_root / "src/HalGPIO.cpp"
    display = sim_root / "src/HalDisplay.cpp"
    if not gpio.is_file() or not display.is_file():
        raise SystemExit(f"simulator sources missing under {sim_root}")

    gpio_text = ensure_cstdio(gpio.read_text())
    if MARKER not in gpio_text:
        if GPIO_CALL_OLD not in gpio_text:
            raise SystemExit("HalGPIO processSyntheticEvents anchor missing")
        gpio_text = gpio_text.replace(GPIO_CALL_OLD, GPIO_FN + GPIO_CALL_NEW, 1)
        gpio.write_text(gpio_text)
    elif "pollControlKeys();" not in gpio_text:
        raise SystemExit("HalGPIO has marker but no pollControlKeys call")

    display_text = ensure_cstdio(display.read_text())
    if MARKER not in display_text:
        if DISPLAY_CALL_OLD not in display_text:
            raise SystemExit("HalDisplay captureDueScreenshots anchor missing")
        display_text = display_text.replace(DISPLAY_CALL_OLD, DISPLAY_FN + DISPLAY_CALL_NEW, 1)
    elif "pollControlShot();" not in display_text:
        raise SystemExit("HalDisplay has marker but no pollControlShot call")
    if "hasControlShot()" not in display_text or "crossinkSimWaitControlShot" not in display_text:
        if PRESENT_OLD in display_text:
            display_text = display_text.replace(PRESENT_OLD, PRESENT_NEW, 1)
        elif PRESENT_PATCHED in display_text and "crossinkSimWaitControlShot" not in display_text:
            display_text = display_text.replace(PRESENT_PATCHED, WAIT_FN + PRESENT_PATCHED, 1)
        else:
            raise SystemExit("HalDisplay presentIfNeeded anchor missing")
    display.write_text(display_text)
    patched = display.read_text()
    if "hasControlShot()" not in patched:
        raise SystemExit("HalDisplay presentIfNeeded was not patched for control shots")
    if "crossinkSimWaitControlShot" not in patched:
        raise SystemExit("HalDisplay is missing crossinkSimWaitControlShot")

    print(f"applied simulator control hooks under {sim_root}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: apply-sim-control.py <crossink-simulator-src>")
    apply(Path(sys.argv[1]).resolve())
