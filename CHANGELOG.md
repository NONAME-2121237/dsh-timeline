# Changelog / 更新记录

本仓库所有显著变更。`v0.1.24` 及更早是 fork 时代的版本，记录见上游
[chenproton/dsh-history](https://github.com/chenproton/dsh-history)。

All notable changes to this repository. Versions `v0.1.24` and earlier
belong to the fork era — see the upstream
[chenproton/dsh-history](https://github.com/chenproton/dsh-history) repo.

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本。

---

## [0.2.1] - 2026-08-24

### 新增 / Added

- **缓存加固（host 端，`src/index.ts`）**
  - 磁盘缓存条目携带 **sha256 校验和**（`{ at, data, sum }`）；读取时校验，损坏 / 篡改 / 截断 / 旧格式一律识别为未命中：删除坏文件并走首次生成重建，永不返回坏数据。
  - 写入改为 **write-verify-swap**：新内容先落 `.tmp-` 临时文件 → 回读校验和验算 → 通过后才原子 rename 覆盖当前缓存。进程在任意时刻中断（含写盘中间被杀），当前缓存要么是完整旧版、要么是完整新版；最坏留下一个无害的 `.tmp-*` 残留，启动预热阶段自动清扫。
  - **启动预热**：插件挂载后静默扫描 `~/.dsh/sessions`（目录名即真实 sessionId，兼容裸 uuid 与 `session-` 前缀两种格式），为没有磁盘缓存的会话逐个生成（500ms 节流，上限 300），数据先备好、点开即秒出。
- **后台渐进刷新（不信任实时阻塞）**
  - 请求路径固定为：内存新鲜缓存（3s TTL）→ 磁盘缓存（毫秒级）→ 仅首访实时读取并落盘。
  - 磁盘命中后不实时读：真实数据由单飞后台任务按门限刷新并回写盘 + 内存。
  - 刷新门限：该会话**连续停留 ≥5s**（快速切换会话不触发任何磁盘刷新）+ 距上次真实数据 **≥15s** + 无在途任务。
- **tooltip 主题跟随**
  - tooltip 及其内部要素（序号 / 时间 / 小标签 / 正文 / 元信息）全部改用宿主主题语义变量：`--dsw-alias-bg-layer-1`（浮层表面）、`--dsw-alias-border-l1`（边框）、`--dsw-alias-label-primary / secondary / tertiary`（正文与次级文字）。
  - 删除旧的 `html[data-ds-dark-theme="dark"]` 暗色特判；手动切主题、跟随系统自动黑暗、第三方皮肤（Catppuccin 等）即时跟随、全程零 JS 干预，与页面其余部分同源。

### 修复 / Fixed

- 停留刷新门限逻辑修正：第一版仅记录"停留起点"，`now - start > 5s` 会把正在停留的会话误判为"离开后回来"而重置停留窗口，导致 5s 整点该触发的刷新被吞掉。改为记录 `since + last`（距上次请求超过 5s 才开启新一轮停留段）。
- 旧格式缓存（无校验和）在升级到 0.2.1 后由预热自动识别重建，避免首访重复回退。

### 验证 / Verified

- 磁盘命中响应实测 **1.2~4ms**（此前慢路径 200~5000ms）。
- 损坏应对：人为截断缓存文件后请求返回 200，自动重建带校验和新文件（6303 字节）。
- 停留门限：连续停留 2s 时缓存 mtime 不变，6.5s 时后台刷新写回（mtime 更新）。
- tmp 残留：伪造 `.tmp-*` 后重启，启动清扫确认移除。
- 压测 A（12 会话冷启动，all-done 即切）：全部达到"线条渲染 + 蓝线居中高亮"≤977ms；三个原 3~6s 的大会话（本机代理 3.37s / 高效安全工具 3.24s / 开发Android 12打印机 5.38s）收敛到 286~455ms，零失败。
- 主题跟随：深色（跟随系统）下 tooltip 深色毛玻璃；切换浅色后即时变浅色浮层；测试后已还原用户设置。

---

## [0.2.0] - 2026-08-24

### 新增 / Added

- **独立项目化**：脱离 fork 关系，项目更名为 **dsh-timeline**，新仓库 [NONAME-2121237/dsh-timeline](https://github.com/NONAME-2121237/dsh-timeline)；git 历史完整保留（含上游原始提交），来源可追溯。
- **许可变更**：定制开源许可 **dsh-timeline Open Source License v1.0**（条款宽松、**禁止商用**，商用须作者书面授权）；上游基线保留 MIT（LICENSE-MIT）；来源与许可划分声明（NOTICE.md）。
- **首载骨架**：会话切换后轨道立即显示呼吸式占位刻度（数据到达前不再整轨空白）；首载轮询 1s，拿到数据后降为 3s。
- **悬停延长曲线**：光标水平距离驱动（中点锚定：≤20px 满长、30px 截止、正切式增长）+ 陡峭抛物线衰减 `(1-d/r)²`。
- README 全面重写（安装 / 迁移 / 开发 / FAQ / 许可），新增英文版同步；更新记录并入 CHANGELOG。

### 修复 / Fixed

- 点击跳转落地行闪烁依赖的 `dshm-flash` 类无对应样式（旧面板样式移除后成为死代码）——补回消息行脉冲高亮动画。

### 其它 / Other

- 旧 fork 仓库 `NONAME-2121237/dsh-history` 保留未删（如需清理可自行 archive/删除）。

---

## [0.1.24] - 2026-08-24（fork 时代，历史）

- 跳转对齐：用户消息上缘贴视口顶，快速滚动而非瞬跳。
- 修复：点击未加载轮次持续翻页直至目标轮次入窗（loadOlder 追逐）。
- 更早版本见 [chenproton/dsh-history](https://github.com/chenproton/dsh-history)。

---

## 链接 / Links

- 仓库：<https://github.com/NONAME-2121237/dsh-timeline>
- 上游基线（MIT，版权 chenproton）：<https://github.com/chenproton/dsh-history>
- 许可：见 [LICENSE](LICENSE)（项目）与 [LICENSE-MIT](LICENSE-MIT)（上游基线）；开源声明见 [NOTICE.md](NOTICE.md)
