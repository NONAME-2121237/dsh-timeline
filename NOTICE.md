# NOTICE — 开源声明 / Open Source Attribution

## 项目来源 / Provenance

**dsh-timeline** (formerly **dsh-history**) is an independent, maintained
successor of the fork of the upstream open-source project
[dsh-history](https://github.com/chenproton/dsh-history) by **chenproton**,
a DSH web plugin that lists, searches and jumps to the user-sent messages of
a long conversation.

dsh-timeline（原名 dsh-history）源自 chenproton 的开源项目 dsh-history 的
fork，是一个独立的后续维护版本。

## 复用代码声明 / Reused code

The baseline of this codebase — the host half (`src/index.ts`), the
client-side materialized-list helpers (`src/client/util.ts`),
`package.json`, `dsh.plugin.json`, `cordis.patch.yml`, `tsdown.config.ts`,
the restart script (`restart-dsh-web.sh`) and the release workflow — is
derived from the upstream project **chenproton/dsh-history** and is licensed
under the **MIT License**, copyright (c) 2025 **chenproton**. See
`LICENSE-MIT` for the full text, which must stay attached to these portions:
- preserve `LICENSE-MIT` in any redistribution;
- keep the upstream copyright notice in substantial copies.

本代码库的主体基线——host 端（src/index.ts）、客户端工具函数
（src/client/util.ts）、package.json、dsh.plugin.json、cordis.patch.yml、
tsdown.config.ts、重启脚本（restart-dsh-web.sh）与发布工作流——衍生自上游
项目 chenproton/dsh-history，依据 **MIT 许可**授权，版权 (c) 2025
chenproton。完整文本见 LICENSE-MIT；再分发时必须保留该文件，并在实质副本
中保留上游版权声明。

## 新增与修改内容 / Modifications

All additional development after the fork — the interaction-timeline rail
(`src/client/index.ts`), the host-side `/history/api/list-turns` turn-aggregation
endpoint, click-jump with `loadOlder` chasing, keyboard ↑/↓ recall, the
dual-channel (bundle / registry) distribution plumbing, and this documentation
set — is authored by **NONAME-2121237** and is licensed under the custom
**dsh-timeline Open Source License v1.0** in `LICENSE` (permissive,
non-commercial; commercial use requires the author's written authorization).

fork 之后的所有新增开发——交互时间线轨道（src/client/index.ts）、host 端
/history/api/list-turns 轮次聚合接口、点击未加载轮次的 loadOlder 追逐、
键盘 ↑/↓ 回忆、双通道（bundle / registry）分发管线及本套文档——由
**NONAME-2121237** 编写，依据 LICENSE 中的定制 **dsh-timeline 开源许可协议
v1.0** 授权（宽松、禁止商用；商用须作者书面授权）。

## 许可划分 / License split

| Portion / 部分 | Copyright / 版权 | License / 许可 |
| --- | --- | --- |
| Baseline derived from upstream dsh-history | (c) 2025 chenproton | MIT (LICENSE-MIT) |
| Code added after the fork | (c) 2026 NONAME-2121237 | dsh-timeline Open License v1.0 (LICENSE) |

Conflicts: the non-commercial restriction applies to the whole distribution.
Where the MIT license of the baseline and this notice conflict, the stricter
terms of the respective part govern that part.

当两者规定不一致时，各自部分以更严格的条款为准（基线部分保留 MIT 许可，
新增部分适用本定制许可）。

## Git history

The repository retains the complete original upstream history (commits
authored before and on the fork are preserved verbatim, including
chenproton's original commits), so provenance is traceable even after the
project was detached from its fork relation.

仓库保留了完整的原始上游历史（fork 之前的提交原样保留，包括 chenproton
的原始提交），项目脱离 fork 关系后来源依然可追溯。
