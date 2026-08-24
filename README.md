# dsh-timeline

DSH Web 插件：超长会话的**交互时间线**——消息区右缘一列细刻度线，每根线代表你发的一条消息（一个交互轮次），悬停预览、点击跳转、滚轮浏览，配合键盘 ↑/↓ 快速回忆自己说过的话。

[English](README.en.md) | 中文

---

## 功能

- **完整轮次视图**：列出当前会话全部交互轮次（含未被加载进对话窗口的旧轮次、被 compaction 覆盖的历史），最新在底、正序排列。
- **时间线轨道**：消息区右缘竖向紧凑刻度条（约 10 根可见），当前位置的轮次蓝色高亮；滚轮悬停轨道上下滑动浏览整条时间线，移开鼠标自动回弹到当前轮次。
- **悬停预览**：tooltip 显示该轮次序号、时间、用户消息（200 字截断）、Agent 回复（200 字截断）与附件/工具调用数。
- **点击跳转**：点击任意刻度线 → 自动滚动定位到该轮用户消息并闪烁高亮；若目标轮次尚未加载，自动逐页加载更早历史并继续定位（含安全上限）。
- **键盘回忆**：输入框内按 ↑/↓ 环回你最近发送的消息，方便复述或纠错。
- **自动跟随**：对话滚动时高亮自动跟随视口中心最近的轮次；切换会话后自动复位并重新检测。

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行）。本插件目前通过 GitHub 或 npm 分发（发布到 npm 需作者先执行一次 npm 端 Trusted Publisher 配置，见 `.github/workflows/release.yml`）。

### 从 GitHub 直接安装（推荐）

```bash
dsh plugin --profile web add github:NONAME-2121237/dsh-timeline#main
```

装完后运行随包自带的一键重启脚本：

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```

此方式直接使用仓库已提交的构建产物（`lib/` 已随仓库提交），无需本地构建。

### 从 npm 安装

```bash
dsh plugin --profile web add dsh-timeline@latest
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```

### 从 plugin-registry 安装

> 前置：DSH 已集成 plugin-registry（`dsh registry` 命令可用）。同时启用两个通道会双挂载（Node 半挂两次、页面两个面板）。

```bash
git clone https://github.com/NONAME-2121237/dsh-timeline.git && cd dsh-timeline
pnpm install && pnpm build
node scripts/package-registry.mjs      # 组装 registry/ 暂存（含清单 + 产物 + 文档，不入库）
dsh registry install ./registry        # 安装（默认禁用）
dsh registry enable dsh-external/dsh-timeline
bash restart-dsh-web.sh                # 自动重启生效
```

### 从旧版 dsh-history 迁移

如果你之前装过 `dsh-history`（本项目的旧名），请**先移除旧插件再安装**，避免同时挂载两个客户端面板：

```bash
dsh plugin --profile web remove dsh-history   # 或按你此前所用的通道移除
bash ~/.dsh/profiles/web/node_modules/dsh-history/restart-dsh-web.sh
# 然后按上方任一方式安装 dsh-timeline
```

## 缓存与性能

- host 端按会话把轮次/消息列表持久化到 `~/.dsh/timeline-cache/`。
- 请求顺序：内存新鲜缓存（3s）→ 磁盘缓存（毫秒级）→ 首次访问才生成一次（写盘）。
- 启动时后台预热：扫描 `~/.dsh/sessions`，为还没有缓存的会话逐个生成（500ms 节流），点开即秒出。
- 缓存命中后不实时读取：真实数据由后台任务渐进刷新，先展示、再校准，新消息约 15s 内出现。
- **健壮性（v0.2.1）**：
  - 写入采用"写全 → 回读校验 → 原子替换"：新内容先落临时文件并验证 sha256 校验和，通过后才覆盖当前缓存；进程中途停止最多留下无害的 `.tmp-*` 残留（启动时自动清扫），当前缓存绝不半写。
  - 缓存文件带校验和（`at + data + sum`）；读取时校验，损坏/篡改/截断/旧格式一律识别并删除重建，永不返回坏数据。
  - 后台刷新受门限约束：会话连续停留 ≥5s 且距上次真实数据 ≥15s 才刷新（快速切换会话不折腾磁盘），单飞防并发。

## 使用

- 进入会话后，消息区右缘自动出现时间线轨道，无需手动打开。
- **滚动**：鼠标悬停轨道，滚动滚轮连续浏览时间线；移开后自动回到当前轮次。
- **点击**：跳到对应轮次的用户消息。
- **悬停**：查看该轮次的用户消息/回复/工具数预览。
- **键盘**：焦点在输入框时按 ↑/↓ 回忆最近发送的消息。

## 🧑‍💻 开发

```bash
git clone https://github.com/NONAME-2121237/dsh-timeline.git
cd dsh-timeline
pnpm install
pnpm typecheck && pnpm build     # lib/ 产物需提交（GitHub 安装通道依赖它）
```

接入本地调试（把 profile 依赖指向本地克隆）：

```bash
# 编辑 ~/.dsh/profiles/web/package.json 的 dependencies：
#   "dsh-timeline": "link:<克隆目录绝对路径>"
cd ~/.dsh/profiles/web && pnpm install
bash <克隆目录>/restart-dsh-web.sh
```

## 📄 许可与声明

- 本项目采用定制开源许可 **dsh-timeline Open Source License v1.0**（见 [LICENSE](LICENSE)）：**条款宽松，但禁止商业用途**；商用须取得作者书面授权。
- 本项目源自上游开源项目 [chenproton/dsh-history](https://github.com/chenproton/dsh-history)（MIT 许可，版权 (c) 2025 chenproton）。基线代码保留 MIT 授权（见 [LICENSE-MIT](LICENSE-MIT)），fork 后新增代码按上述定制许可授权，完整声明见 [NOTICE.md](NOTICE.md)。
- 仓库保留了完整的原始上游提交历史，来源可追溯。

## 常见问题

<details>
<summary><b>如何更新插件？</b></summary>

```bash
dsh plugin --profile web update dsh-timeline
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
```

GitHub 安装通道下：`dsh plugin --profile web add github:NONAME-2121237/dsh-timeline#main` 后同样运行重启脚本。

