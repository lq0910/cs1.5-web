// 功能：启动 CS 1.5 Web 的 Tauri 浏览器壳；时间：2026-10-30；作者：lq。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|_app| {
            // 功能：macOS 的 WKWebView 默认拒绝 Pointer Lock，导致进入对局后鼠标无法转向、Esc 也无法暂停；时间：2026-10-31；作者：lq。
            #[cfg(target_os = "macos")]
            if let Some(window) = _app.get_webview_window("main") {
                let _ = window.with_webview(|webview| {
                    macos::enable_pointer_lock(webview.inner());
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running CS 1.5 Web");
}
