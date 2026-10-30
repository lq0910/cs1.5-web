// 功能：启动 CS 1.5 Web 的 Tauri 浏览器壳；时间：2026-10-30；作者：lq。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running CS 1.5 Web");
}
