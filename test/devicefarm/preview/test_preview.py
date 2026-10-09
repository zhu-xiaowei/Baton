"""Device Farm Appium check for the loopback preview test app."""

import os
import json
import re
import subprocess
import time
from pathlib import Path

from appium import webdriver
from appium.options.common import AppiumOptions
from appium.webdriver.common.appiumby import AppiumBy


MARKER = "Large JavaScript file loaded through preview"
LOG_MARKER = "BATON_REMOTE_PREVIEW_PASS"


def options():
    platform = os.environ["DEVICEFARM_DEVICE_PLATFORM_NAME"]
    udid = os.environ["DEVICEFARM_DEVICE_UDID"]
    capabilities = {
        "platformName": platform,
        "appium:deviceName": os.environ["DEVICEFARM_DEVICE_NAME"],
        "appium:platformVersion": os.environ["DEVICEFARM_DEVICE_OS_VERSION"],
        "appium:app": os.environ["DEVICEFARM_APP_PATH"],
        "appium:newCommandTimeout": 120,
    }
    if platform.lower() == "android":
        capabilities.update({
            "appium:automationName": "UiAutomator2",
            "appium:udid": udid,
            "appium:autoGrantPermissions": True,
        })
    else:
        if int(os.environ["DEVICEFARM_DEVICE_OS_VERSION"].split(".")[0]) <= 16:
            udid = udid.replace("-", "")
        capabilities.update({
            "appium:automationName": "XCUITest",
            "appium:udid": udid,
            "appium:usePrebuiltWDA": True,
            "appium:derivedDataPath": os.environ["DEVICEFARM_APPIUM_WDA_DERIVED_DATA_PATH"],
        })
    return AppiumOptions().load_capabilities(capabilities)


def android_pass_marker():
    if os.environ["DEVICEFARM_DEVICE_PLATFORM_NAME"].lower() != "android":
        return False
    result = subprocess.run(
        ["adb", "-s", os.environ["DEVICEFARM_DEVICE_UDID"], "logcat", "-d", "-v", "brief"],
        capture_output=True, text=True, timeout=15, check=False,
    )
    return LOG_MARKER in result.stdout


def configure_ios_app(driver):
    config_file = Path(__file__).resolve().parent.parent / "test_config.json"
    if not config_file.exists():
        return
    config = json.loads(config_file.read_text())
    fields = [
        ("Test API key", config["apiKey"]),
        ("WebSocket URL", config["wsUrl"]),
        ("Device", config["device"]),
    ]
    deadline = time.monotonic() + 40
    for label, value in fields:
        while True:
            try:
                field = driver.find_element(AppiumBy.ACCESSIBILITY_ID, label)
                field.send_keys(value)
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise AssertionError(f"iOS test field unavailable: {label}")
                time.sleep(2)
    driver.find_element(AppiumBy.ACCESSIBILITY_ID, "Start isolated preview").click()


def main():
    screenshots = Path(os.environ["DEVICEFARM_SCREENSHOT_PATH"])
    screenshots.mkdir(parents=True, exist_ok=True)
    driver = webdriver.Remote("http://127.0.0.1:4723", options=options())
    try:
        if os.environ["DEVICEFARM_DEVICE_PLATFORM_NAME"].lower() == "ios":
            configure_ios_app(driver)
        deadline = time.monotonic() + 75
        last_source = ""
        while time.monotonic() < deadline:
            try:
                last_source = driver.page_source
                if MARKER in last_source or android_pass_marker():
                    driver.save_screenshot(str(screenshots / "remote-preview-pass.png"))
                    print(LOG_MARKER)
                    return
            except Exception as error:
                print("Waiting for preview view:", type(error).__name__)
            time.sleep(3)
        driver.save_screenshot(str(screenshots / "remote-preview-timeout.png"))
        if "Preview failed" in last_source:
            print("App displayed a preview failure")
        elif re.search(r"Transferred: [1-9][0-9]+ bytes", last_source):
            print("App received partial preview traffic")
        raise AssertionError("Remote preview did not load the large JavaScript file")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
