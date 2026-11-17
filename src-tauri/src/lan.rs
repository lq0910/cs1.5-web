// 功能：桌面客户端管理内置权威房间进程，支持创建、状态查询、关闭和退出清理；时间：2026-11-17；作者：lq。
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::Manager;

// 功能：仅向前端返回房间公开配置，不暴露运行时或私有地图文件路径；时间：2026-11-17；作者：lq。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomInfo {
    map: String,
    port: u16,
    addresses: Vec<String>,
    ct_size: u8,
    t_size: u8,
    skill: f64,
    critters: bool,
}

// 功能：限制前端可传入的房间参数，BSP 仅保存在本应用私有目录；时间：2026-11-17；作者：lq。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomOptions {
    map: String,
    port: u16,
    ct_size: u8,
    t_size: u8,
    skill: f64,
    critters: bool,
    map_bytes: Option<Vec<u8>>,
}

// 功能：持有 Child 确保停止时回收进程，避免僵尸进程与端口遗留；时间：2026-11-17；作者：lq。
struct HostedRoom {
    child: Child,
    info: RoomInfo,
}
impl Drop for HostedRoom {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// 功能：互斥保护同一客户端只能启动一个房间，并让后台启动任务与退出清理共享所有权；时间：2026-11-17；作者：lq。
#[derive(Clone, Default)]
pub struct LanHost(Arc<Mutex<Option<HostedRoom>>>);

impl LanHost {
    pub fn stop(&self) -> Result<(), String> {
        self.0.lock().map_err(|_| "房间状态不可用".to_string())?.take();
        Ok(())
    }
}

// 功能：校验地图白名单和人数、端口，阻止路径穿越或无效配置进入子进程；时间：2026-11-17；作者：lq。
fn validate(options: &RoomOptions) -> Result<(), String> {
    if !["moonbase", "white_house", "de_dust2", "cs_assault", "fy_iceworld"].contains(&options.map.as_str()) {
        return Err("不支持的地图".into());
    }
    if options.port < 1024 || !(1..=6).contains(&options.ct_size)
        || !(1..=6).contains(&options.t_size) || !options.skill.is_finite()
        || !(0.0..=1.0).contains(&options.skill)
    {
        return Err("房间端口或对局配置无效".into());
    }
    if options.map != "moonbase" && options.map != "white_house" {
        let bytes = options.map_bytes.as_ref().ok_or("请先导入房间地图素材")?;
        if bytes.len() < 124 || bytes.len() > 64 * 1024 * 1024 || bytes[..4] != [30, 0, 0, 0] {
            return Err("地图不是有效的 CS BSP 文件".into());
        }
    }
    Ok(())
}

// 功能：用打包运行时启动服务并等待监听成功，失败时终止进程并返回具体原因；时间：2026-11-17；作者：lq。
fn start_room(host: LanHost, resources: PathBuf, data: PathBuf, options: RoomOptions) -> Result<RoomInfo, String> {
    validate(&options)?;
    let mut state = host.0.lock().map_err(|_| "房间状态不可用".to_string())?;
    if let Some(room) = state.as_mut() {
        if room.child.try_wait().map_err(|error| error.to_string())?.is_none() {
            return Err("当前房间正在运行，请先关闭房间再创建".into());
        }
        state.take();
    }
    if let Some(bytes) = &options.map_bytes {
        let maps = data.join("public/cstrike/maps");
        fs::create_dir_all(&maps).map_err(|error| format!("无法保存地图：{error}"))?;
        fs::write(maps.join(format!("{}.bsp", options.map)), bytes)
            .map_err(|error| format!("无法保存地图：{error}"))?;
    }
    let runtime = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(runtime);
    command.arg(resources.join("server.mjs"))
        .args(["--map", &options.map, "--port", &options.port.to_string()])
        .arg("--root").arg(data)
        .args(["--ctsize", &options.ct_size.to_string(), "--tsize", &options.t_size.to_string(),
            "--skill", &options.skill.to_string(), "--critters", if options.critters { "1" } else { "0" },
            "--parent-pid", &std::process::id().to_string()])
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // 功能：Windows 后台开房不弹出命令行窗口；时间：2026-11-17；作者：lq。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|error| format!("内置房间服务启动失败：{error}"))?;
    let stdout = child.stdout.take().ok_or("房间输出不可用")?;
    let stderr = child.stderr.take().ok_or("房间错误输出不可用")?;
    let errors = Arc::new(Mutex::new(String::new()));
    let captured_errors = errors.clone();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = BufReader::new(stderr).take(16 * 1024).read_to_string(&mut text);
        if let Ok(mut output) = captured_errors.lock() { *output = text; }
    });
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("CS15_LAN_READY ") {
                let _ = sender.send(serde_json::from_str::<RoomInfo>(json).map_err(|error| error.to_string()));
            }
        }
    });
    match receiver.recv_timeout(Duration::from_secs(45)) {
        Ok(Ok(info)) => {
            *state = Some(HostedRoom { child, info: info.clone() });
            Ok(info)
        }
        result => {
            let _ = child.kill();
            let _ = child.wait();
            // 功能：等待错误输出完整落入缓冲，确保端口冲突不因读取时序丢失；时间：2026-11-17；作者：lq。
            let _ = stderr_reader.join();
            let detail = errors.lock().map(|text| text.trim().to_string()).unwrap_or_default();
            Err(if detail.contains("EADDRINUSE") { "房间端口已被占用，请更换端口后重试".into() }
                else if !detail.is_empty() { format!("创建房间失败：{detail}") }
                else { format!("房间未能启动，请检查地图或重试：{result:?}") })
        }
    }
}

