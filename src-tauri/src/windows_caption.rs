// Windows caption buttons for the frameless window (the tab strip is the title bar row). Like Chrome they
// belong to the top-level window itself, not to a webview: only a top-level WM_NCHITTEST answer of
// HTMAXBUTTON gives Windows 11 its Snap Layouts flyout. The strip webview stops short of this column.
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetActiveWindow, TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

const BUTTONS: [u32; 3] = [HTMINBUTTON, HTMAXBUTTON, HTCLOSE];
// Strip colour, glyph colour (0x00BBGGRR); set from the app's appearance.
static COLORS: Mutex<(u32, u32)> = Mutex::new((0x090401, 0xf3ede6));

// Windows 11 caption buttons are 46×32; the column spans the 41px strip.
fn metrics(scale: f64) -> (i32, i32, i32) {
  ((46.0 * scale).round() as i32, (32.0 * scale).round() as i32, (crate::macos_tabs::STRIP_HEIGHT * scale).round() as i32)
}

pub fn width(scale: f64) -> u32 {
  (metrics(scale).0 * 3) as u32
}

fn bgr(hex: &str) -> u32 {
  let rgb = u32::from_str_radix(hex.trim_start_matches('#'), 16).unwrap_or(0);
  ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >> 16)
}

fn mix(a: u32, b: u32, t: f64) -> u32 {
  (0..3).map(|i| {
    let (x, y) = (((a >> (i * 8)) & 0xff) as f64, ((b >> (i * 8)) & 0xff) as f64);
    ((x + (y - x) * t).round() as u32) << (i * 8)
  }).sum()
}

pub fn set_colors(app: &tauri::AppHandle, light: bool, strip: &str) {
  *COLORS.lock().unwrap_or_else(|e| e.into_inner()) = (bgr(strip), if light { 0x28231f } else { 0xf3ede6 });
  use tauri::Manager;
  for window in app.windows().values() {
    if let Ok(hwnd) = window.hwnd() { unsafe { InvalidateRect(hwnd.0 as HWND, std::ptr::null(), 0) }; }
  }
}

pub fn attach(window: &tauri::Window) {
  let Ok(hwnd) = window.hwnd() else { return };
  let state = Box::into_raw(Box::new((0u32, 0u32))) as usize; // (hovered, pressed) hit-test codes
  unsafe { SetWindowSubclass(hwnd.0 as HWND, Some(subclass), 1, state) };
}

// The Tauri resize border child must stay above the webviews added later, or the top edge stops resizing.
pub fn raise_resize_border(window: &tauri::Window) {
  let Ok(hwnd) = window.hwnd() else { return };
  unsafe {
    let class: Vec<u16> = "TAURI_DRAG_RESIZE_BORDERS\0".encode_utf16().collect();
    let border = FindWindowExW(hwnd.0 as HWND, std::ptr::null_mut(), class.as_ptr(), std::ptr::null());
    if !border.is_null() {
      SetWindowPos(border, HWND_TOP, 0, 0, 0, 0, SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER);
    }
  }
}

unsafe fn layout(hwnd: HWND) -> (RECT, i32, i32) {
  let mut client = RECT { left: 0, top: 0, right: 0, bottom: 0 };
  GetClientRect(hwnd, &mut client);
  let (bw, bh, sh) = metrics(GetDpiForWindow(hwnd) as f64 / 96.0);
  (RECT { left: client.right - bw * 3, top: 0, right: client.right, bottom: sh }, bw, bh)
}

unsafe fn hit(hwnd: HWND, lparam: LPARAM) -> Option<u32> {
  let mut point = POINT { x: (lparam & 0xffff) as i16 as i32, y: ((lparam >> 16) & 0xffff) as i16 as i32 };
  ScreenToClient(hwnd, &mut point);
  let (column, bw, bh) = layout(hwnd);
  if point.x < column.left || point.x >= column.right || point.y < 0 || point.y >= column.bottom { return None; }
  Some(if point.y < bh { BUTTONS[((point.x - column.left) / bw).clamp(0, 2) as usize] } else { HTCAPTION })
}

