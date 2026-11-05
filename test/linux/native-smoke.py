"""Exercise the installed .deb through tauri-driver, with local network fixtures."""
import html
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

application = str(Path(sys.argv[1]).resolve())
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
results = []
session = None
driver = None
fixture = None
trust_file = Path("/usr/local/share/ca-certificates/baton-linux-smoke.crt")


def command(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("http://127.0.0.1:4444" + path, data=data,
                                     method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    value = result.get("value", result)
    if isinstance(value, dict) and value.get("error"):
        raise RuntimeError(json.dumps(value))
    return value


def execute(script, *args):
    return command("POST", f"/session/{session}/execute/sync", {"script": script, "args": args})


def wait_for(script, description, timeout=35):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            if execute("return !!(" + script + ")"):
                return
        except Exception as error:
            last = error
        time.sleep(0.2)
    raise AssertionError(f"Timed out: {description}; {last}")


def click(selector):
    wait_for(f"document.querySelector({json.dumps(selector)})", selector)
    execute("document.querySelector(arguments[0]).click()", selector)


def observe_errors():
    execute("""
      if (!window.__linuxSmokeErrors) {
        window.__linuxSmokeErrors = [];
        addEventListener('error', event => window.__linuxSmokeErrors.push(event.message));
        addEventListener('unhandledrejection', event =>
          window.__linuxSmokeErrors.push(String(event.reason?.stack || event.reason)));
      }
    """)


def capture(name, expected):
    wait_for(expected, name)
    command("POST", f"/session/{session}/execute/async", {"script": """
      const done = arguments[arguments.length - 1];
      requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
    """, "args": []})
    # WebKit's snapshot synchronizes its render process. Keep it alongside the
    # desktop capture, then allow GTK to present the same frame under Xvfb.
    snapshot = command("GET", f"/session/{session}/screenshot")
    (output / f"{name}-webview.png").write_bytes(base64.b64decode(snapshot))
    time.sleep(1.5)
    checks = execute("""
      return {
        url: location.href,
        native: !!window.__TAURI_INTERNALS__,
        viewport: [innerWidth, innerHeight],
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        brokenImages: [...document.images].filter(i =>
          i.getBoundingClientRect().width && i.complete && !i.naturalWidth).map(i => i.src),
        errors: window.__linuxSmokeErrors || [],
        text: document.body.innerText
      };
    """)
    assert checks["native"], "Not the installed native Tauri application"
    assert not checks["horizontalOverflow"], f"Page overflows horizontally: {name}"
    assert not checks["brokenImages"], checks["brokenImages"]
    assert not checks["errors"], checks["errors"]
    assert not re.search(r"\b(?:undefined|NaN\w*)\b", checks["text"]), \
        f"Uninitialized display value on {name}: {checks['text']}"
    subprocess.run(["scrot", "--overwrite", str(output / f"{name}.png")], check=True)
    results.append({"page": name, "passed": True, **checks})
    (output / "results.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print("PASS", name, flush=True)


try:
    with tempfile.TemporaryDirectory(prefix="baton-linux-smoke-") as temporary:
        cert = Path(temporary) / "localhost.crt"
        key = Path(temporary) / "localhost.key"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                        "-keyout", str(key), "-out", str(cert), "-days", "1",
                        "-subj", "/CN=localhost",
                        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(["sudo", "cp", str(cert), str(trust_file)], check=True)
        subprocess.run(["sudo", "update-ca-certificates"], check=True, stdout=subprocess.DEVNULL)
        environment = {**os.environ, "XDG_DATA_HOME": temporary + "/data",
                       "XDG_CONFIG_HOME": temporary + "/config",
                       "XDG_CACHE_HOME": temporary + "/cache",
                       "LIBGL_ALWAYS_SOFTWARE": "1"}
        with (output / "fixture.log").open("w") as fixture_log, (output / "native.log").open("w") as native_log:
            fixture = subprocess.Popen(["node", "test/linux/fixture.mjs", str(cert), str(key)],
                                       stdout=fixture_log, stderr=subprocess.STDOUT)
            driver = subprocess.Popen(["tauri-driver", "--native-driver", "/usr/bin/WebKitWebDriver"],
                                      env=environment, stdout=native_log, stderr=subprocess.STDOUT)
            for attempt in range(100):
                try:
                    command("GET", "/status")
                    break
                except Exception:
                    time.sleep(0.2)
            value = command("POST", "/session", {"capabilities": {"alwaysMatch": {
                "tauri:options": {"application": application}
            }}})
            session = value["sessionId"]
            wait_for("document.querySelector('#startUrlInput')", "login page")
            observe_errors()
            capture("01-login", "document.querySelector('#connectBtn')")
            execute("document.querySelector('#startUrlInput').value = arguments[0]",
                    "https://localhost:4443/?key=linux-smoke-key")
            click("#connectBtn")
            wait_for("document.querySelector('.recent-project')", "signed-in home")
            observe_errors()
            capture("02-home", "document.body.innerText.includes('Ubuntu Runner')")
            click(".device-item")
            capture("03-projects", "document.querySelector('.project-item')")
            click(".project-item")
            capture("04-sessions", "document.querySelector('.session-item')")
            click(".session-item")
            capture("05-conversation", "document.querySelector('.messages')?.innerText.includes('Linux desktop verification')")
            assert execute("return !!document.querySelector('.messages table')"), "Markdown table missing"
            click("[onclick='openProjectFiles()']")
            capture("06-files", "document.querySelector('.project-file-row[data-name=\"README.md\"]')")
            click('.project-file-row[data-name="README.md"]')
            capture("07-file-preview", "document.querySelector('#fileOverlayBody')?.innerText.includes('Native Linux desktop smoke test')")
            execute("window.closeFileViewer()")
            execute("window.projectFilesBack()")
            click("[onclick='openGitStatusPage()']")
            capture("08-git", "document.querySelector('.git-file-row[data-path=\"README.md\"]')")
            click('.git-file-row[data-path="README.md"] .git-file-main')
            capture("09-git-diff", "document.body.innerText.includes('Desktop builds for macOS, Windows and Linux')")
            execute("window.closeFileViewer()")
            execute("window.closeGitStatus()")
            execute("window.openPreviewPortPrompt()")
            capture("10-preview-dialog", "document.querySelector('#previewOverlay #previewAddress')")
            execute("document.querySelector('#previewAddress').value = '3000'")
            click("#previewOverlay .preview-add")
            wait_for("document.querySelector('#previewOverlay .preview-local')?.innerText === '3000'",
                     "native preview tunnel")
            click('#previewOverlay [data-preview-action="local"]')
            wait_for("document.querySelector('#internalBrowserPage[aria-busy=\"false\"] .browser-frame:not([hidden])')",
                     "preview page loaded")
            frame = command("POST", f"/session/{session}/element",
                            {"using": "css selector", "value": "#internalBrowserPage .browser-frame"})
            command("POST", f"/session/{session}/frame", {"id": frame})
            wait_for("document.body.innerText.includes('Linux preview is running')", "preview content")
            assert execute("return document.body.innerText.includes('中文预览页面正常显示')"), \
                "Chinese preview content missing"
            command("POST", f"/session/{session}/frame", {"id": None})
            capture("10a-preview-page", "document.querySelector('#internalBrowserPage[aria-busy=\"false\"]')")
            click('#internalBrowserPage [data-browser-action="close"]')
            click("#previewOverlay .preview-close")
            click("[onclick='openProjectTerminalPage()']")
            capture("11-terminal", "document.querySelector('.project-terminal-page')?.dataset.epoch === 'epoch-1' && document.querySelector('.project-terminal-selector:not([disabled])')")
            execute("window.closeProjectTerminal()")
            execute("window.loadDevices()")
            click('a[href="setup.html"]')
            wait_for("document.querySelector('#qrUrl')?.innerText.includes('linux-smoke-token')", "settings")
            observe_errors()
            capture("12-settings-dark", "document.querySelector('[data-theme-option=\"light\"]')")
            execute("document.querySelector('#themeSettings').scrollIntoView({block: 'center'})")
            capture("12a-settings-options-dark",
                    "document.querySelector('#themeSettings').getBoundingClientRect().bottom < innerHeight")
            click('[data-theme-option="light"]')
            capture("13-settings-light", "document.documentElement.dataset.theme === 'light'")
            click("#setupBackButton button")
            capture("14-home-light", "document.querySelector('.recent-project')")
            # Reload proves credentials and the chosen theme survive a new document.
            command("POST", f"/session/{session}/refresh", {})
            capture("15-reload", "document.querySelector('.recent-project') && document.documentElement.dataset.theme === 'light'")
except Exception as error:
    print("FAIL", str(error), flush=True)
    if session:
        try:
            (output / "failure-state.json").write_text(json.dumps(execute(
                "return {url:location.href,text:document.body.innerText,html:document.body.innerHTML}"),
                indent=2, ensure_ascii=False))
            subprocess.run(["scrot", "--overwrite", str(output / "failure.png")], check=False)
        except Exception:
            pass
    raise
finally:
    if session:
        try:
            command("DELETE", f"/session/{session}")
        except Exception:
            pass
    for process in [driver, fixture]:
        if process:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
    subprocess.run(["sudo", "rm", "-f", str(trust_file)], check=False)
    subprocess.run(["sudo", "update-ca-certificates"], stdout=subprocess.DEVNULL, check=False)
    cards = "".join(f'<figure><img src="{html.escape(item["page"])}.png">'
                    f'<figcaption>{html.escape(item["page"])} — PASS</figcaption></figure>' for item in results)
    (output / "index.html").write_text(
        '<!doctype html><meta charset="utf-8"><title>Baton Linux native smoke test</title>'
        '<style>body{font:16px system-ui;background:#161b22;color:#eee;padding:24px}'
        'figure{margin:24px 0}img{max-width:100%;border:1px solid #555}</style>'
        '<h1>Baton Linux native smoke test</h1>'
        '<p>Installed DEB on Ubuntu 24.04 / X11 / WebKitGTK. Local fixture data.</p>' + cards)