// 功能：耗时导航图构建放到后台线程，创建过程中客户端界面保持响应；时间：2026-11-17；作者：lq。
#[tauri::command]
pub async fn lan_host_start(app: tauri::AppHandle, state: tauri::State<'_, LanHost>, options: RoomOptions) -> Result<RoomInfo, String> {
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?.join("lan-host");
    let data = app.path().app_local_data_dir().map_err(|error| error.to_string())?.join("lan-host");
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start_room(host, resources, data, options))
        .await.map_err(|error| error.to_string())?
}

// 功能：刷新或返回主菜单后仍能查询客户端持有的房间，已退出进程不误报运行；时间：2026-11-17；作者：lq。
#[tauri::command]
pub fn lan_host_status(state: tauri::State<'_, LanHost>) -> Result<Option<RoomInfo>, String> {
    let mut room = state.0.lock().map_err(|_| "房间状态不可用".to_string())?;
    if let Some(current) = room.as_mut() {
        if current.child.try_wait().map_err(|error| error.to_string())?.is_some() { room.take(); }
    }
    Ok(room.as_ref().map(|current| current.info.clone()))
}

// 功能：房主主动关闭房间时释放子进程与端口；时间：2026-11-17；作者：lq。
#[tauri::command]
pub async fn lan_host_stop(state: tauri::State<'_, LanHost>) -> Result<(), String> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.stop()).await.map_err(|error| error.to_string())?
}

// 功能：对原生边界做配置校验，防止未经检查的地图路径或 BSP 进入本地文件系统；时间：2026-11-17；作者：lq。
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_room_options() {
        let mut options = RoomOptions { map: "moonbase".into(), port: 3001, ct_size: 5, t_size: 5, skill: 0.45, critters: true, map_bytes: None };
        assert!(validate(&options).is_ok());
        options.map = "../../bad".into();
        assert!(validate(&options).is_err());
        options.map = "de_dust2".into();
        assert!(validate(&options).is_err());
        options.map_bytes = Some(vec![0; 124]);
        assert!(validate(&options).is_err());
        options.map_bytes.as_mut().unwrap()[0] = 30;
        assert!(validate(&options).is_ok());
        options.port = 80;
        assert!(validate(&options).is_err());
    }

    // 功能：通过真实打包 Node 验证创建、重复创建拒绝、关闭释放端口和端口冲突；时间：2026-11-17；作者：lq。
    #[test]
    fn bundled_host_lifecycle() {
        use std::net::TcpListener;
        let resources = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/lan-host");
        assert!(resources.join("server.mjs").is_file(), "先运行 pnpm desktop:prepare");
        let available = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = available.local_addr().unwrap().port();
        drop(available);
        let options = || RoomOptions { map: "moonbase".into(), port, ct_size: 2, t_size: 3, skill: 0.75, critters: false, map_bytes: None };
        let host = LanHost::default();
        let data = std::env::temp_dir().join(format!("cs15-lan-test-{}", std::process::id()));
        for _ in 0..2 {
            let info = start_room(host.clone(), resources.clone(), data.clone(), options()).unwrap();
            assert_eq!((info.ct_size, info.t_size, info.port), (2, 3, port));
            assert_eq!(info.skill, 0.75);
            assert!(!info.critters);
            assert!(start_room(host.clone(), resources.clone(), data.clone(), options()).unwrap_err().contains("正在运行"));
            host.stop().unwrap();
            assert!(TcpListener::bind(("0.0.0.0", port)).is_ok());
        }
        let occupied = TcpListener::bind(("0.0.0.0", port)).unwrap();
        let error = start_room(host.clone(), resources, data, options()).unwrap_err();
        assert!(error.contains("占用"), "{error}");
        assert!(host.0.lock().unwrap().is_none());
        drop(occupied);
    }
}
