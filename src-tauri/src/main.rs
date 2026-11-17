// 功能：启动 CS 1.5 Web 的 Tauri 浏览器壳；时间：2026-10-30；作者：lq。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos;

// 功能：注册桌面房间生命周期与原生命令；时间：2026-11-17；作者：lq。
mod lan;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .manage(lan::LanHost::default())
        .invoke_handler(tauri::generate_handler![lan::lan_host_start, lan::lan_host_status, lan::lan_host_stop])
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
        .build(tauri::generate_context!())
        .expect("error while building CS 1.5 Web")
        .run(|app, event| {
            // 功能：退出客户端时关闭房间，所有连接随房主离线结束；时间：2026-11-17；作者：lq。
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = app.state::<lan::LanHost>().stop();
            }
        });
}
