//! macOS 版 WKWebView 的 Pointer Lock 支持。
//!
//! 功能：给 Tauri 使用的 WKWebView 补上指针锁定授权，恢复 Mac 版鼠标转向与 Esc 暂停；时间：2026-10-31；作者：lq。
//!
//! 背景：WebKit 只有在 WKUIDelegate 实现私有回调
//! `_webViewDidRequestPointerLock:completionHandler:` 时才会批准
//! `element.requestPointerLock()`，否则对页面永远返回 `pointerlockerror`
//! （见 WebKit `UIDelegate::UIClient::requestPointerLock`）。Tauri 的 wry 没有实现该回调，
//! 于是 Mac 版里既收不到鼠标增量，也不会触发 `pointerlockchange`，Esc 自然停不下游戏。
//!
//! 做法：在运行期给 wry 的 UIDelegate 类补上该回调，然后再赋值一次同一个 delegate。
//! `WKWebView.setUIDelegate:` 会调用 `UIDelegate::setDelegate` 重新缓存
//! `respondsToSelector` 的结果，否则新加的方法不会被 WebKit 看到。

use std::ffi::c_void;

use objc2::ffi::{class_addMethod, object_getClass};
use objc2::runtime::{AnyClass, AnyObject, Bool, MethodImplementation, Sel};
use objc2::{msg_send, sel};

/// 回调签名：`- (void)_webViewDidRequestPointerLock:(WKWebView *)webView completionHandler:(void (^)(BOOL))completionHandler`
///
/// 功能：无条件批准页面的锁定请求，真正隐藏/归位光标由 WebKit 自己完成；时间：2026-10-31；作者：lq。
unsafe extern "C-unwind" fn request_pointer_lock(
    _delegate: *mut AnyObject,
    _cmd: Sel,
    _webview: *mut AnyObject,
    completion: *mut AnyObject,
) {
    if completion.is_null() {
        return;
    }
    // 功能：把 WebKit 传入的栈上 block 当作 `void (^)(BOOL)` 调用，传 YES 表示允许锁定；时间：2026-10-31；作者：lq。
    let completion = &*(completion.cast::<block2::Block<dyn Fn(Bool)>>());
    completion.call((Bool::YES,));
}

/// 功能：在指定 WKWebView 上安装 Pointer Lock 授权回调；时间：2026-10-31；作者：lq。
///
/// # Safety
///
/// `wkwebview` 必须是当前线程上有效的 `WKWebView` 指针（Tauri 的 `PlatformWebview::inner()`）。
pub fn enable_pointer_lock(wkwebview: *mut c_void) {
    if wkwebview.is_null() {
        return;
    }

    unsafe {
        let webview = wkwebview.cast::<AnyObject>();
        let delegate: *mut AnyObject = msg_send![webview, UIDelegate];
        if delegate.is_null() {
            return;
        }

        let class: *mut AnyClass = object_getClass(delegate).cast_mut();
        if class.is_null() {
            return;
        }

        let imp = (request_pointer_lock
            as unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject, *mut AnyObject))
            .__imp();
        // 类型编码：返回 void，self、_cmd、WKWebView*、block。
        class_addMethod(
            class,
            sel!(_webViewDidRequestPointerLock:completionHandler:),
            imp,
            c"v@:@@?".as_ptr(),
        );

        // 功能：重新赋值同一个 delegate，让 WebKit 刷新方法表后识别到刚补上的回调；时间：2026-10-31；作者：lq。
        let _: () = msg_send![webview, setUIDelegate: delegate];
    }
}
