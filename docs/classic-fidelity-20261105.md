# 2026-11-05 经典视图与效果修复

作者：lq。修改基于 main / c952402，工作区起始无代码改动。本轮版本更新为 0.1.1，同步 package.json、Tauri 配置和 Cargo 清单/锁文件；未构建桌面安装包。

## 参考范围

优先采用本地 CS 1.5 的 v_*.mdl 原始几何、动作、帧数与 fps。公开参考包括：

- [Valve SDK view.cpp](https://github.com/ValveSoftware/halflife/blob/master/cl_dll/view.cpp)：V_CalcBob、V_CalcNormalRefdef、V_DropPunchAngle。
- [Valve SDK vgui_ScorePanel.cpp](https://github.com/ValveSoftware/halflife/blob/master/cl_dll/vgui_ScorePanel.cpp)：透明面板、共享表列、队伍分组和排序结构。此文件属于 Half-Life SDK，不能作为 CS 1.5 专有 UI 的像素基准。
- [ReGameDLL_CS weapons.cpp](https://github.com/rehlds/ReGameDLL_CS/blob/master/regamedll/dlls/weapons.cpp)：KickBack、DefaultDeploy、爆炸精灵资源注册。
- [ReGameDLL_CS wpn_shared](https://github.com/rehlds/ReGameDLL_CS/tree/master/regamedll/dlls/wpn_shared)：各枪站立、移动、蹲伏、空中 KickBack 参数及独立冲量。
- [ReGameDLL_CS ggrenade.cpp](https://github.com/rehlds/ReGameDLL_CS/blob/master/regamedll/dlls/ggrenade.cpp)：Explode3 两团 30fps 火球、0.55 秒后 Smoke3_C 的 5fps 烟雾。
- [Xash3D gamma.c](https://github.com/FWGS/xash3d-fwgs/blob/master/engine/client/gamma.c)：GoldSrc 兼容引擎的 BuildGammaTable 暗部拐点。客户端选用 gamma=2.2、lightgamma=2.5、brightness=1，不代表某一台原版客户端的配置。
- 当前 three 0.186.1 自带 ShaderLib/meshbasic.glsl.js：光照图结果自带 RECIPROCAL_PI，需要补偿 π。

以上公开源码读取于 2026-11-05。ReGameDLL 基于后期 CS，并非 CS 1.5 完整原始源码；此轮没有可运行的 CS 1.5 客户端截图基准，不能宣称逐像素、逐帧完全一致。

## 七项修改

1. 地图：修正基础材质额外的 1/π 衰减；以 sRGB 光照调制和 brightness 暗部拐点保留明暗层次；双线性采样光照，保留 lm/lmi 校准参数。
2. 持枪姿态：v_ 模型不再按包围盒居中，不再额外放大 1.2 倍或叠加枪种经验位移；水平 90° 投影和更近的裁剪面保留原版手臂根部。
3. 切枪：播放本地 draw/deploy 并按 MDL fps 推进；异步模型到达后从首帧起播。开火锁定默认 0.75 秒，AWP 1.45 秒、Scout 1.25 秒，与完整动画时长分别处理。
4. 开火：每次射击重启动作，正确兼容 Glock shoot、双枪左右手和 M3 泵动；取消固定 0.12 秒压缩。插值相邻骨骼帧，取消父节点重复后坐。战斗后坐使用姿态分支、连发增长、随机横向换向及 SDK 幅度回正。换弹取消原有 0.82 倍加速。
5. 行走：周期 0.8、cl_bob 0.01、bobup 0.5 的 SDK 公式保留为基线；按用户反馈将武器相对位移和转角缩小到 35%，使用 80ms 时间常数平滑速度响应，减轻起停和固定模拟步长的跳变。该摆幅是用户要求的稳定性调整，不宣称等同原版默认值。
6. Tab：统一 Player / Score / Deaths / Latency 表列，T 红、CT 蓝；队伍人数与比分、Dead、BOT、当地玩家行高亮；按住显示、松开关闭。
7. 手雷：独立爆炸管理器保留火球、延迟烟尘与尾段消散，射击灰尘池不会覆盖烟团；烟雾弹分批喷烟，回退素材约 18 秒。拔销和投出时长分别对齐本地模型 40/41 秒与 16/30 秒。

## 素材与验证边界

SPR 解析支持 IDSP v2 单帧序列的调色板、加色、索引透明与掩码；分组精灵安全回退。实际读取文件：

- cstrike/sprites/fexplo.spr
- cstrike/sprites/eexplo.spr
- cstrike/sprites/steam1.spr

已从 `/Users/liqiang/Downloads/CS1.5纯净版.zip` 内嵌的完整游戏包只读提取这三个文件到本地 `public/cstrike/sprites/`；CRC 校验分别为 `fexplo 0x4f1b5344`、`eexplo 0x0766034b`、`steam1 0xb4f15feb`。该目录按项目规则保持本地忽略，不把整包或 DLL 放入代码仓库。

## BOT 还原边界与本轮改进

原版压缩包未发现 PodBot、RealBot、YAPB、`.pwf` 路点或可移植 BOT 源码；`cstrike/dlls/mp.dll` 是 Windows 原生游戏 DLL，不能在浏览器中直接加载执行。因此继续使用项目自己的 TypeScript BOT，并以原版行为规则复现：导航使用真实 BSP 碰撞和 A*，任务分配保持持包、守包、拆包角色，远距离执行任务自动跑刀，发现敌人切回主武器，视线和瞄准点改为胸口中心。

新增回归用例覆盖跑刀/接敌换枪以及胸口瞄准；这类逻辑改进可以移植到 Web 仿真，原版 DLL 内部实现和专有路点数据不能直接提取。

## 开镜与回合反馈修正

- 已从用户原包提取 `sniper_scope.spr` 到本地忽略目录，确认四款狙击枪的原版 `weapon_*.txt` 在 640 档均引用该精灵。运行时直接解码原版 256×256 刻度和中心红点，不将其转换素材提交到仓库。
- 镜外纯黑、镜内透明，镜口直径按视口短边保持正圆，取消旧 CSS 的 27%–33% 大范围渐暗。只有狙击枪显示该遮罩。
- 放大视野按已有 ReGameDLL 参考区分：AWP 40°/10°，Scout/G3SG1/SG550 40°/15°，AUG/SG552 单档 55°，退出恢复 90°。AUG/SG552 放大时保留枪身与普通准星；连狙和带镜步枪射击不再被强制退镜。参考代码不是 CS 1.5 完整客户端，仍需原客户端并排验收。
- 按用户要求默认热身和冻结时间均为零，首局和后续回合直接进入实战且可购买；这是服务器配置选择，不代表所有原版服务器默认没有冻结时间。显式配置冻结时间仍有效。
- 五秒结算阶段保留存活玩家移动、跳跃与换弹，阵亡者继续观战；沿用原有禁止结算阶段攻击规则，回合积分不会重复结算。

## 验证记录

- 最终 `npm test` 165/165 通过；`npm run build`（含 TypeScript 检查）通过；`git diff --check` 通过。构建保留现有大 chunk 提示。
- Node 回归覆盖：原点与视野、draw 中间网格、M3 击发泵动、重复射击重启、半帧插值、punch 抵消、bob、姿态后坐、SPR 透明度和越界、HE 阶段、光照 π 补偿、对局与投掷物理。
- Playwright：真实 Dust2 购买 M3、查看手臂与枪械；真实锁定鼠标后投掷 HE，截图捕获火球与约 3 秒后的烟尘；Tab 按住/松开断言通过。
- 浏览器生命周期断言：HE 两团火球→延迟烟雾→3 秒仍可见→到期回收；烟雾弹 10 秒仍可见→20 秒清理，均通过。
- 画面记录在 output/playwright/：m3-brightness.png、scoreboard.png、he-fire.png、he-smoke.png、he-late-smoke.png。
- 追加 Playwright 验收通过：开局无准备读秒且按 W 有位移，B44 实际购买 AWP，实际世界相机依次为 40°/10°/90°；原版 SPR 已加载、中心像素为红点、镜外不透明且镜内透明；AUG 实际相机 55°/90°、无圆形遮罩且普通准星可见。宽屏、正方形、竖屏和 Retina 画布的圆形边界断言通过。
- 新截图：awp-scope-first.png、awp-scope-second.png、aug-zoom.png；跑动稳定性覆盖 30/60/144fps、停步平滑、暂停和空中保持；回合结算移动、跳跃、计分一次及无冻结换局通过真实模拟循环测试。
- 尚未在 macOS Tauri 壳、Windows 或 CS 1.5 原客户端中完成并排验收。