</details>

<details>
<summary><b>安装时出现 "✕ missing peer" 警告？</b></summary>

可安全忽略。DSH 运行时通过自身 module table 提供 `@deepseek-ai/*` 与 react 等依赖，无需在 profile 中重复安装（官方插件同样如此）。

</details>

<details>
<summary><b>装完看不到时间线？</b></summary>

1. 确认重启过服务（运行 `restart-dsh-web.sh`）或硬刷新浏览器（Cmd/Ctrl+Shift+R）；
2. 确认插件已加入 bundle：`cat ~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 应含 `dsh-timeline`；
3. 会话中至少发过一条消息才会出现轨道（无轮次时隐藏）；
4. 仍不行，把 `dsh plugin --profile web list` 的输出贴到 issue 反馈。

</details>

<details>
<summary><b>restart-dsh-web.sh 是什么？报 "No such file or directory"？</b></summary>

它是随插件分发的**一键重启脚本**：自动探测部署方式并重启 DSH Web 让插件生效——

- 本机由 **systemd** 管理（`dsh-web.service`）→ 自动走 `systemctl restart`（干净单实例，含残留进程清理与 HTTP 健康检查）；
- 否则自动发现运行中的 `dsh web` 进程，读取原始启动参数原样重启（nohup）；
- 找不到进程时直接用 `dsh web` 启动。

报 `No such file or directory` 是脚本不在当前 shell 目录——请用完整路径：

```bash
bash ~/.dsh/profiles/web/node_modules/dsh-timeline/restart-dsh-web.sh
# 或未装包时从仓库下载
curl -O https://raw.githubusercontent.com/NONAME-2121237/dsh-timeline/main/restart-dsh-web.sh
bash restart-dsh-web.sh
```

参数：`-n` 预览将执行的命令（dry-run）、`-p PID` 指定进程、`-l 文件` 指定日志（默认 `/tmp/dsh-web.log`，或环境变量 `DSH_WEB_LOG`）。

</details>

## 更新记录

完整版本变更见 [CHANGELOG.md](CHANGELOG.md)。

### v0.2.1

- **缓存加固**：缓存文件带 sha256 校验和；写入改为"写全 → 回读校验 → 原子替换"，进程中途停止不会写坏当前缓存；损坏/篡改/截断/旧格式自动识别并重建；启动时清扫 `.tmp-*` 残留。
- **刷新门限**：后台真实数据刷新需该会话连续停留 ≥5s 且距上次刷新 ≥15s（快速切换不折腾磁盘），单飞防并发。
- **主题跟随**：tooltip 与整个时间线面板的配色全部接入宿主 `--dsw-alias-*` 主题变量，手动切主题 / 跟随系统 / 第三方皮肤即时跟随、与页面其余部分同源（删除旧的暗色属性特判）。
- 实测（压测 A 全量）：缓存版 12 会话点击到"线条渲染 + 蓝线居中高亮"全部 ≤1s（三个原 3~6s 的大会话收敛到 286~455ms），零失败。

### v0.2.0

- **独立项目化**：脱离 fork 关系，项目更名为 **dsh-timeline**，新仓库 [NONAME-2121237/dsh-timeline](https://github.com/NONAME-2121237/dsh-timeline)。
- **许可变更**：采用定制开源许可（宽松、禁止商用），基线代码保留上游 MIT 授权；新增开源声明（LICENSE / LICENSE-MIT / NOTICE.md）。
- 文档全面重写，安装通道 / 更新 / 迁移说明更新。
- 修复：点击跳转的落地行闪烁此前依赖 `dshm-flash` 类却无对应样式（旧面板样式移除后成为死代码），已补回消息行脉冲高亮动画。

### v0.1.24（fork 版本，历史）

- 跳转对齐：用户消息上缘贴视口顶，快速滚动而非瞬跳。
- 修复：点击未加载轮次持续翻页直至目标轮次入窗（loadOlder 追逐）。

更早的版本记录见 [chenproton/dsh-history](https://github.com/chenproton/dsh-history) 仓库主页。

---

*面向 DSH 社区的开源插件。非商用自由使用；商用请先联系作者。*