unsafe fn paint(hwnd: HWND, (hovered, pressed): (u32, u32)) {
  let (column, bw, bh) = layout(hwnd);
  let (strip, fg) = *COLORS.lock().unwrap_or_else(|e| e.into_inner());
  let fg = if GetActiveWindow() == hwnd { fg } else { mix(strip, fg, 0.45) };
  let hdc = GetDC(hwnd);
  let fill = |rect: &RECT, color: u32| { let brush = CreateSolidBrush(color); FillRect(hdc, rect, brush); DeleteObject(brush); };
  fill(&RECT { top: bh, ..column }, strip);
  let font = |face: &str| {
    let face: Vec<u16> = face.encode_utf16().chain([0]).collect();
    CreateFontW(-((10 * GetDpiForWindow(hwnd) / 96) as i32), 0, 0, 0, FW_NORMAL as i32, 0, 0, 0, DEFAULT_CHARSET as u32,
      OUT_DEFAULT_PRECIS as u32, CLIP_DEFAULT_PRECIS as u32, CLEARTYPE_QUALITY as u32, DEFAULT_PITCH as u32, face.as_ptr())
  };
  // Windows 11 draws these glyphs from Segoe Fluent Icons; Windows 10 has the same code points in Segoe MDL2 Assets.
  let mut glyphs = font("Segoe Fluent Icons");
  let previous = SelectObject(hdc, glyphs);
  let mut name = [0u16; 32];
  let len = GetTextFaceW(hdc, 32, name.as_mut_ptr()).max(1) as usize - 1;
  if String::from_utf16_lossy(&name[..len.min(32)]) != "Segoe Fluent Icons" {
    SelectObject(hdc, previous);
    DeleteObject(glyphs);
    glyphs = font("Segoe MDL2 Assets");
    SelectObject(hdc, glyphs);
  }
  SetBkMode(hdc, TRANSPARENT as i32);
  for (i, code) in BUTTONS.iter().enumerate() {
    let mut rect = RECT { left: column.left + bw * i as i32, top: 0, right: column.left + bw * (i as i32 + 1), bottom: bh };
    let close = *code == HTCLOSE;
    let (back, color) = match (hovered == *code, pressed == *code) {
      (true, true) if close => (0x1a27b3, 0xffffff),
      (true, _) if close => (0x1c2bc4, 0xffffff),
      (true, true) => (mix(strip, fg, 0.06), fg),
      (true, false) => (mix(strip, fg, 0.1), fg),
      _ => (strip, fg),
    };
    fill(&rect, back);
    SetTextColor(hdc, color);
    let glyph: u16 = match *code { HTMINBUTTON => 0xE921, HTMAXBUTTON if IsZoomed(hwnd) != 0 => 0xE923, HTMAXBUTTON => 0xE922, _ => 0xE8BB };
    DrawTextW(hdc, &glyph, 1, &mut rect, DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX);
  }
  SelectObject(hdc, previous);
  DeleteObject(glyphs);
  ReleaseDC(hwnd, hdc);
}

unsafe fn redraw(hwnd: HWND) {
  let (column, _, _) = layout(hwnd);
  InvalidateRect(hwnd, &column, 0);
}

unsafe extern "system" fn subclass(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM, _: usize, data: usize) -> LRESULT {
  let state = &mut *(data as *mut (u32, u32));
  let button = BUTTONS.contains(&(wparam as u32));
  match msg {
    WM_NCHITTEST => if let Some(code) = hit(hwnd, lparam) { return code as LRESULT },
    WM_NCMOUSEMOVE => {
      let hovered = if button { wparam as u32 } else { 0 };
      if hovered != state.0 {
        *state = (hovered, if hovered == state.1 { state.1 } else { 0 });
        let mut track = TRACKMOUSEEVENT { cbSize: size_of::<TRACKMOUSEEVENT>() as u32, dwFlags: TME_LEAVE | TME_NONCLIENT, hwndTrack: hwnd, dwHoverTime: 0 };
        TrackMouseEvent(&mut track);
        redraw(hwnd);
      }
    }
    WM_NCMOUSELEAVE => { *state = (0, 0); redraw(hwnd); }
    // DefWindowProc would track and draw a classic button; the click is handled here instead.
    WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if button => {
      state.1 = wparam as u32;
      redraw(hwnd);
      return 0;
    }
    WM_NCLBUTTONUP if button => {
      let command = match (std::mem::take(&mut state.1) == wparam as u32, wparam as u32) {
        (false, _) => 0,
        (_, HTMINBUTTON) => SC_MINIMIZE,
        (_, HTMAXBUTTON) => if IsZoomed(hwnd) != 0 { SC_RESTORE } else { SC_MAXIMIZE },
        _ => SC_CLOSE,
      };
      redraw(hwnd);
      if command != 0 { PostMessageW(hwnd, WM_SYSCOMMAND, command as WPARAM, 0); }
      return 0;
    }
    WM_PAINT | WM_ERASEBKGND | WM_NCACTIVATE | WM_SIZE => {
      let result = DefSubclassProc(hwnd, msg, wparam, lparam);
      if msg == WM_PAINT { paint(hwnd, *state) } else { redraw(hwnd) }
      return result;
    }
    WM_NCDESTROY => drop(Box::from_raw(data as *mut (u32, u32))),
    _ => {}
  }
  DefSubclassProc(hwnd, msg, wparam, lparam)
}
